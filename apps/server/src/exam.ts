/**
 * exam.ts — 考试模式：生成试卷 + 批量批改 + 分层报告
 *
 * 重构后的四阶段并发流水线：
 *   1. 蓝图架构师（Blueprint）：bindTools 结构化输出，exam-structures 约束边界
 *   2. 题目编写组（Write）：按 section × questionType 并发，结构化输出
 *   3. 审核委员会（Review）：5 维度并发，量化评分 0-100
 *   4. 重出闭环（Regenerate）：并发重出 + 反馈注入 + 轻量二次校验
 *
 * 蓝图/审核/重出逻辑分别在 exam-blueprint.ts / exam-reviewers.ts，
 * prompt 在 exam-prompts.ts。
 */

import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { SystemMessage } from '@langchain/core/messages';
import type { ExamQuestion, ExamResults, AnswerPayload, ExamQuestionResult, ExamSummary, ExamBlueprint } from '@boen/shared';
import { gradeAnswer, makeGenerateQuestionsTool } from '@boen/agent-core';
import type { ShortAnswerGrader } from '@boen/agent-core';
import { getWeightDistribution, WEIGHT_TIERS } from './kg-weights.js';
import { updateProficiency, getWeakPoints, getRecommendedKPs } from './knowledge-profile.js';
import db from './db.js';
import { retrieveMistakeStyleSamples } from './mistakes.js';
import { withConcurrencyLimit } from './concurrency.js';
import { stepBlueprintArchitect, flattenBlueprint, type WriteTask } from './exam-blueprint.js';
import { reviewBoard, regenerateQuestions } from './exam-reviewers.js';
import { questionWriterPrompt } from './exam-prompts.js';

// ── 配置类型 ─────────────────────────────────

export interface ExamConfig {
  subject: string;
  grade: string;
  chapters?: string[];
  totalScore?: number;
  durationMinutes?: number;
  /** 用户备注：期望考查的教材章节、知识点或其他特殊要求 */
  notes?: string;
  styleContext?: string;
}

export interface ExamSession {
  id: string;
  userId: string;
  subject: string;
  grade: string;
  title: string;
  questions: ExamQuestion[];
  totalScore: number;
  durationMinutes: number;
  status: 'pending' | 'completed';
  createdAt: number;
  submittedAt?: number;
  answers?: Array<{ questionIndex: number; answer: AnswerPayload }>;
  results?: ExamResults;
}

/** 进度回调：每步执行时通知前端（可返回 Promise 以保证 SSE 写入有序） */
export interface ExamProgress {
  step: 'blueprint' | 'write' | 'review' | 'regenerate' | 'analyze' | 'complete';
  message: string;
  progress?: number; // 0-100
}
export type ExamProgressFn = (p: ExamProgress) => void | Promise<void>;

// ── 通用加固工具 ──────────────────────────

/** 把 AI 可能返回的字符串格式 literacies 归一化为数组 */
function normalizeLiteracies(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((l): l is string => typeof l === 'string');
  if (typeof raw === 'string') return raw.split(/[,，、\s]+/).filter(Boolean);
  return ['综合素养'];
}

const TYPE_LABELS: Record<string, string> = { multiple_choice: '选择题', fill_blank: '填空题', true_false: '判断题', short_answer: '简答题' };

/** 本地格式兜底：补齐必填字段、修复残缺选项 */
function localFormatFix(q: ExamQuestion, i: number): ExamQuestion {
  const q2 = { ...q, index: i };
  if (q2.type === 'multiple_choice') {
    if (!q2.options || q2.options.length < 2) {
      q2.options = [{ key: 'A', text: '正确' }, { key: 'B', text: '错误' }];
      q2.correctKeys = ['A'];
    }
    if (!q2.correctKeys?.length) q2.correctKeys = [q2.options[0].key];
  }
  if (!q2.knowledgePoint) q2.knowledgePoint = '综合';
  if (!q2.explanation) q2.explanation = '详见参考答案。';
  q2.literacies = normalizeLiteracies(q2.literacies);
  if (!q2.literacies.length) q2.literacies = ['综合素养'];
  return q2;
}

// ── 考试生成（四阶段并发流水线） ──────────────

/**
 * 重构后的考试生成流水线：
 *   1. 蓝图架构师（stepBlueprintArchitect）— bindTools 结构化输出
 *   2. 题目编写组（stepWriteQuestionsV2）— 按 section×questionType 并发，bindTools 结构化输出
 *   3. 审核委员会（reviewBoard）— 5 维度并发，量化评分
 *   4. 重出闭环（regenerateQuestions）— 并发重出 + 轻量二次校验
 */
