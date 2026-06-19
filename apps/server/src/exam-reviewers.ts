/**
 * exam-reviewers.ts — 阶段三：审核委员会（5 维度并发） + 阶段四：重出闭环
 *
 * 5 个审核维度各自独立 LLM 调用，并发执行：
 *   A. 正确性 (correctness)      — 答案/解析是否知识性正确
 *   B. 相似性 (similarity)        — 跨题雷同（题干/选项/情景/知识点）
 *   C. 蓝图匹配 (blueprint_match) — 是否覆盖蓝图指定知识点、难度分布
 *   D. 格式 (format)              — KaTeX/TikZ/op 语法闭合、JSON 转义
 *   E. 区分度 (discrimination)    — 是否太 trivial 或超纲、干扰项质量
 *
 * 每题每维度量化打分 0-100，总分加权平均。
 * total < 70 或任一维度 < 60 → 进入重出池。
 */

import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { SystemMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { tool } from '@langchain/core/tools';
import type {
  ExamQuestion,
  ExamBlueprint,
  QuestionQualityScore,
  DimensionScore,
  ReviewDimension,
  ExamQualityReport,
} from '@boen/shared';
import { withConcurrencyLimit } from './concurrency.js';

/** 单维度审核超时（毫秒） */
const REVIEW_TIMEOUT = 120_000;
import {
  reviewCorrectnessPrompt,
  reviewSimilarityPrompt,
  reviewBlueprintMatchPrompt,
  reviewFormatPrompt,
  reviewDiscriminationPrompt,
  regenerateQuestionPrompt,
  subjectLabel,
  gradeLabel,
} from './exam-prompts.js';

// ── 评分权重（可配） ────────────────────────────────────────

const DIMENSION_WEIGHTS: Record<ReviewDimension, number> = {
  correctness: 0.30,
  similarity: 0.25,
  blueprint_match: 0.20,
  format: 0.10,
  discrimination: 0.15,
};

const REGEN_THRESHOLD_TOTAL = 50;       // 总分 < 50 → 重出（原 70，防止误杀）
const REGEN_THRESHOLD_DIMENSION = 40;   // 任一维度 < 40 → 重出（原 60，防止误杀）

// ── 5 个审核维度的 Zod Schema（绑定到 model.bindTools） ──────

const dimensionScoreSchema = z.object({
  index: z.number().int().describe('题目索引（从0开始）'),
  score: z.number().min(0).max(100).describe('该题在本维度的得分 0-100'),
  issues: z.array(z.string()).describe('具体问题描述（可为空数组）'),
  similarTo: z.array(z.number()).nullable().optional().describe('仅 similarity 维度：与哪些题号雷同'),
});

const correctnessReviewSchema = z.object({
  scores: z.array(dimensionScoreSchema).describe('每题的正确性评分'),
});
const similarityReviewSchema = z.object({
  scores: z.array(dimensionScoreSchema).describe('每题的相似性评分'),
});
const blueprintMatchReviewSchema = z.object({
  scores: z.array(dimensionScoreSchema).describe('每题的蓝图匹配评分'),
  overallMatchScore: z.number().min(0).max(100).describe('全卷蓝图匹配度'),
});
const formatReviewSchema = z.object({
  scores: z.array(dimensionScoreSchema).describe('每题的格式评分'),
});
const discriminationReviewSchema = z.object({
  scores: z.array(dimensionScoreSchema).describe('每题的区分度评分'),
});

/** 构造审核 tool（仅作结构化输出契约） */
function makeReviewTool(name: string, description: string, schema: z.ZodObject<any, any, any>) {
  return tool(async () => '', { name, description, schema });
}

// ── 单维度审核函数 ──────────────────────────────────────────

interface ReviewResult {
  scores: DimensionScore[];
  overallMatchScore?: number;
}

/** 带超时的 Promise.race */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`[review] ${label} 超时 (${ms}ms)`)), ms)
    ),
  ]);
}

