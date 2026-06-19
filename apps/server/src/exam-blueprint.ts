/**
 * exam-blueprint.ts — 阶段一：蓝图架构师
 *
 * 用 bindTools + ExamBlueprintSchema 强制结构化输出，
 * exam-structures 知识库作为约束边界注入 prompt（不覆盖）。
 */

import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { SystemMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { tool } from '@langchain/core/tools';
import type { ExamBlueprint, Difficulty } from '@boen/shared';
import { getExamStructure, type QuestionTypeConfig } from './exam-structures.js';
import { blueprintArchitectPrompt, subjectLabel, gradeLabel } from './exam-prompts.js';

// ── 蓝图 Zod Schema（绑定到 model.bindTools 做结构化输出） ──────

const blueprintKpSchema = z.object({
  id: z.number().optional().describe('知识点 ID（来自课程知识库）'),
  title: z.string().describe('知识点标题'),
  weight: z.number().min(0).max(1).describe('本 section 内权重 (0-1)'),
});

const blueprintQtSchema = z.object({
  type: z.enum(['multiple_choice', 'fill_blank', 'true_false', 'short_answer']).describe('题型'),
  count: z.number().int().min(1).describe('题目数量'),
  pointsPer: z.number().int().min(1).describe('每题分值'),
  focusKps: z.array(z.string()).default([]).describe('重点考查知识点'),
});

const blueprintSectionSchema = z.object({
  title: z.string().describe('板块标题，如"数与代数"'),
  knowledgePoints: z.array(blueprintKpSchema).min(1).describe('本板块涉及的知识点'),
  difficulty: z.enum(['easy', 'medium', 'hard']).describe('本板块难度倾向'),
  questionTypes: z.array(blueprintQtSchema).min(1).describe('本板块下的题型配比'),
});

const examBlueprintSchema = z.object({
  title: z.string().describe('试卷标题'),
  sections: z.array(blueprintSectionSchema).min(1).max(5).describe('试卷板块（2-4个）'),
  totalScore: z.number().int().describe('总分'),
  coveragePlan: z.object({
    must: z.array(z.string()).describe('必考知识点'),
    focus: z.array(z.string()).describe('重点考查'),
    stretch: z.array(z.string()).default([]).describe('拓展知识点'),
  }),
  difficultyDistribution: z.object({
    easy: z.number().min(0).max(1).describe('easy 占比'),
    medium: z.number().min(0).max(1).describe('medium 占比'),
    hard: z.number().min(0).max(1).describe('hard 占比'),
  }),
});

/** 蓝图设计 tool（仅作结构化输出契约，func 为空） */
const designBlueprintTool = tool(async () => '', {
  name: 'design_blueprint',
  description: '设计试卷蓝图。必须通过本工具输出结构化蓝图。',
  schema: examBlueprintSchema,
});

// ── 约束边界（从 exam-structures 知识库生成） ────────────────

/**
 * 构造约束边界文本，注入蓝图 prompt。
 * LLM 在此约束内自由设计，不再被 FIXED_POINTS 事后覆盖。
 */
export function buildConstraintBoundary(grade: string, mode: 'exam' | 'quiz', totalScore: number): string {
  const struct = getExamStructure(grade);
  const variant = mode === 'quiz' ? struct.quiz : struct.exam;

  const typeGuidance = variant.questionTypes.map(qt =>
    `  - ${qt.label}（${qt.type}）：标准 ${qt.count} 题 × ${qt.pointsPer} 分/题`).join('\n');

  return [
    `年级段：${struct.band}（${gradeLabel(grade)}）`,
    `模式：${mode === 'quiz' ? '随堂测验' : '正式考试'}`,
    `标准总分：${variant.totalScore} 分（目标总分：${totalScore} 分，可按比例调整题量）`,
    `建议时长：${variant.durationMinutes} 分钟`,
    `题型参考（标准配比，可按目标总分等比缩放）：`,
    typeGuidance,
    `难度比例参考：easy ${variant.difficultyRatio.easy}% / medium ${variant.difficultyRatio.medium}% / hard ${variant.difficultyRatio.hard}%`,
    variant.supportsPassageGrouping ? '支持分步设问（同一材料下多道小题）。' : '不支持分步设问。',
    `说明：${variant.description}`,
    '',
    '⚠ 你必须在上述约束边界内设计蓝图：',
    '- 题型种类和分值参考标准配比，可微调但不可大幅偏离',
    '- 难度分布参考标准比例，可微调',
    '- 各题型 pointsPer × count 之和必须等于目标总分',
    '- 选择题不超过 10 道',
  ].join('\n');
}

// ── 降级蓝图（LLM 失败时的兜底） ──────────────────────────

export function defaultBlueprint(config: { subject: string; grade: string; totalScore?: number }, mode: 'exam' | 'quiz' = 'exam'): ExamBlueprint {
  const totalScore = config.totalScore ?? 100;
  const struct = getExamStructure(config.grade);
  const variant = mode === 'quiz' ? struct.quiz : struct.exam;
  const ratio = totalScore / variant.totalScore;

  const questionTypes: QuestionTypeConfig[] = variant.questionTypes.map(qt => ({
    ...qt,
    count: Math.max(1, Math.round(qt.count * ratio)),
  }));

  return {
    title: `${subjectLabel(config.subject)}${gradeLabel(config.grade)}综合试卷`,
    sections: [{
      title: '综合',
      knowledgePoints: [{ title: '综合知识', weight: 1 }],
      difficulty: 'medium' as Difficulty,
      questionTypes: questionTypes.map(qt => ({
        type: qt.type as any,
        count: qt.count,
        pointsPer: qt.pointsPer,
        focusKps: [],
      })),
    }],
    totalScore: questionTypes.reduce((s, qt) => s + qt.count * qt.pointsPer, 0),
    coveragePlan: { must: [], focus: [] },
    difficultyDistribution: {
      easy: variant.difficultyRatio.easy / 100,
      medium: variant.difficultyRatio.medium / 100,
      hard: variant.difficultyRatio.hard / 100,
    },
  };
}

// ── 蓝图架构师主函数 ──────────────────────────────────────

export async function stepBlueprintArchitect(
  model: BaseChatModel,
  config: { subject: string; grade: string; totalScore?: number; notes?: string },
  weightGuide: string,
  profileContext: string,
  mode: 'exam' | 'quiz',
): Promise<ExamBlueprint> {
  const totalScore = config.totalScore ?? 100;
  const constraintBoundary = buildConstraintBoundary(config.grade, mode, totalScore);
  const prompt = blueprintArchitectPrompt(config, weightGuide, profileContext, constraintBoundary);

  try {
    // 尝试用 bindTools 做结构化输出
    if (model.bindTools) {
      const bound = model.bindTools([designBlueprintTool], {
        tool_choice: { type: 'function', function: { name: 'design_blueprint' } },
      } as any);
      const response = await bound.invoke([new SystemMessage(prompt)]);
      const toolCalls = (response as any)?.tool_calls ?? [];
      const blueprintCall = toolCalls.find((c: any) => c.name === 'design_blueprint');

      if (blueprintCall?.args) {
        const parsed = examBlueprintSchema.safeParse(blueprintCall.args);
        if (parsed.success) {
          return validateAndFixBlueprint(parsed.data, totalScore);
        }
        console.warn('[blueprint] schema 校验失败，尝试手动修复:', parsed.error.issues.slice(0, 3));
        // 尝试修复常见问题后重试
        const fixed = tryFixBlueprint(blueprintCall.args, totalScore);
        if (fixed) return fixed;
      }
    }

    // bindTools 不支持或失败 → 回退到纯文本 + JSON 解析
    console.warn('[blueprint] bindTools 不可用或失败，回退到文本模式');
    const response = await model.invoke([new SystemMessage(prompt + '\n\n请直接输出 JSON 格式的蓝图，不要有其他文字。')]);
    const content = typeof response.content === 'string' ? response.content : '';
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    const jsonStr = (jsonMatch ? jsonMatch[1].trim() : content.trim()).replace(/^[^{]*({[\s\S]*})[^}]*$/, '$1');
    const parsed = JSON.parse(jsonStr);
    return validateAndFixBlueprint(examBlueprintSchema.parse(parsed), totalScore);
  } catch (err) {
    console.error('[blueprint] 蓝图生成失败，使用默认蓝图:', err instanceof Error ? err.message.slice(0, 100) : err);
    return defaultBlueprint(config, mode);
  }
}

// ── 蓝图校验与修复 ─────────────────────────────────────────

/** 校验总分一致性，若不符则按比例调整 count */
function validateAndFixBlueprint(bp: ExamBlueprint, targetScore: number): ExamBlueprint {
  // 计算实际总分
  let actualScore = 0;
  for (const section of bp.sections) {
    for (const qt of section.questionTypes) {
      actualScore += qt.count * qt.pointsPer;
    }
  }

  // 总分偏差 < 5% → 可接受，更新 totalScore 字段
  if (Math.abs(actualScore - targetScore) / targetScore < 0.05) {
    return { ...bp, totalScore: actualScore };
  }

  // 偏差较大 → 按比例调整每个 section 的 count
  const ratio = targetScore / actualScore;
  console.warn(`[blueprint] 总分偏差较大（实际 ${actualScore} vs 目标 ${targetScore}），按比例 ${ratio.toFixed(2)} 调整题量`);

  const fixedSections = bp.sections.map(section => ({
    ...section,
    questionTypes: section.questionTypes.map(qt => ({
      ...qt,
      count: Math.max(1, Math.round(qt.count * ratio)),
    })),
  }));

  // 重新计算
  const newScore = fixedSections.reduce((s, sec) =>
    s + sec.questionTypes.reduce((ss, qt) => ss + qt.count * qt.pointsPer, 0), 0);

  return { ...bp, sections: fixedSections, totalScore: newScore };
}

/** 尝试修复常见的 schema 校验失败 */
function tryFixBlueprint(raw: any, targetScore: number): ExamBlueprint | null {
  try {
    // 补全缺失的 coveragePlan / difficultyDistribution
    if (!raw.coveragePlan) {
      const allKps = (raw.sections ?? []).flatMap((s: any) => (s.knowledgePoints ?? []).map((kp: any) => kp.title ?? kp));
      raw.coveragePlan = { must: allKps.slice(0, 3), focus: allKps.slice(0, 5), stretch: [] };
    }
    if (!raw.difficultyDistribution) {
      raw.difficultyDistribution = { easy: 0.4, medium: 0.4, hard: 0.2 };
    }
    // 确保 difficultyDistribution 三者之和 = 1
    const dd = raw.difficultyDistribution;
    const sum = (dd.easy ?? 0) + (dd.medium ?? 0) + (dd.hard ?? 0);
    if (sum > 0 && Math.abs(sum - 1) > 0.01) {
      dd.easy = dd.easy / sum;
      dd.medium = dd.medium / sum;
      dd.hard = dd.hard / sum;
    }
    const parsed = examBlueprintSchema.parse(raw);
    return validateAndFixBlueprint(parsed, targetScore);
  } catch {
    return null;
  }
}

// ── 蓝图展平（供阶段二出题使用） ────────────────────────────

/** 蓝图中的单个出题任务（section × questionType） */
export interface WriteTask {
  sectionTitle: string;
  sectionKnowledgePoints: Array<{ title: string; weight: number }>;
  questionType: string;
  questionTypeLabel: string;
  count: number;
  pointsPer: number;
  focusKps: string[];
  difficulty: Difficulty;
}

const TYPE_LABELS: Record<string, string> = {
  multiple_choice: '选择题', fill_blank: '填空题', true_false: '判断题', short_answer: '简答题',
};

/** 把蓝图展平为出题任务列表（每个任务 = 一个 section × questionType 组） */
export function flattenBlueprint(blueprint: ExamBlueprint): WriteTask[] {
  const tasks: WriteTask[] = [];
  for (const section of blueprint.sections) {
    for (const qt of section.questionTypes) {
      tasks.push({
        sectionTitle: section.title,
        sectionKnowledgePoints: section.knowledgePoints.map(kp => ({ title: kp.title, weight: kp.weight })),
        questionType: qt.type,
        questionTypeLabel: TYPE_LABELS[qt.type] ?? qt.type,
        count: qt.count,
        pointsPer: qt.pointsPer,
        focusKps: qt.focusKps,
        difficulty: section.difficulty,
      });
    }
  }
  return tasks;
}