export async function generateExam(
  model: BaseChatModel,
  config: ExamConfig,
  onProgress?: ExamProgressFn,
  userId?: string,
): Promise<{ title: string; questions: ExamQuestion[]; totalScore: number; durationMinutes: number }> {
  try {
    const weightDist = getWeightDistribution(config.subject, config.grade);
    const mode = (config.durationMinutes ?? 45) <= 15 ? 'quiz' : 'exam';

    // ─── 阶段一：蓝图架构师 ────────────────────
    await onProgress?.({ step: 'blueprint', message: '正在分析知识图谱与权重分布…', progress: 5 });
    const weightGuide = buildWeightGuideForPrompt(weightDist);
    const profileContext = userId ? await buildProfileContext(userId, config) : '';
    const styleContext = userId ? await retrieveMistakeStyleSamples(userId, config.subject, config.grade, config.notes ?? '', [], 3).catch(() => '') : '';
    const enrichedConfig: ExamConfig = { ...config, styleContext };

    await onProgress?.({ step: 'blueprint', message: '正在生成试卷蓝图…', progress: 10 });
    const blueprint = await stepBlueprintArchitect(
      model,
      { subject: enrichedConfig.subject, grade: enrichedConfig.grade, totalScore: enrichedConfig.totalScore, notes: enrichedConfig.notes },
      weightGuide,
      [profileContext, styleContext].filter(Boolean).join('\n\n'),
      mode,
    );

    await onProgress?.({
      step: 'blueprint',
      message: `蓝图生成完成：${blueprint.title}，共 ${blueprint.sections.length} 个板块，${blueprint.totalScore} 分`,
      progress: 20,
    });

    // ─── 阶段二：题目编写组（按 section × questionType 并发，限 6 路） ────
    const writeTasks = flattenBlueprint(blueprint);
    await onProgress?.({ step: 'write', message: `正在并发出题（${writeTasks.length} 组，最多 6 路并发）…`, progress: 25 });

    let completedGroups = 0;
    const writeResults = await withConcurrencyLimit(
      writeTasks.map((task) => async () => {
        const result = await stepWriteQuestionsV2(model, enrichedConfig, task, blueprint, writeTasks, []);
        completedGroups++;
        await onProgress?.({
          step: 'write',
          message: `已完成 ${completedGroups}/${writeTasks.length} 组`,
          progress: 25 + Math.round((completedGroups / writeTasks.length) * 55),
        });
        return result;
      }),
      { limit: 6, verbose: true },
    );

    const allQuestions: ExamQuestion[] = [];
    for (const r of writeResults) {
      if (r.status === 'fulfilled') allQuestions.push(...r.value);
      else console.error(`出题组失败:`, r.reason?.message?.slice(0, 100));
    }

    // 编号 + 本地格式修复
    let questions = allQuestions.map((q, i) => localFormatFix(q, i));
    await onProgress?.({ step: 'write', message: `已完成 ${questions.length} 道题`, progress: 82 });

    // ─── 阶段三：审核委员会（5 维度并发） ──────
    await onProgress?.({ step: 'review', message: '正在执行 5 维度并发审核…', progress: 85 });
    const { scores } = await reviewBoard(model, questions, { subject: enrichedConfig.subject, grade: enrichedConfig.grade }, blueprint);

    const regenCount = scores.filter(s => s.needsRegeneration).length;
    await onProgress?.({
      step: 'review',
      message: `审核完成，${regenCount} 题需要重出`,
      progress: 90,
    });

    // ─── 阶段四：重出闭环（并发 + 反馈注入 + 二次校验） ────
    if (regenCount > 0) {
      await onProgress?.({ step: 'regenerate', message: `正在并发重出 ${regenCount} 题…`, progress: 92 });
      const crossGroupContext = buildCrossGroupContext(questions);
      const regenResult = await regenerateQuestions(
        model,
        questions,
        scores,
        { subject: enrichedConfig.subject, grade: enrichedConfig.grade },
        crossGroupContext,
        writeSingleQuestion,
      );
      questions = regenResult.questions.map((q, i) => localFormatFix(q, i));

      if (regenResult.report.regeneratedIndices.length > 0) {
        await onProgress?.({
          step: 'regenerate',
          message: `重出完成：${regenResult.report.regeneratedIndices.length} 题已替换${regenResult.report.qualityWarnings.length ? `，${regenResult.report.qualityWarnings.length} 题保留原题` : ''}`,
          progress: 98,
        });
      }
    }

    await onProgress?.({ step: 'complete', message: `试卷生成完成，共 ${questions.length} 道题`, progress: 100 });

    // 安全兜底：极端情况下 0 道题 → 注入一道默认题
    if (questions.length === 0) {
      const defaultQs: ExamQuestion[] = [{
        index: 0, type: 'multiple_choice', points: Math.max(blueprint.totalScore || 100, 10),
        stem: '请选出正确答案。', knowledgePoint: '综合', literacies: ['综合素养'],
        difficulty: 'medium', explanation: '本题为备选题目。',
        options: [{ key: 'A', text: 'A' }, { key: 'B', text: 'B' }, { key: 'C', text: 'C' }, { key: 'D', text: 'D' }],
        correctKeys: ['A'], multiSelect: false,
      }];
      return { title: blueprint.title, questions: defaultQs, totalScore: defaultQs[0].points, durationMinutes: enrichedConfig.durationMinutes ?? 20 };
    }

    const totalScore = questions.reduce((s, q) => s + q.points, 0);
    const estMinutes = enrichedConfig.durationMinutes ?? Math.max(20, Math.min(90, Math.round(questions.length * 1.5)));
    return { title: blueprint.title, questions, totalScore, durationMinutes: estMinutes };
  } catch (e: any) {
    console.error('生成试卷失败:', e?.message?.slice(0, 200));
    throw new Error(`生成试卷失败：${e?.message || '未知错误'}`);
  }
}