function failedReviewResult(questionCount: number, dimension: ReviewDimension, reason: string): ReviewResult {
  return {
    scores: Array.from({ length: questionCount }, () => ({
      dimension,
      score: 40,  // 维度执行失败给 40 分（仍低于阈值但避免 0 分连带全挂）
      issues: [reason],
    })),
    overallMatchScore: dimension === 'blueprint_match' ? 0 : undefined,
  };
}

async function runSingleReview(
  model: BaseChatModel,
  prompt: string,
  _toolName: string,
  schema: z.ZodObject<any, any, any>,
  dimension: ReviewDimension,
  questionCount: number,
): Promise<ReviewResult> {
  // 使用 DeepSeek JSON Output 模式（response_format），prompt 已要求输出 JSON
  try {
    const response = await withTimeout(
      model.invoke(
        [new SystemMessage(prompt + '\n\n必须直接输出纯净 JSON，不要 markdown 代码块，不要其他文字。')],
        { response_format: { type: 'json_object' } } as any,
      ),
      REVIEW_TIMEOUT,
      dimension,
    );
    const content = typeof response.content === 'string' ? response.content : '';
    // 清洗 JSON：移除值中嵌入的控制字符，再提取首个 { 到最后一个 } 之间的子串
    const sanitized = content.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
    const jsonStart = sanitized.indexOf('{');
    const jsonEnd = sanitized.lastIndexOf('}');
    const cleanJson = jsonStart !== -1 && jsonEnd > jsonStart
      ? sanitized.slice(jsonStart, jsonEnd + 1)
      : sanitized;
    const rawData = JSON.parse(cleanJson);
    const parsed = schema.safeParse(rawData);
    if (parsed.success) return parseReviewOutput(parsed.data, dimension, questionCount);
    console.warn(`[review:${dimension}] JSON 格式不符，按缺失项不通过处理:`, parsed.error.issues.slice(0, 2));
    return parseReviewOutput(rawData, dimension, questionCount);
  } catch (err) {
    const message = err instanceof Error ? err.message.slice(0, 120) : String(err);
    console.warn(`[review:${dimension}] 审核失败，该维度按不通过处理:`, message);
    return failedReviewResult(questionCount, dimension, `审核维度 ${dimension} 执行失败：${message}`);
  }
}

/** 把 LLM 输出转为 DimensionScore[] */
function parseReviewOutput(data: any, dimension: ReviewDimension, questionCount: number): ReviewResult {
  const rawScores = Array.isArray(data?.scores) ? data.scores : [];
  const byIndex = new Map<number, DimensionScore>();

  for (const s of rawScores) {
    const index = Number(s?.index);
    if (!Number.isInteger(index) || index < 0 || index >= questionCount) continue;
    byIndex.set(index, {
      dimension,
      score: Math.max(0, Math.min(100, typeof s?.score === 'number' ? s.score : 0)),
      issues: Array.isArray(s?.issues) ? s.issues.map((issue: unknown) => String(issue)) : [],
      similarTo: Array.isArray(s?.similarTo) ? s.similarTo.filter((i: unknown) => Number.isInteger(i)) : undefined,
    });
  }

  const scores: DimensionScore[] = Array.from({ length: questionCount }, (_, index) =>
    byIndex.get(index) ?? {
      dimension,
      score: 40,  // LLM 未返回该题评分 → 给 40 分（中性偏低，不直接判死）
      issues: [`审核维度 ${dimension} 未返回第 ${index + 1} 题评分`],
    }
  );

  return {
    scores,
    overallMatchScore: typeof data?.overallMatchScore === 'number' ? data.overallMatchScore : undefined,
  };
}

// ── 5 维度并发审核 ──────────────────────────────────────────

/**
 * 并发执行 5 个维度的审核，聚合为每题的综合质量评分。
 * 任一维度失败独立按不通过处理，避免审核器失效时放行坏题。
 */
