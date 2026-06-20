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

const QUESTION_TYPE_ORDER: Record<string, number> = {
  multiple_choice: 0,
  true_false: 1,
  fill_blank: 2,
  short_answer: 3,
};

function sortQuestionTypes<T extends { type: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => (QUESTION_TYPE_ORDER[a.type] ?? 99) - (QUESTION_TYPE_ORDER[b.type] ?? 99));
}

function tuneCountsToTarget<T extends { type: string; count: number; pointsPer: number }>(items: T[], targetScore: number): number {
  if (!items.length) return 0;

  type State = { cost: number; counts: number[] };
  let dp = new Map<number, State>([[0, { cost: 0, counts: [] }]]);
  const maxScore = Math.max(targetScore * 2, targetScore + 120, 200);

  for (const item of items) {
    const next = new Map<number, State>();
    const maxCount = item.type === 'multiple_choice' ? 10 : 20;
    for (const [score, state] of dp.entries()) {
      for (let count = 1; count <= maxCount; count++) {
        const nextScore = score + count * item.pointsPer;
        if (nextScore > maxScore) continue;
        const cost = state.cost + Math.abs(count - item.count) * 10 + (count === item.count ? 0 : 1);
        const current = next.get(nextScore);
        if (!current || cost < current.cost) {
          next.set(nextScore, { cost, counts: [...state.counts, count] });
        }
      }
    }
    dp = next;

    // 提前终止：如果已有候选解偏差 < 2%，停止扩展后续题型，避免状态空间爆炸
    for (const [score] of dp.entries()) {
      if (Math.abs(score - targetScore) <= targetScore * 0.02) {
        // 找到足够精确的解，直接选取最接近的
        let earlyBest: State | undefined;
        let earlyBestScore = targetScore;
        for (const [s, st] of dp.entries()) {
          if (!earlyBest) { earlyBest = st; earlyBestScore = s; continue; }
          const curRank = Math.abs(s - targetScore) * 1000 + st.cost;
          const bestRank = Math.abs(earlyBestScore - targetScore) * 1000 + earlyBest.cost;
          if (curRank < bestRank) { earlyBest = st; earlyBestScore = s; }
        }
        if (earlyBest) {
          earlyBest.counts.forEach((count, idx) => { items[idx].count = count; });
          return items.reduce((sum, it) => sum + it.count * it.pointsPer, 0);
        }
      }
    }
  }

  let bestScore = targetScore;
  let best = dp.get(targetScore);
  if (!best) {
    for (const [score, state] of dp.entries()) {
      if (!best) {
        best = state;
        bestScore = score;
        continue;
      }
      const currentRank = Math.abs(score - targetScore) * 1000 + state.cost;
      const bestRank = Math.abs(bestScore - targetScore) * 1000 + best.cost;
      if (currentRank < bestRank) {
        best = state;
        bestScore = score;
      }
    }
  }

  if (best) {
    best.counts.forEach((count, idx) => { items[idx].count = count; });
  }

  return items.reduce((sum, item) => sum + item.count * item.pointsPer, 0);
}

function finalizeBlueprint(bp: ExamBlueprint, targetScore: number): ExamBlueprint {
  const sections = bp.sections.map(section => ({
    ...section,
    questionTypes: sortQuestionTypes(section.questionTypes.map(qt => ({ ...qt }))),
  }));
  const totalScore = tuneCountsToTarget(sections.flatMap(section => section.questionTypes), targetScore);
  return { ...bp, sections, totalScore };
}

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

  const typeGuidance = sortQuestionTypes(variant.questionTypes).map(qt =>
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
    '- 题型顺序固定为：选择题 multiple_choice → 判断题 true_false → 填空题 fill_blank → 简答/解答题 short_answer',
    '- 选择题不超过 10 道',
  ].join('\n');
}

// ── 降级蓝图（LLM 失败时的兜底） ──────────────────────────