// ── 阶段二：题目编写组（结构化输出 + 跨组差异化） ────────────

/** 构造跨组差异化上下文（其他组正在出的知识点/情景） */
function buildCrossGroupContext(allQuestions: ExamQuestion[]): string {
  if (allQuestions.length === 0) return '';
  const kps = [...new Set(allQuestions.map(q => q.knowledgePoint).filter(k => k && k !== '综合'))];
  const stemSnippets = allQuestions.map(q => q.stem?.slice(0, 40)).filter(Boolean).slice(0, 10);
  return [
    '其他题目的知识点：' + (kps.length ? kps.join('、') : '（无）'),
    '其他题目的题干片段（请避免相似情景）：',
    ...stemSnippets.map((s, i) => `  ${i + 1}. ${s}…`),
  ].join('\n');
}

/**
 * 按 section × questionType 出题，用 bindTools + generate_questions tool 强制结构化输出。
 * 失败 → 重试 2 次 → 降级题量 → 标记 __needs_review__ 强制进入重出池。
 */
async function stepWriteQuestionsV2(
  model: BaseChatModel,
  config: ExamConfig,
  task: WriteTask,
  blueprint: ExamBlueprint,
  allTasks: WriteTask[],
  existingQuestions: ExamQuestion[],
): Promise<ExamQuestion[]> {
  // 跨组差异化上下文：其他组的知识点 + 题型
  const otherGroups = allTasks
    .filter(t => t !== task)
    .map(t => `  - ${t.sectionTitle}·${t.questionTypeLabel}：${t.sectionKnowledgePoints.map(kp => kp.title).join('、')}`);
  const crossGroupContext = otherGroups.length ? otherGroups.join('\n') : '';

  const prompt = questionWriterPrompt({
    config,
    sectionTitle: task.sectionTitle,
    sectionKnowledgePoints: task.sectionKnowledgePoints,
    questionType: task.questionType,
    questionTypeLabel: task.questionTypeLabel,
    count: task.count,
    pointsPer: task.pointsPer,
    focusKps: task.focusKps,
    difficulty: task.difficulty,
    blueprintTitle: blueprint.title,
    crossGroupContext,
    existingQuestions,
    styleContext: config.styleContext,
  });

  // 尝试出题，最多重试 2 次（第 3 次走降级题量）
  for (let attempt = 0; attempt < 3; attempt++) {
    const formatRetryHint = attempt > 0 ? `第 ${attempt + 1} 次尝试，上次输出格式有误` : undefined;
    const finalPrompt = formatRetryHint
      ? questionWriterPrompt({ config, sectionTitle: task.sectionTitle, sectionKnowledgePoints: task.sectionKnowledgePoints, questionType: task.questionType, questionTypeLabel: task.questionTypeLabel, count: task.count, pointsPer: task.pointsPer, focusKps: task.focusKps, difficulty: task.difficulty, blueprintTitle: blueprint.title, crossGroupContext, existingQuestions, styleContext: config.styleContext, formatRetryHint })
      : prompt;

    try {
      const questions = await invokeGenerateQuestions(model, finalPrompt, task.questionType, task.count);
      if (questions.length > 0) {
        return questions.map((q: any, i: number) => toExamQuestion(q, task, i));
      }
    } catch (err) {
      console.warn(`[write:${task.questionType}] 第 ${attempt + 1} 次失败:`, err instanceof Error ? err.message.slice(0, 80) : err);
    }

    // 还在循环内 → 本次失败，继续重试
    console.warn(`[write:${task.questionType}] 第 ${attempt + 1} 次返回空结果，${attempt < 2 ? '继续重试' : '尝试降级题量'}`);
  }

  // 3 次全部失败 → 降级题量（count-1，最少 1）
  if (task.count > 1) {
    console.warn(`[write:${task.questionType}] 降级题量 ${task.count} → ${Math.max(1, task.count - 1)}`);
    task = { ...task, count: Math.max(1, task.count - 1) };
    try {
      const questions = await invokeGenerateQuestions(model, prompt, task.questionType, task.count);
      if (questions.length > 0) return questions.map((q: any, i: number) => toExamQuestion(q, task, i));
    } catch { /* 继续到兜底 */ }
  }

    // 最终兜底：标记 __needs_review__，审核阶段强制重出
    console.warn(`[write:${task.questionType}] 全部失败，生成占位题等待重出`);
    return Array.from({ length: task.count }, (_, i) => ({
      index: i,
      type: task.questionType as ExamQuestion['type'],
      points: task.pointsPer,
      stem: '__needs_review__',
      knowledgePoint: task.focusKps[0] ?? '综合',
      literacies: ['综合素养'],
      difficulty: task.difficulty as ExamQuestion['difficulty'],
      explanation: '__needs_review__',
      ...(task.questionType === 'multiple_choice' ? { options: [{ key: 'A', text: 'A' }, { key: 'B', text: 'B' }], correctKeys: ['A'], multiSelect: false } : {}),
    } as ExamQuestion));
  }