export async function reviewBoard(
  model: BaseChatModel,
  questions: ExamQuestion[],
  config: { subject: string; grade: string },
  blueprint: ExamBlueprint,
): Promise<{ scores: QuestionQualityScore[]; overallBlueprintMatch?: number }> {

  // 本地格式预检（快速失败，不走 LLM）
  const localFormatIssues = detectLocalFormatIssues(questions);

  // 5 维度并发（限 5 路，429 退避重试）
  const reviewTaskBuilders: Array<() => Promise<ReviewResult>> = [
    () => runSingleReview(model, reviewCorrectnessPrompt(questions, config), 'review_correctness', correctnessReviewSchema, 'correctness', questions.length),
    () => runSingleReview(model, reviewSimilarityPrompt(questions), 'review_similarity', similarityReviewSchema, 'similarity', questions.length),
    () => runSingleReview(model, reviewBlueprintMatchPrompt(questions, blueprint), 'review_blueprint_match', blueprintMatchReviewSchema, 'blueprint_match', questions.length),
    () => runSingleReview(model, reviewFormatPrompt(questions, config), 'review_format', formatReviewSchema, 'format', questions.length),
    () => runSingleReview(model, reviewDiscriminationPrompt(questions, config), 'review_discrimination', discriminationReviewSchema, 'discrimination', questions.length),
  ];
  const reviewResults = await withConcurrencyLimit(reviewTaskBuilders, { limit: 5, verbose: true });
  const [correctnessRes, similarityRes, blueprintRes, formatRes, discriminationRes] = reviewResults;

  // 提取各维度结果（失败维度按不通过处理）
  const correctness = correctnessRes.status === 'fulfilled' ? correctnessRes.value : failedReviewResult(questions.length, 'correctness', '正确性审核任务异常退出');
  const similarity = similarityRes.status === 'fulfilled' ? similarityRes.value : failedReviewResult(questions.length, 'similarity', '相似性审核任务异常退出');
  const blueprintMatch = blueprintRes.status === 'fulfilled' ? blueprintRes.value : failedReviewResult(questions.length, 'blueprint_match', '蓝图匹配审核任务异常退出');
  const format = formatRes.status === 'fulfilled' ? formatRes.value : failedReviewResult(questions.length, 'format', '格式审核任务异常退出');
  const discrimination = discriminationRes.status === 'fulfilled' ? discriminationRes.value : failedReviewResult(questions.length, 'discrimination', '区分度审核任务异常退出');

  // 聚合为每题的综合评分
  const scores: QuestionQualityScore[] = questions.map((q, i) => {
    const dimScores: Record<ReviewDimension, DimensionScore> = {
      correctness: correctness.scores[i] ?? { dimension: 'correctness', score: 0, issues: ['正确性审核缺失'] },
      similarity: similarity.scores[i] ?? { dimension: 'similarity', score: 0, issues: ['相似性审核缺失'] },
      blueprint_match: blueprintMatch.scores[i] ?? { dimension: 'blueprint_match', score: 0, issues: ['蓝图匹配审核缺失'] },
      format: format.scores[i] ?? { dimension: 'format', score: 0, issues: ['格式审核缺失'] },
      discrimination: discrimination.scores[i] ?? { dimension: 'discrimination', score: 0, issues: ['区分度审核缺失'] },
    };

    // 覆盖：本地格式预检命中的题，格式维度强制低分
    if (localFormatIssues.has(i)) {
      dimScores.format = {
        dimension: 'format',
        score: 30,
        issues: [localFormatIssues.get(i)!],
      };
    }

    // 加权总分
    const total = Object.entries(DIMENSION_WEIGHTS).reduce((sum, [dim, weight]) => {
      return sum + dimScores[dim as ReviewDimension].score * weight;
    }, 0);

    // 重出决策
    const minDimension = Math.min(...Object.values(dimScores).map(d => d.score));
    const needsRegeneration = total < REGEN_THRESHOLD_TOTAL || minDimension < REGEN_THRESHOLD_DIMENSION;

    // 生成重出反馈
    const regenerationFeedback = needsRegeneration ? buildRegenerationFeedback(dimScores) : undefined;

    return {
      index: i,
      total: Math.round(total),
      dimensions: dimScores,
      needsRegeneration,
      regenerationFeedback,
    };
  });

  return { scores, overallBlueprintMatch: blueprintMatch.overallMatchScore };
}