export function defaultBlueprint(config: { subject: string; grade: string; totalScore?: number }, mode: 'exam' | 'quiz' = 'exam'): ExamBlueprint {
  const totalScore = config.totalScore ?? 100;
  const struct = getExamStructure(config.grade);
  const variant = mode === 'quiz' ? struct.quiz : struct.exam;
  const ratio = totalScore / variant.totalScore;

  const questionTypes: QuestionTypeConfig[] = sortQuestionTypes(variant.questionTypes).map(qt => ({
    ...qt,
    count: Math.max(1, Math.round(qt.count * ratio)),
  }));

  // 精确修正舍入误差：暴力遍历所有题型 count 组合，找到总分等于 target 的配置
  const exactScore = (qts: typeof questionTypes) => qts.reduce((s, qt) => s + qt.count * qt.pointsPer, 0);
  let currentScore = exactScore(questionTypes);
  if (currentScore === totalScore) {} // 已命中
  else if (questionTypes.length === 1) {
    // 只有一种题型，直接计算精确 count
    const qt = questionTypes[0];
    qt.count = Math.max(1, Math.round(totalScore / qt.pointsPer));
    currentScore = exactScore(questionTypes);
  } else {
    // 逐题型微调：从后往前尝试，直到总分命中目标
    for (let pass = 0; pass < 3 && currentScore !== totalScore; pass++) {
      for (let i = 0; i < questionTypes.length && currentScore !== totalScore; i++) {
        const qt = questionTypes[i];
        const otherScore = currentScore - qt.count * qt.pointsPer;
        const targetForQt = totalScore - otherScore;
        const newC = Math.max(1, Math.min(20, Math.round(targetForQt / qt.pointsPer)));
        if (newC !== qt.count) {
          qt.count = newC;
          currentScore = exactScore(questionTypes);
        }
      }
    }
  }

  return finalizeBlueprint({
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
  }, totalScore);
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

  // 使用 DeepSeek JSON Output 模式（response_format），支持 thinking 模式
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await model.invoke(
        [new SystemMessage(prompt + '\n\n必须直接输出纯净 JSON 格式的蓝图，不要 markdown 代码块，不要其他文字。')],
        { response_format: { type: 'json_object' } } as any,
      );
      const content = typeof response.content === 'string' ? response.content : '';
      const parsed = JSON.parse(content);
      const validated = examBlueprintSchema.safeParse(parsed);
      if (validated.success) return validateAndFixBlueprint(validated.data, totalScore);
      // schema 不匹配：尝试修复
      console.warn('[blueprint] schema 不匹配，尝试修复:', validated.error.issues.slice(0, 2));
      const fixed = tryFixBlueprint(parsed, totalScore);
      if (fixed) return fixed;
    } catch (err) {
      console.warn(`[blueprint] 第 ${attempt + 1} 次尝试失败:`, err instanceof Error ? err.message.slice(0, 80) : err);
    }
  }
  console.error('[blueprint] 蓝图生成失败，使用默认蓝图');
  return defaultBlueprint(config, mode);
}

// ── 蓝图校验与修复 ─────────────────────────────────────────

/** 校验总分一致性，若不符则按比例调整 count */
function validateAndFixBlueprint(bp: ExamBlueprint, targetScore: number): ExamBlueprint {
  // 展平所有 questionType 以便调整
  type FlatQt = import('@boen/shared').BlueprintQuestionTypePlan & { sectionIdx: number };
  const allQts: FlatQt[] = [];
  for (let si = 0; si < bp.sections.length; si++) {
    for (const qt of bp.sections[si].questionTypes) {
      allQts.push({ ...qt, sectionIdx: si });
    }
  }

  let actualScore = allQts.reduce((s, qt) => s + qt.count * qt.pointsPer, 0);
  const diff = targetScore - actualScore;
  const deviation = Math.abs(diff) / targetScore;

  // 偏差 < 10% → 微调最后一个题型 count，精确命中目标总分
  if (deviation < 0.10) {
    if (diff === 0) return finalizeBlueprint({ ...bp, totalScore: actualScore }, targetScore);
    // 从后往前找 pointsPer 最小的题型来调整（粒度最细）
    for (let i = allQts.length - 1; i >= 0; i--) {
      const qt = allQts[i];
      const adjustment = Math.round(diff / qt.pointsPer);
      const newCount = qt.count + adjustment;
      if (newCount >= 1 && newCount <= 20) {
        // 直接在 allQts 上修改，最后写回 section
        qt.count = newCount;
        actualScore = allQts.reduce((s, q) => s + q.count * q.pointsPer, 0);
        if (actualScore === targetScore) break;
      }
    }
    // 写回 sections
    for (const qt of allQts) {
      const sec = bp.sections[qt.sectionIdx];
      const target = sec.questionTypes.find(t => t.type === qt.type);
      if (target) target.count = qt.count;
    }
    return finalizeBlueprint({ ...bp, totalScore: actualScore }, targetScore);
  }

  // 偏差 ≥ 10% → 按比例调整每个 section 的 count
  const ratio = targetScore / actualScore;
  console.warn(`[blueprint] 总分偏差较大（实际 ${actualScore} vs 目标 ${targetScore}），按比例 ${ratio.toFixed(2)} 调整题量`);

  let fixedSections = bp.sections.map(section => ({
    ...section,
    questionTypes: section.questionTypes.map(qt => ({
      ...qt,
      count: Math.max(1, Math.round(qt.count * ratio)),
    })),
  }));

  // 重新计算，若偏差 < 10% 则微调至精确命中
  let newScore = fixedSections.reduce((s, sec) =>
    s + sec.questionTypes.reduce((ss, qt) => ss + qt.count * qt.pointsPer, 0), 0);
  const newDiff = targetScore - newScore;
  if (Math.abs(newDiff) / targetScore < 0.10 && newDiff !== 0) {
    // 按 pointsPer 升序排列（细粒度优先），微调 count 精确命中总分
    const allQts = fixedSections.flatMap(s => s.questionTypes).sort((a, b) => a.pointsPer - b.pointsPer);
    for (const qt of allQts) {
      for (let delta = 1; delta <= 5; delta++) {
        const adjustment = newDiff > 0 ? delta : -delta;
        if (Math.abs(adjustment * qt.pointsPer) > Math.abs(newDiff)) break;
        const newC = qt.count + adjustment;
        if (newC >= 1 && newC <= 20) {
          const trial = qt.count + adjustment;
          const trialScore = fixedSections.reduce((s, sec) =>
            s + sec.questionTypes.reduce((ss, q) => ss + q.count * q.pointsPer, 0), 0) -
            qt.count * qt.pointsPer + trial * qt.pointsPer;
          if (trialScore === targetScore) {
            qt.count = trial;
            newScore = targetScore;
            break;
          }
        }
      }
      if (newScore === targetScore) break;
    }
  }

  // 偏差仍 > 15% → 放弃 LLM 蓝图，fallback 到确定性数学计算的默认蓝图
  if (Math.abs(targetScore - newScore) / targetScore > 0.15) {
    console.warn(`[blueprint] 总分修正后偏差仍达 ${Math.round(Math.abs(targetScore - newScore) / targetScore * 100)}%，fallback 到默认蓝图`);
    return defaultBlueprint({ subject: bp.sections[0]?.knowledgePoints[0]?.title === '综合知识' ? 'math' : 'math', grade: 'G7', totalScore: targetScore }, 'exam');
  }

  return finalizeBlueprint({ ...bp, sections: fixedSections, totalScore: newScore }, targetScore);
}