/** 调用 model.bindTools + generate_questions tool 获取结构化题目 */
async function invokeGenerateQuestions(
  model: BaseChatModel,
  prompt: string,
  questionType: string,
  count: number,
): Promise<any[]> {
  // 先尝试 bindTools 结构化输出
  if (model.bindTools) {
    try {
      const genTool = makeGenerateQuestionsTool(questionType, count);
      const bound = model.bindTools([genTool], {
        tool_choice: { type: 'function', function: { name: 'generate_questions' } },
      } as any);
      const response = await bound.invoke([new SystemMessage(prompt)]);
      const toolCalls = (response as any)?.tool_calls ?? [];
      const call = toolCalls.find((c: any) => c.name === 'generate_questions');
      if (call?.args?.questions && Array.isArray(call.args.questions) && call.args.questions.length > 0) {
        return call.args.questions;
      }
    } catch (err) {
      console.warn(`[invoke:${questionType}] bindTools 失败:`, err instanceof Error ? err.message.slice(0, 80) : err);
      // 继续尝试文本回退
    }
  }

  // 文本回退：使用专为文本模式设计的 prompt（不含"通过工具输出"的指令）
  const textPrompt = prompt + '\n\n=== 输出格式要求 ===\n直接输出 JSON 数组 {"questions": [...]}，不要 markdown 代码块，不要其他文字。' +
    `\n一次性输出全部 ${count} 道题。`;
  try {
    const response = await model.invoke([new SystemMessage(textPrompt)]);
    const content = typeof response.content === 'string' ? response.content : '';
    // 宽容解析：先尝试 JSON.parse，再尝试提取代码块
    let parsed: any;
    try { parsed = JSON.parse(content); } catch {
      const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
      const cleaned = (jsonMatch ? jsonMatch[1].trim() : content.trim()).replace(/^[^{]*({[\s\S]*})[^}]*$/, '$1');
      parsed = JSON.parse(cleaned);
    }
    const questions = parsed.questions ?? (Array.isArray(parsed) ? parsed : []);
    if (Array.isArray(questions) && questions.length > 0) {
      return questions;
    }
  } catch (err) {
    console.warn(`[invoke:${questionType}] 文本回退解析失败:`, err instanceof Error ? err.message.slice(0, 80) : err);
  }

  return [];
}

/** 把 LLM 输出的单题转换为 ExamQuestion（补全 points/index） */
function toExamQuestion(raw: any, task: WriteTask, index: number): ExamQuestion {
  const base: ExamQuestion = {
    index,
    type: task.questionType as ExamQuestion['type'],
    points: task.pointsPer,
    stem: raw.stem ?? '',
    passage: raw.passage,
    knowledgePoint: raw.knowledgePoint ?? task.focusKps[0] ?? '综合',
    knowledgePointId: raw.knowledgePointId,
    literacies: normalizeLiteracies(raw.literacies),
    difficulty: raw.difficulty ?? task.difficulty,
    explanation: raw.explanation ?? '',
    groupId: raw.groupId,
  };

  if (base.type === 'multiple_choice') {
    base.options = (raw.options ?? []).filter((o: any) => o?.key);
    while (base.options!.length < 2) base.options!.push({ key: String.fromCharCode(65 + base.options!.length), text: '选项' + String.fromCharCode(65 + base.options!.length) });
    base.correctKeys = (raw.correctKeys ?? []).filter((k: string) => base.options!.some(o => o.key === k));
    if (!base.correctKeys!.length) base.correctKeys = [base.options![0].key];
    base.multiSelect = raw.multiSelect ?? false;
  }
  if (base.type === 'fill_blank') {
    base.blanks = raw.blanks ?? [];
    base.blankCount = base.blanks.length;
  }
  if (base.type === 'true_false') base.answer = raw.answer ?? true;
  if (base.type === 'short_answer') { base.referenceAnswer = raw.referenceAnswer ?? ''; base.keyPoints = raw.keyPoints ?? []; }

  return base;
}

// ── 重出阶段：单题出题（供 regenerateQuestions 回调） ─────────

async function writeSingleQuestion(model: BaseChatModel, prompt: string, questionType: string): Promise<ExamQuestion | null> {
  try {
    const questions = await invokeGenerateQuestions(model, prompt, questionType, 1);
    if (questions.length === 0) return null;
    return toExamQuestion(questions[0], {
      questionType,
      questionTypeLabel: TYPE_LABELS[questionType] ?? questionType,
      count: 1,
      pointsPer: 0, // points 由调用方保留原题的 points
      focusKps: [],
      difficulty: 'medium',
      sectionTitle: '',
      sectionKnowledgePoints: [],
    } as WriteTask, 0);
  } catch {
    return null;
  }
}