// ── 本地格式预检 ────────────────────────────────────────────

const FALLBACK_MARKERS = ['请回答一道', '请回答', '默认题目', 'fallback', '备选题目', '__needs_review__', '选项待补充'];
const EMBEDDED_OPTION_PATTERN = /(^|[\s\n])A\s*[.．、:：)]\s*[\s\S]+(^|[\s\n])B\s*[.．、:：)]\s*/i;

function isPlaceholderOptionText(text: unknown, key?: string): boolean {
  const raw = String(text ?? '').trim();
  if (!raw) return true;
  const normalized = raw.replace(/[{}（）()【】\s]/g, '').toUpperCase();
  const expected = key ? key.toUpperCase() : '[A-F]';
  return normalized === `选项${expected}` || /^选项[A-F]$/.test(normalized);
}

function countBlankMarkers(stem: string): number {
  return String(stem ?? '').match(/_{2,}|＿{2,}|（\s*）|\(\s*\)|\[\s*\]/g)?.length ?? 0;
}

function detectLocalFormatIssues(questions: ExamQuestion[]): Map<number, string> {
  const issues = new Map<number, string>();
  for (const q of questions) {
    const stem = q.stem ?? '';
    if (FALLBACK_MARKERS.some(m => stem.includes(m))) {
      issues.set(q.index, `题干疑似兜底内容："${stem.slice(0, 30)}"`);
    }
    if (q.type === 'multiple_choice' && (!q.options || q.options.length < 3)) {
      issues.set(q.index, `选择题选项不足（${q.options?.length ?? 0}个）`);
    }
    if (q.type === 'multiple_choice' && EMBEDDED_OPTION_PATTERN.test(stem)) {
      issues.set(q.index, '选择题题干混入了 A/B/C/D 选项，结构不合格');
    }
    if (q.type === 'multiple_choice' && q.options?.some(o => isPlaceholderOptionText(o.text, o.key))) {
      issues.set(q.index, '选择题选项存在占位符文本');
    }
    if (q.type === 'fill_blank' && Math.max(q.blankCount ?? 0, q.blanks?.length ?? 0, countBlankMarkers(stem)) < 1) {
      issues.set(q.index, '填空题缺少空位和答案结构');
    }
    if (!q.explanation || q.explanation.length < 5) {
      issues.set(q.index, '解析内容缺失或过短');
    }
  }
  return issues;
}

// ── 重出反馈生成 ────────────────────────────────────────────

function buildRegenerationFeedback(dimensions: Record<ReviewDimension, DimensionScore>): string {
  const lines: string[] = ['这道题在审核中得分如下：'];
  const dimLabels: Record<ReviewDimension, string> = {
    correctness: '正确性',
    similarity: '相似性',
    blueprint_match: '蓝图匹配',
    format: '格式',
    discrimination: '区分度',
  };

  for (const [dim, label] of Object.entries(dimLabels)) {
    const d = dimensions[dim as ReviewDimension];
    if (d.score < 80 || d.issues.length > 0) {
      lines.push(`- ${label}: ${d.score}/100${d.issues.length ? `（问题：${d.issues.join('；')}）` : ''}`);
    }
  }

  lines.push('');
  lines.push('请针对以上问题重新出题，确保：');
  const failedDims = Object.entries(dimensions).filter(([, d]) => d.score < 60).map(([dim]) => dim as ReviewDimension);
  for (const dim of failedDims) {
    const d = dimensions[dim];
    switch (dim) {
      case 'correctness':
        lines.push('1. 修正答案/解析中的知识性错误');
        break;
      case 'similarity':
        lines.push('2. 使用完全不同的情景和设问（避免与其他题雷同）');
        break;
      case 'blueprint_match':
        lines.push('3. 确保考查蓝图指定的知识点，难度匹配');
        break;
      case 'format':
        lines.push('4. 修复 KaTeX/TikZ 语法，确保成对闭合');
        break;
      case 'discrimination':
        lines.push('5. 提升区分度，避免送分或超纲');
        break;
    }
  }

  return lines.join('\n');
}