/** 尝试修复常见的 schema 校验失败 */
function tryFixBlueprint(raw: any, targetScore: number): ExamBlueprint | null {
  try {
    // 补全根级缺失字段
    if (!raw.title) raw.title = '综合试卷';
    if (!raw.totalScore) raw.totalScore = targetScore;

    // 补全 / 修复 sections
    if (Array.isArray(raw.sections)) {
      for (const sec of raw.sections) {
        if (!sec.title) sec.title = '综合';
        if (!sec.difficulty) sec.difficulty = 'medium';
        // knowledgePoints：可能是字符串数组或缺失
        if (Array.isArray(sec.knowledgePoints)) {
          sec.knowledgePoints = sec.knowledgePoints.map((kp: any) =>
            typeof kp === 'string' ? { title: kp, weight: 0.5 } : kp,
          );
        }
        if (!Array.isArray(sec.knowledgePoints) || sec.knowledgePoints.length === 0) {
          sec.knowledgePoints = [{ title: '综合知识', weight: 1 }];
        }
      }
    }
    // 补全 coveragePlan
    if (!raw.coveragePlan) {
      const allKps = (raw.sections ?? []).flatMap((s: any) =>
        (s.knowledgePoints ?? []).map((kp: any) => kp.title ?? kp)
      );
      raw.coveragePlan = { must: allKps.slice(0, 3), focus: allKps.slice(0, 5), stretch: [] };
    }
    // 补全 difficultyDistribution
    if (!raw.difficultyDistribution) {
      raw.difficultyDistribution = { easy: 0.4, medium: 0.4, hard: 0.2 };
    }
    const dd = raw.difficultyDistribution;
    const sum = (dd.easy ?? 0) + (dd.medium ?? 0) + (dd.hard ?? 0);
    if (sum > 0 && Math.abs(sum - 1) > 0.01) {
      dd.easy = dd.easy / sum;
      dd.medium = dd.medium / sum;
      dd.hard = dd.hard / sum;
    }
    const parsed = examBlueprintSchema.parse(raw);
    return validateAndFixBlueprint(parsed, targetScore);
  } catch (e) {
    return null;
  }
}

// ── 蓝图展平（供阶段二出题使用） ────────────────────────────

/** 蓝图中的单个出题任务（section × questionType） */
export interface WriteTask {
  sectionTitle: string;
  sectionKnowledgePoints: Array<{ id?: number; title: string; weight: number }>;
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
  const tasks: Array<WriteTask & { sectionOrder: number }> = [];
  for (const [sectionOrder, section] of blueprint.sections.entries()) {
    for (const qt of section.questionTypes) {
      tasks.push({
        sectionTitle: section.title,
        sectionKnowledgePoints: section.knowledgePoints.map(kp => ({ id: kp.id, title: kp.title, weight: kp.weight })),
        questionType: qt.type,
        questionTypeLabel: TYPE_LABELS[qt.type] ?? qt.type,
        count: qt.count,
        pointsPer: qt.pointsPer,
        focusKps: qt.focusKps,
        difficulty: section.difficulty,
        sectionOrder,
      });
    }
  }
  return tasks.sort((a, b) =>
    (QUESTION_TYPE_ORDER[a.questionType] ?? 99) - (QUESTION_TYPE_ORDER[b.questionType] ?? 99) ||
    ((a as any).sectionOrder ?? 0) - ((b as any).sectionOrder ?? 0)
  ).map(({ sectionOrder: _sectionOrder, ...task } : WriteTask & { sectionOrder?: number }) => task);
}