// ── 学情画像上下文（保留原有逻辑） ──────────────────────────

async function buildProfileContext(userId: string, config: ExamConfig): Promise<string> {
  const weak = getWeakPoints(userId, config.subject, config.grade, 60, 5);
  const recs = getRecommendedKPs(userId, config.subject, config.grade, 5);
  const parts: string[] = [];
  if (weak.length) parts.push('薄弱知识点（应优先考查）：' + weak.map(w => w.title).join('、'));
  if (recs.length) parts.push('推荐强化知识点：' + recs.map(r => r.title).join('、'));
  return parts.join('\n');
}

function buildWeightGuideForPrompt(dist: any[]): string {
  const byTier: Record<string, any[]> = {};
  for (const d of dist) {
    if (!byTier[d.tier]) byTier[d.tier] = [];
    byTier[d.tier].push(d);
  }
  const lines: string[] = [];
  for (const [tier, items] of Object.entries(byTier)) {
    const t = WEIGHT_TIERS.find((w) => w.label === tier);
    const ratio = t ? `（建议占比 ${t.paperRatio}%）` : '';
    lines.push(`\n${tier}${ratio}:`);
    for (const item of items) {
      lines.push(`  - ${item.title} (${item.classHours}课时)`);
    }
  }
  lines.push('\n严格按此比例分配题目数量。核心+重要应占 70% 以上。');
  return lines.join('\n');
}

// ── 简答题 LLM 评分 ────────────────────────────

const SHORT_ANSWER_GRADING_PROMPT = `你是一位严谨的评分老师。请根据参考答案和评分要点，对学生的答案进行评分。

【题目】
{stem}
【参考答案】
{referenceAnswer}
【评分要点】
{keyPoints}
【满分】
{maxScore} 分

【学生答案】
{userAnswer}

评分规则：
1. 学生答案与参考答案语义一致，或覆盖全部评分要点 → 满分
2. 只覆盖部分要点 → 按比例给分（如 2 个要点答对 1 个则给一半分）
3. 完全不相关或留空白 → 0 分
4. 语言类题目（如英语）：只要语义和用法正确即可，不要求措辞完全一致
5. 数学/科学类：过程正确但最终答案有小错可酌情扣分

请直接输出 JSON（不要 markdown 代码块标记），格式如下：
{"correct": true/false, "score": 分数, "explanation": "用两三句话说明扣分或满分理由，引导学生"}`;

/** 构建基于 LLM 的简答题评分器 */
export function createShortAnswerGrader(model: BaseChatModel): ShortAnswerGrader {
  return async (params) => {
    const prompt = SHORT_ANSWER_GRADING_PROMPT
      .replace('{stem}', params.stem)
      .replace('{referenceAnswer}', params.referenceAnswer ?? '（未提供）')
      .replace('{keyPoints}', params.keyPoints?.length ? params.keyPoints.join('、') : '（未提供）')
      .replace('{maxScore}', String(params.maxScore))
      .replace('{userAnswer}', params.userAnswer);

    try {
      const response = await model.invoke([new SystemMessage(prompt)]);
      const content = typeof response.content === 'string' ? response.content : JSON.stringify(response.content);
      // 尝试提取 JSON
      const jsonMatch = content.match(/\{[\s\S]*"correct"[\s\S]*"score"[\s\S]*"explanation"[\s\S]*\}/);
      const jsonStr = jsonMatch ? jsonMatch[0] : content;
      const parsed = JSON.parse(jsonStr);
      return {
        correct: Boolean(parsed.correct),
        score: Math.max(0, Math.min(1, Number(parsed.score))),
        explanation: String(parsed.explanation ?? ''),
      };
    } catch (err) {
      console.error('简答题 LLM 评分失败:', err instanceof Error ? err.message : String(err));
      // 降级：不给分但留评语
      return { correct: false, score: 0, explanation: '评分服务暂时不可用，请老师人工批阅。' };
    }
  };
}

// ── 考试综合分析 ──────────────────────────────

const EXAM_ANALYSIS_PROMPT = `你是一位教学经验丰富的老师「博文」。请根据以下学生本次考试的答题情况，写一段简短、有温度的总结分析（Markdown 格式）。

【学科】{subject}
【年级】{grade}
【总分】{totalScore}/{maxScore} 分（{percentage}%）—— {grade}

{questionDetails}

【考查知识点汇总】
{kpSummary}

写作要求：
1. 语气亲切但专业，像老师在和学生面对面分析试卷
2. 分段结构：总体评价 → 主要失分点分析 → 暴露的薄弱知识点 → 后续学习建议
3. 针对具体失分题目给出改进方向，不要只泛泛而谈
4. 如果是满分或接近满分，不要只说"考得好"，还要指出可以挑战的更高难度内容
5. 如果是低分，语气要鼓励，并给出可操作的学习建议
6. 控制在 300-500 字，Markdown 格式，用小标题分段`;