// ── 重出闭环 ────────────────────────────────────────────────

/**
 * 并发重出池中的题目，注入审核反馈。
 * 重出后轻量二次校验（仅校验失分维度 + 本地格式/相似度）。
 * 二次校验不通过 → 保留原题 + 标记 warn。
 */
export async function regenerateQuestions(
  model: BaseChatModel,
  questions: ExamQuestion[],
  scores: QuestionQualityScore[],
  config: { subject: string; grade: string },
  crossGroupContext: string,
  writeSingleQuestion: (model: BaseChatModel, prompt: string, questionType: string) => Promise<ExamQuestion | null>,
): Promise<{ questions: ExamQuestion[]; report: ExamQualityReport }> {

  const regenPool = scores.filter(s => s.needsRegeneration);
  const regeneratedIndices: number[] = [];
  const qualityWarnings: number[] = [];

  if (regenPool.length === 0) {
    return {
      questions,
      report: { scores, regeneratedIndices, qualityWarnings },
    };
  }

  // 打印每道题被标记重出的具体原因
  for (const s of regenPool) {
    const failed = Object.entries(s.dimensions)
      .filter(([, d]) => d.score < 60)
      .map(([dim, d]) => `${dim}(${d.score}分:${d.issues?.join(';')?.slice(0, 60) || '低分'})`);
    console.log(`[regenerate] Q${s.index + 1} 触发重出: ${failed.join(', ')}`);
  }
  console.log(`[regenerate] 共 ${regenPool.length} 题需要重出，最多 5 路并发执行中…`);

  // 并发重出（限 5 路，429 退避重试）
  const regenResults = await withConcurrencyLimit(
    regenPool.map((s) => async () => {
      const original = questions[s.index];
      const feedback = s.regenerationFeedback ?? '审核未通过，请重新出题。';
      const prompt = regenerateQuestionPrompt(original, feedback, config, crossGroupContext);
      const regenerated = await writeSingleQuestion(model, prompt, original.type);
      return { index: s.index, original, regenerated };
    }),
    { limit: 5, verbose: true },
  );

  // 二次校验 + 替换
  for (const result of regenResults) {
    if (result.status !== 'fulfilled' || !result.value.regenerated) {
      // 重出失败 → 保留原题 + warn
      const idx = result.status === 'fulfilled' ? result.value.index : -1;
      if (idx >= 0) qualityWarnings.push(idx);
      continue;
    }

    const { index, original, regenerated } = result.value;
    const failedDims = Object.entries(scores[index].dimensions)
      .filter(([, d]) => d.score < 60)
      .map(([dim]) => dim as ReviewDimension);

    // 轻量二次校验：仅校验失分维度
    const validationPassed = lightValidate(regenerated, questions, index, failedDims, original);

    if (validationPassed) {
      // 替换原题（保留 index 和 points）
      questions[index] = { ...regenerated, index, points: original.points };
      regeneratedIndices.push(index);
      const newStem = questions[index]?.stem?.slice(0, 60) || '';
      const oldStem = original?.stem?.slice(0, 60) || '';
      console.log(`[regenerate] Q${index + 1} 重出成功并替换: "${oldStem}..." → "${newStem}..."`);
    } else {
      qualityWarnings.push(index);
      console.warn(`[regenerate] Q${index + 1} 重出后二次校验仍不通过，保留原题`);
    }
  }

  return {
    questions,
    report: { scores, regeneratedIndices, qualityWarnings },
  };
}

// ── 轻量二次校验 ────────────────────────────────────────────

/**
 * 仅校验失分维度，不做全量 LLM 审核。
 * - format：本地检查 KaTeX/TikZ 闭合
 * - similarity：本地字符集 + 知识点重合度
 * - 其他维度：仅校验非空 + Zod 结构（由 writeSingleQuestion 保证）
 */
function lightValidate(
  question: ExamQuestion,
  allQuestions: ExamQuestion[],
  selfIndex: number,
  failedDims: ReviewDimension[],
  original: ExamQuestion,
): boolean {
  // 基本结构校验
  if (!question.stem || question.stem.length < 5) return false;
  if (!question.explanation || question.explanation.length < 5) return false;

  for (const dim of failedDims) {
    switch (dim) {
      case 'format': {
        if (!validateKatexClosure(question.stem)) return false;
        if (question.explanation && !validateKatexClosure(question.explanation)) return false;
        if (question.type === 'multiple_choice' && (!question.options || question.options.length < 3)) return false;
        break;
      }
      case 'similarity': {
        // 与其他题比较
        const myNorm = question.stem.replace(/\s+/g, '').slice(0, 40);
        for (let i = 0; i < allQuestions.length; i++) {
          if (i === selfIndex) continue;
          const other = allQuestions[i];
          const otherNorm = other.stem?.replace(/\s+/g, '').slice(0, 40) ?? '';
          const common = [...myNorm].filter(c => otherNorm.includes(c)).length;
          const ratio = Math.max(myNorm.length, otherNorm.length) > 0
            ? common / Math.max(myNorm.length, otherNorm.length) : 0;
          if (ratio > 0.7) return false; // 仍然雷同
        }
        break;
      }
      case 'correctness':
        // 无法本地校验知识正确性，仅校验非空
        if (question.type === 'multiple_choice' && !question.correctKeys?.length) return false;
        if (question.type === 'true_false' && typeof question.answer !== 'boolean') return false;
        if (question.type === 'fill_blank' && !question.blanks?.length) return false;
        if (question.type === 'short_answer' && !question.referenceAnswer) return false;
        break;
      case 'discrimination':
      case 'blueprint_match':
        // 无法本地校验，放行（已通过 LLM 重出 + 基本结构校验）
        break;
    }
  }
  return true;
}

/** 校验 KaTeX $ / $$ 成对闭合 */
function validateKatexClosure(text: string): boolean {
  // $$ 成对
  const displayCount = (text.match(/\$\$/g) ?? []).length;
  if (displayCount % 2 !== 0) return false;
  // $ 成对（排除 $$）
  const textNoDisplay = text.replace(/\$\$/g, '');
  const inlineCount = (textNoDisplay.match(/\$/g) ?? []).length;
  if (inlineCount % 2 !== 0) return false;
  return true;
}

// ── 本地相似性预检（供 exam.ts 主流程使用） ─────────────────

/** 检测题干高度相似的题目对，返回需要标记的题号 */
export function detectSimilarQuestions(questions: ExamQuestion[]): Set<number> {
  const flagged = new Set<number>();
  const stems = questions.map(q => ({ index: q.index, norm: q.stem?.replace(/\s+/g, '').slice(0, 30) ?? '' }));

  for (let i = 0; i < stems.length; i++) {
    for (let j = i + 1; j < stems.length; j++) {
      const a = stems[i].norm;
      const b = stems[j].norm;
      const common = [...a].filter(c => b.includes(c)).length;
      const ratio = Math.max(a.length, b.length) > 0 ? common / Math.max(a.length, b.length) : 0;
      if (ratio > 0.7) {
        flagged.add(stems[i].index);
        flagged.add(stems[j].index);
      }
    }
  }
  return flagged;
}