async function generateExamAnalysis(
  model: BaseChatModel,
  questions: ExamQuestion[],
  results: ExamResults,
  config: { subject: string; grade: string },
): Promise<string> {
  const subjectLabel: Record<string, string> = { chinese: '语文', math: '数学', english: '英语', science: '科学' };
  const subject = subjectLabel[config.subject] ?? config.subject;

  const questionDetails = results.questionResults.map((qr) => {
    const q = questions.find(x => x.index === qr.index);
    const typeLabel: Record<string, string> = { multiple_choice: '选择', fill_blank: '填空', true_false: '判断', short_answer: '简答' };
    const status = qr.correct === true ? '✅ 正确' : qr.correct === false ? '❌ 错误' : '⬜ 未答';
    const kp = qr.knowledgePoint ?? q?.knowledgePoint ?? '综合';
    return `- 第${qr.index + 1}题（${typeLabel[q?.type ?? ''] ?? '其他'}，${qr.maxScore}分）：得 ${qr.score} 分 ${status}，考点：${kp}`;
  }).join('\n');

  const kpSummary = results.kpBreakdown
    .map(kp => `- ${kp.kp}：${kp.score}/${kp.maxScore}（${kp.percentage}%）`)
    .join('\n');

  const prompt = EXAM_ANALYSIS_PROMPT
    .replace('{subject}', subject)
    .replace('{grade}', config.grade)
    .replace('{totalScore}', String(results.totalScore))
    .replace('{maxScore}', String(results.maxScore))
    .replace('{percentage}', String(results.percentage))
    .replace('{grade}', results.grade)
    .replace('{questionDetails}', questionDetails)
    .replace('{kpSummary}', kpSummary);

  try {
    const response = await model.invoke([new SystemMessage(prompt)]);
    const content = typeof response.content === 'string' ? response.content : JSON.stringify(response.content);
    return content.trim();
  } catch (err) {
    console.error('生成考试分析失败:', err instanceof Error ? err.message : String(err));
    return '';
  }
}

// ── 考试评分 ─────────────────────────────────

export async function gradeExam(
  questions: ExamQuestion[],
  answers: Array<{ questionIndex: number; answer: AnswerPayload }>,
  model?: BaseChatModel,
  examInfo?: { subject?: string; grade?: string },
): Promise<ExamResults> {
  const answerMap = new Map(answers.map(a => [a.questionIndex, a.answer]));
  const shortAnswerGrader = model ? createShortAnswerGrader(model) : undefined;

  const questionResults: ExamQuestionResult[] = await Promise.all(questions.map(async (q) => {
    const answer = answerMap.get(q.index);
    if (!answer) {
      return { index: q.index, correct: false, score: 0, maxScore: q.points, reference: '', explanation: q.explanation || '', knowledgePoint: q.knowledgePoint, literacy: normalizeLiteracies(q.literacies) };
    }

    const toolName = questionTypeToToolName(q.type);
    const rawArgs = buildRawArgs(q);
    const { result } = await gradeAnswer(toolName, rawArgs, answer, shortAnswerGrader);

    // 简答题 + 填空题：支持按比例计分（部分正确给部分分）
    const scaledScore = (q.type === 'short_answer' || q.type === 'fill_blank') && result.maxScore > 0
      ? Math.round((result.score / result.maxScore) * q.points)
      : result.correct === true ? q.points : 0;

    return {
      index: q.index,
      correct: result.correct,
      score: scaledScore,
      maxScore: q.points,
      reference: result.reference,
      explanation: result.explanation,
      knowledgePoint: q.knowledgePoint,
      literacy: normalizeLiteracies(q.literacies),
    };
  }));

  const totalScore = questionResults.reduce((s, r) => s + r.score, 0);
  const maxScore = questionResults.reduce((s, r) => s + r.maxScore, 0);
  const percentage = maxScore > 0 ? Math.round((totalScore / maxScore) * 100) : 0;

  const grade = percentage >= 90 ? '优秀' : percentage >= 75 ? '良好' : percentage >= 60 ? '及格' : '需努力';

  const examResults: ExamResults = {
    totalScore, maxScore, percentage, grade,
    questionResults,
    tierBreakdown: computeTierBreakdown(questions, questionResults),
    kpBreakdown: computeKpBreakdown(questionResults),
    literacyBreakdown: computeLiteracyBreakdown(questionResults),
  };

  // 生成综合分析（有模型时）
  if (model) {
    try {
      const analysis = await generateExamAnalysis(model, questions, examResults, { subject: examInfo?.subject ?? '', grade: examInfo?.grade ?? '' });
      if (analysis) examResults.analysis = analysis;
    } catch (err) {
      console.warn('[grading] analysis failed:', err);
    }
  }

  return examResults;
}

function computeTierBreakdown(questions: ExamQuestion[], results: ExamQuestionResult[]): Array<{ tier: string; correct: number; total: number; percentage: number }> {
  const tiers: Record<string, { correct: number; total: number }> = { Core: { correct: 0, total: 0 }, Important: { correct: 0, total: 0 }, Standard: { correct: 0, total: 0 }, Other: { correct: 0, total: 0 } };
  for (const q of questions) {
    const r = results.find(x => x.index === q.index);
    const tier = getKpTier(q.knowledgePoint ?? '');
    if (!tiers[tier]) tiers[tier] = { correct: 0, total: 0 };
    tiers[tier].total += q.points;
    tiers[tier].correct += r?.score ?? 0;
  }
  return Object.entries(tiers).filter(([_, v]) => v.total > 0).map(([tier, v]) => ({ tier, correct: v.correct, total: v.total, percentage: Math.round((v.correct / v.total) * 100) }));
}

function computeKpBreakdown(results: ExamQuestionResult[]): Array<{ kp: string; score: number; maxScore: number; percentage: number }> {
  const map = new Map<string, { score: number; maxScore: number }>();
  for (const r of results) {
    if (!r.knowledgePoint) continue;
    const prev = map.get(r.knowledgePoint) ?? { score: 0, maxScore: 0 };
    prev.score += r.score;
    prev.maxScore += r.maxScore;
    map.set(r.knowledgePoint, prev);
  }
  return Array.from(map.entries()).map(([kp, v]) => ({ kp, score: v.score, maxScore: v.maxScore, percentage: v.maxScore > 0 ? Math.round((v.score / v.maxScore) * 100) : 0 }));
}

function computeLiteracyBreakdown(results: ExamQuestionResult[]): Array<{ literacy: string; score: number; maxScore: number; percentage: number }> {
  const map = new Map<string, { score: number; maxScore: number }>();
  for (const r of results) {
    for (const lit of r.literacy ?? []) {
      const prev = map.get(lit) ?? { score: 0, maxScore: 0 };
      prev.score += r.score;
      prev.maxScore += r.maxScore;
      map.set(lit, prev);
    }
  }
  return Array.from(map.entries()).map(([lit, v]) => ({ literacy: lit, score: v.score, maxScore: v.maxScore, percentage: v.maxScore > 0 ? Math.round((v.score / v.maxScore) * 100) : 0 }));
}

/**
 * 模糊查找知识点节点。
 * LLM 在出题时写的 knowledgePoint（如"一般现在时"）和入库的 kg_nodes.title
 * （如"一般现在时的用法"）可能不完全一致，需要从精确→包含逐级降级匹配。
 * @param subject 限定学科（传 "math" 则不会跨学科匹配到语文的"综合"）
 */
export function findKnowledgePointNode(title: string, subject?: string): { id: number; weight?: number } | undefined {
  const subjectSql = subject ? ` AND subject=?` : '';

  // Level 1: 精确匹配
  let node = db.prepare(`SELECT id, weight FROM kg_nodes WHERE type='knowledge_point' AND title=?${subjectSql}`).get(...(subject ? [title, subject] : [title])) as ({ id: number; weight: number } | undefined);
  if (node) return node;

  // Level 2: 查询词被包含在库标题中（"一般现在时" → "一般现在时的用法"）
  node = db.prepare(`SELECT id, weight FROM kg_nodes WHERE type='knowledge_point' AND title LIKE ?${subjectSql}`).get(...(subject ? [`%${title}%`, subject] : [`%${title}%`])) as ({ id: number; weight: number } | undefined);
  if (node) return node;

  // Level 3: 库标题被包含在查询词中（反向）
  node = db.prepare(`SELECT id, weight FROM kg_nodes WHERE type='knowledge_point' AND ? LIKE '%' || title${subjectSql}`).get(...(subject ? [title, subject] : [title])) as ({ id: number; weight: number } | undefined);
  if (node) return node;

  return undefined;
}

function getKpTier(kp: string, subject?: string): string {
  const node = findKnowledgePointNode(kp, subject);
  if (!node) return 'Standard';
  if (node.weight && node.weight >= 0.75) return 'Core';
  if (node.weight && node.weight >= 0.5) return 'Important';
  return 'Standard';
}

function questionTypeToToolName(type: string): string {
  const map: Record<string, string> = { multiple_choice: 'ask_multiple_choice', fill_blank: 'ask_fill_blank', true_false: 'ask_true_false', short_answer: 'ask_short_answer' };
  return map[type] || 'ask_multiple_choice';
}

function buildRawArgs(q: ExamQuestion): Record<string, unknown> {
  const base: Record<string, unknown> = { stem: q.stem, explanation: q.explanation ?? '', knowledgePoint: q.knowledgePoint, knowledgePointId: q.knowledgePointId, literacies: normalizeLiteracies(q.literacies), difficulty: q.difficulty };
  if (q.type === 'multiple_choice') return { ...base, options: q.options, correctKeys: q.correctKeys, multiSelect: q.multiSelect };
  if (q.type === 'fill_blank') return { ...base, blanks: q.blanks };
  if (q.type === 'true_false') return { ...base, answer: q.answer };
  if (q.type === 'short_answer') return { ...base, referenceAnswer: q.referenceAnswer, keyPoints: q.keyPoints };
  return base;
}

// ── 会话管理 ─────────────────────────────────

export function createExamSession(userId: string, config: ExamConfig, data: { title: string; questions: ExamQuestion[]; totalScore: number; durationMinutes: number }): ExamSession {
  const id = `exam-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`INSERT INTO exam_sessions (id, user_id, subject, grade, title, questions, total_score, duration_minutes, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`).run(id, userId, config.subject, config.grade, data.title, JSON.stringify(data.questions), data.totalScore, data.durationMinutes, now);
  return { id, userId, subject: config.subject, grade: config.grade, title: data.title, questions: data.questions, totalScore: data.totalScore, durationMinutes: data.durationMinutes, status: 'pending', createdAt: now };
}

export function getExamSession(examId: string, userId: string): ExamSession | null {
  const row = db.prepare(`SELECT * FROM exam_sessions WHERE id=? AND user_id=?`).get(examId, userId) as any;
  if (!row) return null;
  return {
    id: row.id, userId: row.user_id, subject: row.subject, grade: row.grade, title: row.title,
    questions: JSON.parse(row.questions), totalScore: row.total_score, durationMinutes: row.duration_minutes ?? 45,
    status: row.status, createdAt: row.created_at, submittedAt: row.submitted_at,
    answers: row.answers ? JSON.parse(row.answers) : undefined,
    results: row.results ? JSON.parse(row.results) : undefined,
  };
}

/** 删除一场考试（任意状态，仅限本人）。返回是否删除成功 */
export function deleteExamSession(examId: string, userId: string): boolean {
  const info = db.prepare(`DELETE FROM exam_sessions WHERE id=? AND user_id=?`).run(examId, userId);
  return info.changes > 0;
}

/** 列出用户的全部考试（概要），按创建时间倒序，供「考试历史」页回顾 */
export function listExamSessions(userId: string): ExamSummary[] {
  const rows = db.prepare(
    `SELECT id, subject, grade, title, total_score, status, created_at, submitted_at, results
     FROM exam_sessions WHERE user_id=? ORDER BY created_at DESC`,
  ).all(userId) as any[];
  return rows.map((r) => {
    const results = r.results ? (JSON.parse(r.results) as ExamResults) : undefined;
    return {
      examId: r.id,
      title: r.title,
      subject: r.subject,
      grade: r.grade,
      totalScore: r.total_score,
      status: r.status,
      createdAt: r.created_at,
      submittedAt: r.submitted_at ?? undefined,
      result: results
        ? { totalScore: results.totalScore, maxScore: results.maxScore, percentage: results.percentage, grade: results.grade }
        : undefined,
    };
  });
}

export async function submitExamSession(examId: string, userId: string, answers: Array<{ questionIndex: number; answer: AnswerPayload }>, model?: BaseChatModel): Promise<ExamResults> {
  const session = getExamSession(examId, userId);
  if (!session) throw new Error('考试会话未找到');
  if (session.status === 'completed') throw new Error('该考试已提交');

  const results = await gradeExam(session.questions, answers, model, { subject: session.subject, grade: session.grade });
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`UPDATE exam_sessions SET status='completed', answers=?, results=?, submitted_at=? WHERE id=? AND user_id=?`).run(JSON.stringify(answers), JSON.stringify(results), now, examId, userId);

  // 更新知识画像并记录变化（优先用 knowledgePointId 直连节点）
  const proficiencyChanges: Array<{ kpTitle: string; before: number; after: number; score: number; maxScore: number }> = [];
  for (const qr of results.questionResults) {
    // 收集要更新的节点
    const nodesToUpdate: Array<{ id: number; title: string }> = [];
    if ((qr as any).knowledgePointId) {
      const node = db.prepare('SELECT id, title FROM kg_nodes WHERE id=?').get((qr as any).knowledgePointId) as { id: number; title: string } | undefined;
      if (node) nodesToUpdate.push(node);
    }
    if (nodesToUpdate.length === 0 && qr.knowledgePoint) {
      for (const kp of qr.knowledgePoint.split(/[；;]/).map(s => s.trim()).filter(Boolean)) {
        const node = findKnowledgePointNode(kp, session.subject);
        if (node) nodesToUpdate.push({ id: node.id, title: kp });
      }
    }
    for (const node of nodesToUpdate) {
      const oldRow = db.prepare('SELECT weighted_score FROM user_kp_proficiency WHERE user_id=? AND kg_node_id=?').get(userId, node.id) as { weighted_score: number } | undefined;
      const before = oldRow?.weighted_score ?? -1;
      updateProficiency(userId, node.id, qr.score, qr.maxScore, 'exam');
      const newRow = db.prepare('SELECT weighted_score FROM user_kp_proficiency WHERE user_id=? AND kg_node_id=?').get(userId, node.id) as { weighted_score: number } | undefined;
      const after = newRow?.weighted_score ?? -1;
      proficiencyChanges.push({ kpTitle: node.title, before: Math.max(0, before), after: Math.max(0, after), score: qr.score, maxScore: qr.maxScore });
    }
  }
  if (proficiencyChanges.length) results.proficiencyChanges = proficiencyChanges;

  return results;
}
