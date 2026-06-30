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
import { SystemMessage, HumanMessage } from '@langchain/core/messages';
import { z } from 'zod';
import type { ExamQuestion, ExamResults, AnswerPayload, ExamQuestionResult, ExamSummary, ExamBlueprint, ExamQualityReport } from '@boen/shared';
import { gradeAnswer, multipleChoiceSchema, fillBlankSchema, trueFalseSchema, shortAnswerSchema, fuzzyMatchBlankDetailed } from '@boen/agent-core';
import type { ShortAnswerGrader } from '@boen/agent-core';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { getWeightDistribution, WEIGHT_TIERS } from './kg-weights.js';
import { updateProficiency, getWeakPoints, getRecommendedKPs, getProfileOutline } from './knowledge-profile.js';
import { earnPoints, computeScorePoints, computeStarBonus } from './currency.js';
import db from './db.js';
import { retrieveCurriculum } from './curriculum.js';
import { retrieveGlobalStyleSkills } from './mistakes.js';
import { embedTexts, cosineSim } from './embeddings.js';
import { withConcurrencyLimit, Semaphore } from './concurrency.js';
import { stepBlueprintArchitect, flattenBlueprint, type WriteTask } from './exam-blueprint.js';
import { reviewBoard, regenerateQuestions } from './exam-reviewers.js';
import { questionWriterPrompt } from './exam-prompts.js';
import { canonicalizeStoredQuestionTaxonomy, getPublishedKnowledgePointIds, resolveQuestionTaxonomy, type QuestionTaxonomy } from './question-taxonomy.js';

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
  blueprint?: ExamBlueprint;
  qualityReport?: ExamQualityReport;
}

export interface GeneratedExam {
  title: string;
  questions: ExamQuestion[];
  totalScore: number;
  durationMinutes: number;
  blueprint: ExamBlueprint;
  qualityReport: ExamQualityReport;
}

/** 进度回调：每步执行时通知前端（可返回 Promise 以保证 SSE 写入有序） */
export interface ExamProgress {
  step: 'blueprint' | 'write' | 'review' | 'regenerate' | 'analyze' | 'complete';
  message: string;
  progress?: number; // 0-100
}
export type ExamProgressFn = (p: ExamProgress) => void | Promise<void>;

export interface ExamGradingProgress {
  step: 'grade' | 'analyze' | 'profile' | 'save' | 'complete';
  message: string;
  progress: number;
}
export type ExamGradingProgressFn = (p: ExamGradingProgress) => void | Promise<void>;

// ── 通用加固工具 ──────────────────────────

/** 把 AI 可能返回的字符串格式 literacies 归一化为数组 */
function normalizeLiteracies(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((l): l is string => typeof l === 'string');
  if (typeof raw === 'string') return raw.split(/[,，、\s]+/).filter(Boolean);
  return [];
}

/**
 * A blueprint may be proposed by an LLM, but all of its learner-visible
 * taxonomy must be projected onto published graph nodes before it can enter
 * the writing pipeline.  Unknown names/IDs are a production error, not a
 * reason to retain a model-authored label.
 */
function canonicalizeExamBlueprint(blueprint: ExamBlueprint, config: ExamConfig): ExamBlueprint {
  const publishedIds = getPublishedKnowledgePointIds(config.subject, config.grade);
  if (publishedIds.length === 0) {
    throw new Error(`${config.subject} G${config.grade} 没有已发布知识点，不能生成考试`);
  }

  const resolve = (candidate: { id?: unknown; title?: unknown }): QuestionTaxonomy | null =>
    resolveQuestionTaxonomy({
      subject: config.subject,
      grade: config.grade,
      knowledgePointId: candidate.id,
      knowledgePointTitle: candidate.title,
      allowedKnowledgePointIds: publishedIds,
    });
  const resolveName = (value: string): string | null => resolve({ title: value })?.knowledgePoint ?? null;

  const sections = blueprint.sections.map((section, sectionIndex) => {
    const knowledgePoints = section.knowledgePoints.map((candidate) => {
      const taxonomy = resolve(candidate);
      if (!taxonomy) {
        throw new Error(`蓝图第 ${sectionIndex + 1} 个板块引用了未发布知识点：${candidate.title || candidate.id || '空值'}`);
      }
      return {
        id: taxonomy.knowledgePointId,
        title: taxonomy.knowledgePoint,
        weight: Number.isFinite(candidate.weight) && candidate.weight > 0 ? candidate.weight : 1,
      };
    });
    if (!knowledgePoints.length) throw new Error(`蓝图第 ${sectionIndex + 1} 个板块没有有效知识点`);

    return {
      ...section,
      knowledgePoints,
      questionTypes: section.questionTypes.map((plan) => {
        const focusKps = [...new Set(plan.focusKps.map(resolveName).filter((name): name is string => Boolean(name)))];
        return { ...plan, focusKps: focusKps.length ? focusKps : [knowledgePoints[0].title] };
      }),
    };
  });

  const canonicalNames = (values: string[] | undefined): string[] =>
    [...new Set((values ?? []).map(resolveName).filter((name): name is string => Boolean(name)))];
  const coveragePlan = {
    must: canonicalNames(blueprint.coveragePlan?.must),
    focus: canonicalNames(blueprint.coveragePlan?.focus),
    ...(blueprint.coveragePlan?.stretch ? { stretch: canonicalNames(blueprint.coveragePlan.stretch) } : {}),
  };

  return { ...blueprint, sections, coveragePlan };
}

const TYPE_LABELS: Record<string, string> = { multiple_choice: '选择题', fill_blank: '填空题', true_false: '判断题', short_answer: '简答题' };

const OPTION_KEYS = ['A', 'B', 'C', 'D', 'E', 'F'];
const QUESTION_TYPE_ORDER: Record<string, number> = {
  multiple_choice: 0,
  true_false: 1,
  fill_blank: 2,
  short_answer: 3,
};

function cleanGeneratedText(raw: unknown): string {
  let text = String(raw ?? '');
  if (!text) return '';

  text = text
    .replace(/&lt;\s*\/?\s*u\s*&gt;/gi, '')
    .replace(/&lt;\s*br\s*\/?\s*&gt;/gi, '\n')
    .replace(/([A-Za-z0-9\u4e00-\u9fff])\s*<\s*\/\s*u\s*>\s*\1\s*<\s*\/\s*u\s*>/gi, '$1')
    .replace(/([A-Za-z0-9\u4e00-\u9fff])\s*<\s*\/\s*u\s*>\s*\1\b/gi, '$1')
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\s*\/?\s*u\s*>/gi, '')
    .replace(/<\s*\/?\s*(?:span|font|div|p|strong|em|b|i)\b[^<>]*>/gi, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return text;
}

/**
 * 出题后立即校准确保 sum(question.points) === 蓝图目标总分。
 * 蓝图阶段的 validateAndFixBlueprint + tuneCountsToTarget 已保证 count × pointsPer = target，
 * 但 toExamQuestion 固定取 task.pointsPer，理论上不会偏差。
 * 此函数是防御性兜底：若有偏差则均匀分配到各题，避免带着错误进入审核。
 */
function calibratePointsToBlueprint(questions: ExamQuestion[], blueprint: ExamBlueprint): ExamQuestion[] {
  if (questions.length === 0) return questions;

  const blueprintTotal = blueprint.totalScore;
  let actualTotal = questions.reduce((s, q) => s + q.points, 0);

  if (actualTotal === blueprintTotal) {
    console.log(`[exam] 写题后总分校验：${actualTotal} = ${blueprintTotal} ✓`);
    return questions;
  }

  const diff = blueprintTotal - actualTotal;
  console.warn(`[exam] 写题后总分校验：${actualTotal} → ${blueprintTotal}（${diff > 0 ? '补' : '减'}${Math.abs(diff)}分）`);

  // 均匀分配差值，每题最多调整 ±5 分，从后往前分配（高分题优先吸收）
  let remaining = diff;
  const maxPerQ = 5;

  while (remaining !== 0) {
    let changed = false;
    const step = remaining > 0 ? 1 : -1;
    // 加点从后往前（高分题优先），减分从前往后（低分题优先保底线）
    const startIdx = remaining > 0 ? questions.length - 1 : 0;
    const direction = remaining > 0 ? -1 : 1;

    for (let i = startIdx; i >= 0 && i < questions.length; i += direction) {
      if (remaining === 0) break;
      const q = questions[i];
      const adjust = Math.min(Math.abs(remaining), maxPerQ) * step;
      const newPts = q.points + adjust;
      if (newPts >= 1) {
        q.points = newPts;
        remaining -= adjust;
        changed = true;
      }
    }

    if (!changed && remaining !== 0) {
      // 放宽限制：无上限吸收
      for (let i = questions.length - 1; i >= 0 && remaining !== 0; i--) {
        const q = questions[i];
        if (remaining > 0) {
          q.points += remaining;
          remaining = 0;
        } else if (remaining < 0 && q.points > 1) {
          const canReduce = q.points - 1;
          const reduce = Math.min(canReduce, Math.abs(remaining));
          q.points -= reduce;
          remaining += reduce;
        }
      }
      if (remaining !== 0) {
        console.error(`[exam] ⚠ 写题后总分校验失败：仍差 ${remaining} 分`);
        break;
      }
    }
  }

  actualTotal = questions.reduce((s, q) => s + q.points, 0);
  if (actualTotal !== blueprintTotal) {
    console.error(`[exam] ❌ 写题后总分校验异常：${actualTotal} ≠ ${blueprintTotal}，强制修正最后一题`);
    questions[questions.length - 1].points += (blueprintTotal - actualTotal);
  }
  return questions;
}

function orderExamQuestionsForDelivery(questions: ExamQuestion[]): ExamQuestion[] {
  const grouped = new Map<string, { order: number; typeOrder: number; questions: ExamQuestion[] }>();
  questions.forEach((q, originalOrder) => {
    const key = q.groupId === undefined ? `q:${originalOrder}` : `g:${q.groupId}`;
    const typeOrder = QUESTION_TYPE_ORDER[q.type] ?? 99;
    const group = grouped.get(key);
    if (group) {
      group.typeOrder = Math.min(group.typeOrder, typeOrder);
      group.questions.push(q);
    } else {
      grouped.set(key, { order: originalOrder, typeOrder, questions: [q] });
    }
  });

  return [...grouped.values()]
    .sort((a, b) => a.typeOrder - b.typeOrder || a.order - b.order)
    .flatMap((group) => group.questions)
    .map((q, i) => localFormatFix(q, i));
}

function stripOptionPrefix(text: string, key?: string): string {
  const k = key ? key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '[A-Fa-f]';
  return cleanGeneratedText(text).replace(new RegExp(`^(?:选项\\s*)?${k}\\s*[.．、:：)]\\s*`, 'i'), '').trim();
}

function isPlaceholderOptionText(text: unknown, key?: string): boolean {
  const raw = String(text ?? '').trim();
  if (!raw) return true;
  const normalized = raw.replace(/[{}（）()【】\s]/g, '').toUpperCase();
  const expected = key ? key.toUpperCase() : '[A-F]';
  // 只过滤明确的占位符模式，不拦截文本恰好是 key 字母的正常选项
  return normalized === `选项${expected}` || /^选项[A-F]$/.test(normalized);
}

function extractOptionsFromStem(stem: string): { stem: string; options: { key: string; text: string }[] } {
  const source = String(stem ?? '').replace(/\r\n/g, '\n');
  const marker = /(^|[\s\n])([A-Fa-f])\s*[.．、:：)]\s*/g;
  const matches = [...source.matchAll(marker)]
    .filter((m) => m.index !== undefined)
    .map((m) => ({
      key: m[2].toUpperCase(),
      start: m.index! + m[1].length,
      contentStart: m.index! + m[0].length,
    }));

  if (matches.length < 2) return { stem: source.trim(), options: [] };

  const valid = matches.filter((m, i) => OPTION_KEYS[i] === m.key || OPTION_KEYS.includes(m.key));
  if (valid.length < 2) return { stem: source.trim(), options: [] };

  const first = valid[0];
  const options = valid.map((m, i) => {
    const next = valid[i + 1];
    return {
      key: m.key,
      text: source.slice(m.contentStart, next ? next.start : source.length).trim(),
    };
  }).filter((o) => o.text.length > 0);

  return {
    stem: source.slice(0, first.start).trim(),
    options,
  };
}

function normalizeOptions(stem: string, rawOptions: unknown): { stem: string; options: { key: string; text: string }[] } {
  const cleanedStem = cleanGeneratedText(stem);
  const extracted = extractOptionsFromStem(cleanedStem);
  const raw = Array.isArray(rawOptions) ? rawOptions : [];

  // 先处理原始选项（清洗前缀 + 过滤占位符）
  const cleaned = raw
    .map((o: any, i) => {
      const key = String(o?.key ?? OPTION_KEYS[i] ?? '').trim().toUpperCase();
      const text = stripOptionPrefix(String(o?.text ?? ''), key);
      return { key, text };
    })
    .filter((o) => o.key);

  const valid = cleaned.filter((o) => !isPlaceholderOptionText(o.text, o.key));

  // 超过 2 个有效选项 → 直接用
  if (valid.length >= 2) return { stem: cleanedStem, options: valid };

  // 原始选项有内容但全被占位符过滤 → 回退到清洗后的（保留模型本意）
  if (cleaned.length >= 2) {
    console.warn('[normalizeOptions] 选项文本疑似占位符，保留原始值');
    return { stem: cleanedStem, options: cleaned };
  }

  // 从题干提取
  if (extracted.options.length >= 2) {
    return { stem: extracted.stem || cleanedStem, options: extracted.options };
  }

  return { stem: cleanedStem, options: cleaned };
}

function countBlankMarkers(stem: string): number {
  const matches = String(stem ?? '').match(/_{2,}|＿{2,}|（\s*）|\(\s*\)|\[\s*\]/g);
  return matches?.length ?? 0;
}

function normalizeBlanks(raw: any, stem: string): { blanks: { acceptedAnswers: string[] }[]; blankCount: number } {
  const rawBlanks = Array.isArray(raw?.blanks) ? raw.blanks : [];
  const blanks = rawBlanks.map((b: any) => {
    const answers = Array.isArray(b?.acceptedAnswers)
      ? b.acceptedAnswers.map((a: unknown) => String(a ?? ''))
      : [String(b?.acceptedAnswer ?? b?.answer ?? '')];
    return { acceptedAnswers: answers.length ? answers : [''] };
  });

  const markerCount = countBlankMarkers(stem);
  const declaredCount = Number(raw?.blankCount ?? raw?.blank_count ?? 0);
  const blankCount = Math.max(markerCount, blanks.length, Number.isFinite(declaredCount) ? declaredCount : 0, 1);

  while (blanks.length < blankCount) blanks.push({ acceptedAnswers: [''] });
  return { blanks, blankCount };
}

function choiceWithoutOptionsToShortAnswer(q: ExamQuestion): ExamQuestion {
  // 不再转换为简答题——保持选择题类型，由审核阶段标记重出。
  // 临时用原始选项或兜底选项保持结构完整。
  const options = (q.options?.length ?? 0) >= 2
    ? q.options!
    : [{ key: 'A', text: '（选项待补充）' }, { key: 'B', text: '（选项待补充）' }];
  return {
    ...q,
    options,
    correctKeys: q.correctKeys?.length ? q.correctKeys.filter(k => options.some(o => o.key === k)) : [options[0].key],
    multiSelect: q.multiSelect ?? false,
    explanation: q.explanation || '本题选项结构不完整，将在审核阶段修正。',
  };
}

/** 本地格式兜底：补齐必填字段、修复残缺选项 */
function localFormatFix(q: ExamQuestion, i: number): ExamQuestion {
  let q2 = { ...q, index: i };
  q2.stem = cleanGeneratedText(q2.stem);
  q2.passage = q2.passage ? cleanGeneratedText(q2.passage) : undefined;
  q2.explanation = cleanGeneratedText(q2.explanation);
  q2.referenceAnswer = q2.referenceAnswer ? cleanGeneratedText(q2.referenceAnswer) : undefined;
  q2.keyPoints = q2.keyPoints?.map(cleanGeneratedText).filter(Boolean);
  q2.options = q2.options?.map((o) => ({ ...o, text: cleanGeneratedText(o.text) }));
  q2.blanks = q2.blanks?.map((blank) => ({
    acceptedAnswers: blank.acceptedAnswers.map(cleanGeneratedText),
  }));
  if (q2.type === 'multiple_choice') {
    const normalized = normalizeOptions(q2.stem ?? '', q2.options);
    q2.stem = normalized.stem || q2.stem;
    q2.options = normalized.options;
    if (!q2.options || q2.options.length < 2) {
      return localFormatFix(choiceWithoutOptionsToShortAnswer(q2), i);
    }
    if (!q2.correctKeys?.length) q2.correctKeys = [q2.options[0].key];
    q2.correctKeys = q2.correctKeys.filter((k) => q2.options!.some((o) => o.key === k));
    if (!q2.correctKeys.length) q2.correctKeys = [q2.options[0].key];
  }
  if (q2.type === 'fill_blank') {
    const normalized = normalizeBlanks(q2, q2.stem ?? '');
    q2.blanks = normalized.blanks;
    q2.blankCount = normalized.blankCount;
  }
  if (!q2.explanation) q2.explanation = '详见参考答案。';
  q2.literacies = normalizeLiteracies(q2.literacies);
  return q2;
}

const GENERATED_QUESTION_SCHEMAS: Record<string, z.ZodTypeAny> = {
  multiple_choice: multipleChoiceSchema,
  fill_blank: fillBlankSchema,
  true_false: trueFalseSchema,
  short_answer: shortAnswerSchema,
};

function getGeneratedQuestionSchema(questionType: string): z.ZodTypeAny {
  const schema = GENERATED_QUESTION_SCHEMAS[questionType];
  if (!schema) throw new Error(`不支持的题型: ${questionType}`);
  return schema;
}

function parseJsonObject(content: string): unknown {
  const sanitized = content.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
  const jsonStart = sanitized.indexOf('{');
  const jsonEnd = sanitized.lastIndexOf('}');
  const cleanJson = jsonStart !== -1 && jsonEnd > jsonStart
    ? sanitized.slice(jsonStart, jsonEnd + 1)
    : sanitized;
  return JSON.parse(cleanJson);
}

function parseGeneratedQuestionList(raw: unknown, questionType: string, count: number): any[] {
  const rawQuestions = (raw as any)?.questions ?? (Array.isArray(raw) ? raw : []);
  if (!Array.isArray(rawQuestions)) {
    throw new Error('结构化输出缺少 questions 数组');
  }
  if (rawQuestions.length < count) {
    throw new Error(`结构化输出题量不足：期望 ${count} 道，实际 ${rawQuestions.length} 道`);
  }

  const schema = getGeneratedQuestionSchema(questionType);
  return rawQuestions.slice(0, count).map((q, i) => {
    const parsed = schema.safeParse(q);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new Error(`第 ${i + 1} 道题 schema 不合格：${issue?.path.join('.') || 'root'} ${issue?.message || ''}`.trim());
    }
    return parsed.data;
  });
}

function validateExamQuestionForDelivery(q: ExamQuestion): string | null {
  if (!q.stem || q.stem.trim().length < 5) return '题干过短或缺失';
  if (!q.explanation || q.explanation.trim().length < 5) return '解析过短或缺失';
  if (!Number.isInteger(q.knowledgePointId) || (q.knowledgePointId ?? 0) <= 0) return 'knowledgePointId 缺失';
  if (!q.knowledgePoint || q.knowledgePoint.trim().length === 0) return 'knowledgePoint 缺失';
  if (!normalizeLiteracies(q.literacies).length) return 'literacies 缺失';

  if (q.type === 'multiple_choice') {
    if (!q.options || q.options.length < 3) return `选择题选项不足（${q.options?.length ?? 0} 个）`;
    if (!q.correctKeys?.length) return '选择题正确答案缺失';
    if (q.options.some(o => isPlaceholderOptionText(o.text, o.key))) return '选择题选项存在占位符';
  }
  if (q.type === 'fill_blank') {
    const markerCount = countBlankMarkers(q.stem);
    if (markerCount < 1) return '填空题题干缺少空位标记';
    if (!q.blanks?.length) return '填空题答案结构缺失';
    if (q.blanks.length !== markerCount) return `填空题空位数与答案数不一致（空位 ${markerCount}，答案 ${q.blanks.length}）`;
  }
  if (q.type === 'true_false' && typeof q.answer !== 'boolean') return '判断题 answer 缺失';
  if (q.type === 'short_answer') {
    if (!q.referenceAnswer?.trim() && !(q.keyPoints?.length)) return '简答题缺少 referenceAnswer/keyPoints';
  }
  return null;
}

function normalizeOptionalPassage(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const text = cleanGeneratedText(raw);
  if (!text) return undefined;
  if (/有阅读材料时填写|无则省略|阅读材料时填写|无则省略此字段/.test(text)) return undefined;
  return text;
}

// ── 考试生成（四阶段并发流水线） ──────────────

/** 简易哈希（用于 TikZ 代码块去重） */
function simpleHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h) + s.charCodeAt(i);
    h |= 0;
  }
  return `h${Math.abs(h).toString(36)}`;
}

/** 文本中是否包含 ```tikz 代码块 */
function hasTikzBlocks(text: string): boolean {
  return /```tikz\s*\n?[\s\S]*?```/.test(text ?? '');
}

/** 提取文本中所有 ```tikz ... ``` 代码块 */
function extractTikzBlocks(text: string): Array<{ code: string; start: number; end: number }> {
  const blocks: Array<{ code: string; start: number; end: number }> = [];
  const re = /```tikz\s*\n?([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text ?? '')) !== null) {
    blocks.push({ code: match[1].trim(), start: match.index, end: match.index + match[0].length });
  }
  return blocks;
}

function tikzSourceTexts(q: ExamQuestion): string[] {
  return [
    q.stem,
    q.passage,
    q.explanation,
    q.referenceAnswer,
    ...(q.options ?? []).map((o) => o.text),
  ].filter((text): text is string => typeof text === 'string' && text.length > 0);
}

// ── TikZ 异步渲染（全局最多 3 路并发，避免 xelatex 占满 CPU） ──
const tikzRenderPool = new Semaphore(3);

function execFileAsync(cmd: string, args: string[], options: { timeout: number; cwd?: string }): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { ...options, windowsHide: true, encoding: 'utf-8' }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout ?? '');
    });
  });
}

async function renderTikzBlockAsync(texCode: string): Promise<string | null> {
  return tikzRenderPool.run(async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'tikz-'));
    try {
      const texPath = join(tmpDir, 'tikz.tex');
      const pdfPath = join(tmpDir, 'tikz.pdf');
      const svgPath = join(tmpDir, 'tikz.svg');
      writeFileSync(texPath, `\\documentclass{standalone}\\usepackage{fontspec}\\usepackage{xeCJK}\\setCJKmainfont{Noto Sans CJK SC}\\usepackage{amsmath}\\usepackage{tikz}\\usetikzlibrary{shapes,arrows,positioning,calc,angles,quotes,intersections,through,math,matrix,fit,patterns,decorations.pathmorphing,decorations.pathreplacing}\\usepackage{pgfplots}\\pgfplotsset{compat=1.18}\\usepackage{xlop}\\begin{document}${texCode}\\end{document}`, 'utf-8');
      await execFileAsync('xelatex', ['-no-shell-escape', '-interaction=nonstopmode', `-output-directory=${tmpDir}`, texPath], { timeout: 30000 });
      if (!existsSync(pdfPath)) return null;
      // dvisvgm 短选项 -o 不支持 `=` 语法（-o=path 会把文件名当成「=path」写入失败且仍返回 exit 0），
      // 必须用长选项 --output=path（与 tikz-renderer.ts 的 HTTP 渲染路径保持一致）。
      await execFileAsync('dvisvgm', ['--pdf', '--no-fonts', `--output=${svgPath}`, pdfPath], { timeout: 15000 });
      if (!existsSync(svgPath)) return null;
      return readFileSync(svgPath, 'utf-8') || null;
    } catch (e) {
      console.warn('[exam] TiKZ 渲染失败:', e instanceof Error ? e.message.slice(0, 200) : e);
      return null;
    } finally {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch (e2) { console.warn('[exam] 清理临时目录失败:', e2); }
    }
  });
}

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
  signal?: AbortSignal,
): Promise<GeneratedExam> {
  // 如果 signal 已中断则立即退出
  if (signal?.aborted) throw new DOMException('Exam generation aborted by client', 'AbortError');
  try {
    const weightDist = getWeightDistribution(config.subject, config.grade);
    const mode = (config.durationMinutes ?? 45) <= 15 ? 'quiz' : 'exam';

    // ─── 阶段一：蓝图架构师 ────────────────────
    await onProgress?.({ step: 'blueprint', message: 'blueprint', progress: 4 });
    const weightGuide = buildWeightGuideForPrompt(weightDist);
    const profileContext = userId ? await buildProfileContext(userId, config) : '';
    const scopeQuery = [config.chapters?.join(' '), config.notes].filter(Boolean).join('\n');
    const curriculumContext = await retrieveCurriculum({ subject: config.subject, grade: config.grade, query: scopeQuery }).catch(() => '');
    const styleContext = await retrieveGlobalStyleSkills(config.subject, config.grade, scopeQuery, [], 3).catch(() => '');
    const enrichedConfig: ExamConfig = { ...config, styleContext };

    await onProgress?.({ step: 'blueprint', message: 'blueprint', progress: 10 });
    const rawBlueprint = await stepBlueprintArchitect(
      model,
      { subject: enrichedConfig.subject, grade: enrichedConfig.grade, totalScore: enrichedConfig.totalScore, notes: enrichedConfig.notes },
      weightGuide,
      [curriculumContext, profileContext, styleContext].filter(Boolean).join('\n\n'),
      mode,
    );
    const blueprint = canonicalizeExamBlueprint(rawBlueprint, enrichedConfig);

    await onProgress?.({ step: 'blueprint', message: 'blueprint', progress: 18 });

    // 客户端断开连接 → 尽早退出，避免无效消耗 AI token
    if (signal?.aborted) throw new DOMException('Exam generation aborted by client', 'AbortError');

    // ─── 阶段二：题目编写组（按 section × questionType 并发，限 6 路） ────
    const writeTasks = flattenBlueprint(blueprint);
    await onProgress?.({ step: 'write', message: 'write', progress: 22 });

    let completedGroups = 0;
    const writeResults = await withConcurrencyLimit(
      writeTasks.map((task) => async () => {
        const result = await stepWriteQuestionsV2(model, enrichedConfig, task, blueprint, writeTasks, []);
        completedGroups++;
        await onProgress?.({
          step: 'write',
          message: 'write',
          progress: 22 + Math.round((completedGroups / writeTasks.length) * 42),
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

    // 编号 + 本地格式修复 + 卷面题型顺序硬约束：
    // 选择/判断在前，填空/简答在后；同 groupId 的材料题保持相邻。
    let questions = orderExamQuestionsForDelivery(allQuestions);

    // ─── 写题后总分校验：进入审核前确保 sum(points) === blueprintTotal ────
    questions = calibratePointsToBlueprint(questions, blueprint);

    await onProgress?.({ step: 'write', message: 'write', progress: 66 });

    // 客户端断开 → 停止进入审核阶段
    if (signal?.aborted) throw new DOMException('Exam generation aborted by client', 'AbortError');

    // ─── 阶段三：审核委员会（5 维度并发） ──────
    await onProgress?.({ step: 'review', message: 'review', progress: 70 });
    let { scores } = await reviewBoard(model, questions, { subject: enrichedConfig.subject, grade: enrichedConfig.grade }, blueprint);
    const regeneratedIndices = new Set<number>();
    const qualityWarnings = new Set<number>();

    let regenCount = scores.filter(s => s.needsRegeneration).length;
    await onProgress?.({ step: 'review', message: 'review', progress: 76 });

    const maxRegenerationRounds = 3;
    const regenHistory: number[] = [regenCount]; // 追踪每轮未通过数，用于趋势检测
    for (let round = 1; regenCount > 0 && round <= maxRegenerationRounds; round++) {
      if (signal?.aborted) throw new DOMException('Exam generation aborted by client', 'AbortError');
      await onProgress?.({ step: 'regenerate', message: 'regenerate', progress: Math.min(96, 78 + round * 5) });
      const crossGroupContext = buildCrossGroupContext(questions);
      const regenResult = await regenerateQuestions(
        model,
        questions,
        scores,
        { subject: enrichedConfig.subject, grade: enrichedConfig.grade },
        crossGroupContext,
        (writerModel, prompt, questionType) => writeSingleQuestion(writerModel, prompt, questionType, enrichedConfig),
      );
      questions = orderExamQuestionsForDelivery(regenResult.questions);
      for (const index of regenResult.report.regeneratedIndices) regeneratedIndices.add(index);
      for (const index of regenResult.report.qualityWarnings) qualityWarnings.add(index);

      await onProgress?.({ step: 'review', message: 'review', progress: Math.min(98, 82 + round * 5) });
      const nextReview = await reviewBoard(model, questions, { subject: enrichedConfig.subject, grade: enrichedConfig.grade }, blueprint);
      scores = nextReview.scores;
      regenCount = scores.filter(s => s.needsRegeneration).length;
      regenHistory.push(regenCount);

      if (regenCount > 0) {
        console.warn(`[exam] 第 ${round} 轮重出后仍有 ${regenCount} 题未通过质量审核`);
      }

      // 趋势检测：连续两轮未改善则提前退出，避免无效消耗 token
      if (regenHistory.length >= 3) {
        const prev = regenHistory[regenHistory.length - 2];
        const curr = regenHistory[regenHistory.length - 1];
        if (curr >= prev) {
          console.warn(`[exam] 重出趋势无改善（${prev} → ${curr}），提前退出循环`);
          break;
        }
      }
    }

    const stillFailing = scores.filter(s => s.needsRegeneration);
    for (const s of stillFailing) qualityWarnings.add(s.index);

    // 全局质量门禁：警告题占比 > 30% 时标记整卷质量待确认
    const warningRatio = qualityWarnings.size / Math.max(questions.length, 1);
    if (warningRatio > 0.3) {
      console.warn(`[exam] ⚠ 质量门禁触发：${qualityWarnings.size}/${questions.length} 题（${Math.round(warningRatio * 100)}%）存在质量警告，建议人工复核`);
    }

    const qualityReport: ExamQualityReport = {
      scores,
      regeneratedIndices: [...regeneratedIndices].sort((a, b) => a - b),
      qualityWarnings: [...qualityWarnings].sort((a, b) => a - b),
    };

    if (stillFailing.length > 0) {
      const summary = stillFailing.slice(0, 5).map((s) => {
        const dims = Object.entries(s.dimensions)
          .filter(([, d]) => d.score < 60)
          .map(([dim, d]) => `${dim}:${d.score}`)
          .join(',');
        return `Q${s.index + 1}(${dims || s.total})`;
      }).join('；');
      console.warn(`[exam] 试卷质量终审未完全通过，继续放行并标记风险题：${summary}`);
    }

    if (questions.length === 0) {
      throw new Error('试卷生成失败：没有生成任何有效题目');
    }

    // ─── 严格总分校准：必须精确等于目标分 ────
    let totalScore = questions.reduce((s, q) => s + q.points, 0);
    const targetTotal = enrichedConfig.totalScore ?? blueprint.totalScore;

    if (totalScore !== targetTotal && questions.length > 0) {
      const diff = targetTotal - totalScore;
      console.warn(`[exam] 总分偏差 ${totalScore} → ${targetTotal}（${diff > 0 ? '补' : '减'}${Math.abs(diff)}分），分布式校准`);

      // 第一轮：均匀分配差值，每题最多调整 ±5 分
      let remaining = diff;
      const maxPerQ = 5;

      while (remaining !== 0) {
        let changed = false;
        const step = remaining > 0 ? 1 : -1;
        const startIdx = remaining > 0 ? questions.length - 1 : 0;
        const direction = remaining > 0 ? -1 : 1;

        for (let i = startIdx; i >= 0 && i < questions.length; i += direction) {
          if (remaining === 0) break;
          const q = questions[i];
          const adjust = Math.min(Math.abs(remaining), maxPerQ) * step;
          const newPts = q.points + adjust;

          if (newPts >= 1) {
            q.points = newPts;
            remaining -= adjust;
            changed = true;
          }
        }

        // 第二轮：如果均匀分配不够，放宽限制（每题最低1分，无上限）
        if (!changed && remaining !== 0) {
          // 从最后一题开始，尽可能吸收差值
          for (let i = questions.length - 1; i >= 0 && remaining !== 0; i--) {
            const q = questions[i];
            if (remaining > 0) {
              q.points += remaining;
              remaining = 0;
            } else if (remaining < 0 && q.points > 1) {
              const canReduce = q.points - 1;
              const reduce = Math.min(canReduce, Math.abs(remaining));
              q.points -= reduce;
              remaining += reduce;
            }
          }
        }

        if (!changed && remaining !== 0) {
          console.error(`[exam] ⚠ 总分校准失败：仍差 ${remaining} 分，当前总分 ${questions.reduce((s, q) => s + q.points, 0)}`);
          break; // prevent infinite loop
        }
      }

      totalScore = questions.reduce((s, q) => s + q.points, 0);

      // 最终断言
      if (totalScore !== targetTotal) {
        console.error(`[exam] ❌ 总分校准异常：${totalScore} ≠ ${targetTotal}，强制修正最后一题`);
        const lastQ = questions[questions.length - 1];
        lastQ.points += (targetTotal - totalScore);
        if (lastQ.points < 1) {
          // 最后一题不够减，向前借分
          for (let i = questions.length - 2; i >= 0 && lastQ.points < 1; i--) {
            const borrow = 1 - lastQ.points;
            if (questions[i].points > 1 + borrow) {
              questions[i].points -= borrow;
              lastQ.points += borrow;
            }
          }
        }
        totalScore = questions.reduce((s, q) => s + q.points, 0);
      }
    }
    const estMinutes = enrichedConfig.durationMinutes ?? Math.max(20, Math.min(90, Math.round(questions.length * 1.5)));

    // 客户端断开 → 跳过 TikZ 渲染等耗时后处理
    if (signal?.aborted) throw new DOMException('Exam generation aborted by client', 'AbortError');

    // ─── TikZ 预渲染：异步渲染，全局最多 3 路并发 ────
    {
      const tikzQS = questions.filter(q => tikzSourceTexts(q).some(hasTikzBlocks));
      if (tikzQS.length > 0) {
        await Promise.all(tikzQS.map(async (q) => {
          const svgs: Record<string, string> = {};
          const blocks = tikzSourceTexts(q).flatMap((text) => extractTikzBlocks(text));
          const renderTasks = blocks.map(async (block) => {
            const hash = simpleHash(block.code);
            if (svgs[hash]) return;
            const svg = await renderTikzBlockAsync(block.code);
            if (svg) svgs[hash] = svg;
          });
          await Promise.all(renderTasks);
          if (Object.keys(svgs).length) q.tikzSvgs = svgs;
        }));
      }
    }

    await onProgress?.({ step: 'complete', message: 'complete', progress: 100 });

    const deliveryBlueprint = { ...blueprint, totalScore };
    return { title: blueprint.title, questions, totalScore, durationMinutes: estMinutes, blueprint: deliveryBlueprint, qualityReport };
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
 * 按 section × questionType 出题，用 DeepSeek JSON Output + 本地 schema 强制结构化输出。
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
        return toValidatedExamQuestions(questions, task, config);
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
      if (questions.length > 0) return toValidatedExamQuestions(questions, task, config);
    } catch (e) { console.warn('[exam] invokeGenerateQuestions 失败，继续兜底:', e instanceof Error ? e.message.slice(0, 200) : e); }
  }

    // 最终兜底：标记 __needs_review__，审核阶段强制重出
    console.warn(`[write:${task.questionType}] 全部失败，生成占位题等待重出`);
  const fallbackTaxonomy = resolveTaskTaxonomy({ knowledgePointId: task.sectionKnowledgePoints[0]?.id }, task, config);
  if (!fallbackTaxonomy) throw new Error('出题板块没有有效的数据库知识点，不能生成占位题');
  return Array.from({ length: task.count }, (_, i) => ({
      index: i,
      type: task.questionType as ExamQuestion['type'],
      points: task.pointsPer,
      stem: '__needs_review__',
      knowledgePoint: fallbackTaxonomy.knowledgePoint,
      knowledgePointId: fallbackTaxonomy.knowledgePointId,
      literacies: fallbackTaxonomy.literacies,
      difficulty: task.difficulty as ExamQuestion['difficulty'],
      explanation: '__needs_review__',
      ...(task.questionType === 'multiple_choice' ? { options: [{ key: 'A', text: 'A' }, { key: 'B', text: 'B' }], correctKeys: ['A'], multiSelect: false } : {}),
    } as ExamQuestion));
  }

function toValidatedExamQuestions(rawQuestions: any[], task: WriteTask, config: ExamConfig): ExamQuestion[] {
  if (rawQuestions.length !== task.count) {
    throw new Error(`出题数量不匹配：期望 ${task.count} 道，实际 ${rawQuestions.length} 道`);
  }
  const questions = rawQuestions.map((q: any, i: number) => localFormatFix(toExamQuestion(q, task, i, config), i));
  const issues = questions
    .map((q) => ({ index: q.index, issue: validateExamQuestionForDelivery(q) }))
    .filter((x): x is { index: number; issue: string } => Boolean(x.issue));
  if (issues.length > 0) {
    const summary = issues.slice(0, 3).map((x) => `Q${x.index + 1}: ${x.issue}`).join('；');
    throw new Error(`生成题目未通过本地校验：${summary}`);
  }
  return questions;
}

/** 调用模型出题：使用 DeepSeek JSON Output 模式 */
async function invokeGenerateQuestions(
  model: BaseChatModel,
  prompt: string,
  questionType: string,
  count: number,
): Promise<any[]> {
  const examples: Record<string, string> = {
    multiple_choice: `{"questions":[{"stem":"题干（不要含选项字母）","options":[{"key":"A","text":"选项1"},{"key":"B","text":"选项2"},{"key":"C","text":"选项3"},{"key":"D","text":"选项4"}],"correctKeys":["A"],"multiSelect":false,"knowledgePointId":123,"difficulty":"medium","explanation":"解析内容"}]}`,
    fill_blank: `{"questions":[{"stem":"题干 ____","blanks":[{"acceptedAnswers":["标准答案"]}],"knowledgePointId":123,"difficulty":"medium","explanation":"解析内容"}]}`,
    true_false: `{"questions":[{"stem":"判断题陈述","answer":true,"knowledgePointId":123,"difficulty":"medium","explanation":"解析内容"}]}`,
    short_answer: `{"questions":[{"stem":"题干内容","referenceAnswer":"参考答案","keyPoints":["要点1","要点2"],"knowledgePointId":123,"difficulty":"medium","explanation":"解析内容"}]}`,
  };
  const schemaExample = examples[questionType] ?? examples.short_answer;
  const textPrompt = prompt + '\n\n=== 输出格式要求 ===\n必须输出纯净 JSON，不要 markdown 代码块，不要其他任何文字。' +
    `\nJSON schema 示例：\n${schemaExample}\n一次性输出全部 ${count} 道题。`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await model.invoke(
        [new SystemMessage(textPrompt)],
        { response_format: { type: 'json_object' } } as any,
      );
      const content = typeof response.content === 'string' ? response.content : '';
      return parseGeneratedQuestionList(parseJsonObject(content), questionType, count);
    } catch (err) {
      console.warn(`[invoke:${questionType}] 第 ${attempt + 1} 次失败:`, err instanceof Error ? err.message.slice(0, 80) : err);
    }
  }
  return [];
}

/** 把 LLM 输出的单题转换为 ExamQuestion（补全 points/index） */
function resolveTaskTaxonomy(raw: { knowledgePointId?: unknown; knowledgePoint?: unknown }, task: WriteTask, config: ExamConfig): QuestionTaxonomy | null {
  return resolveQuestionTaxonomy({
    subject: config.subject,
    grade: config.grade,
    knowledgePointId: raw.knowledgePointId,
    knowledgePointTitle: raw.knowledgePoint,
    allowedKnowledgePointIds: task.sectionKnowledgePoints.map((kp) => kp.id).filter((id): id is number => Number.isInteger(id)),
  });
}

/** Resolve the only learner-visible taxonomy fields from the published graph. */
function toExamQuestion(raw: any, task: WriteTask, index: number, config: ExamConfig): ExamQuestion {
  const taxonomy = resolveTaskTaxonomy(raw, task, config);
  if (!taxonomy) throw new Error(`第 ${index + 1} 题未绑定本板块已发布知识点`);
  const base: ExamQuestion = {
    index,
    type: task.questionType as ExamQuestion['type'],
    points: task.pointsPer,
    stem: raw.stem ?? '',
    passage: normalizeOptionalPassage(raw.passage),
    knowledgePoint: taxonomy.knowledgePoint,
    knowledgePointId: taxonomy.knowledgePointId,
    literacies: taxonomy.literacies,
    difficulty: raw.difficulty ?? task.difficulty,
    explanation: raw.explanation ?? '',
    groupId: raw.groupId,
  };

  if (base.type === 'multiple_choice') {
    const normalized = normalizeOptions(base.stem, raw.options);
    base.stem = normalized.stem || base.stem;
    base.options = normalized.options;
    if (!base.options || base.options.length < 2) {
      return localFormatFix(choiceWithoutOptionsToShortAnswer(base), index);
    }
    base.correctKeys = (raw.correctKeys ?? []).filter((k: string) => base.options!.some(o => o.key === k));
    if (!base.correctKeys!.length) base.correctKeys = [base.options![0].key];
    base.multiSelect = raw.multiSelect ?? false;
  }
  if (base.type === 'fill_blank') {
    const normalized = normalizeBlanks(raw, base.stem);
    base.blanks = normalized.blanks;
    base.blankCount = normalized.blankCount;
  }
  if (base.type === 'true_false') base.answer = raw.answer ?? true;
  if (base.type === 'short_answer') { base.referenceAnswer = raw.referenceAnswer ?? ''; base.keyPoints = raw.keyPoints ?? []; }

  return base;
}

// ── 重出阶段：单题出题（供 regenerateQuestions 回调） ─────────

async function writeSingleQuestion(model: BaseChatModel, prompt: string, questionType: string, config: ExamConfig): Promise<ExamQuestion | null> {
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
      // The replacement prompt contains the original canonical ID.  Permit all
      // published nodes here and validate the selected ID again below.
      sectionKnowledgePoints: getPublishedKnowledgePointIds(config.subject, config.grade).map((id) => ({ id, title: '', weight: 1 })),
    } as WriteTask, 0, config);
  } catch (e) {
    console.warn('[exam] generateWriteTask 失败:', e instanceof Error ? e.message.slice(0, 200) : e);
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
      lines.push(`  - #${item.id} ${item.title} (${item.classHours}课时)`);
    }
  }
  lines.push('\n严格按此比例分配题目数量。核心+重要应占 70% 以上。');
  return lines.join('\n');
}

// ── 简答题 LLM 评分 ────────────────────────────

/** 评分标准（SystemMessage，不含任何用户内容） */
const SHORT_ANSWER_GRADING_SYSTEM = `你是一位严谨的评分老师。请根据参考答案和评分要点，对学生的答案进行评分。

评分规则：
1. 学生答案与参考答案语义一致，或覆盖全部评分要点 → 满分（score = 1）
2. 只覆盖部分要点 → 按比例给分（如 2 个要点答对 1 个则 score = 0.5）
3. 完全不相关或留空白 → 0 分
4. 语言类题目（如英语）：只要语义和用法正确即可，不要求措辞完全一致
5. 数学/科学类：过程正确但最终答案有小错可酌情扣分

请输出纯净 JSON，格式如下：
{"correct": true/false, "score": 0到1之间的数字, "explanation": "用两三句话说明扣分或满分理由，引导学生"}`;

/** 批量评分系统 prompt（一次评多题） */
const BATCH_GRADING_SYSTEM = `你是一位严谨的评分老师。请根据每道题的参考答案和评分要点，对学生的答案逐一评分。

评分规则：
1. 学生答案与参考答案语义一致，或覆盖全部评分要点 → 满分（score = 1）
2. 只覆盖部分要点 → 按比例给分（如 2 个要点答对 1 个则 score = 0.5）
3. 完全不相关或留空白 → 0 分
4. 语言类题目（如英语）：只要语义和用法正确即可，不要求措辞完全一致
5. 数学/科学类：过程正确但最终答案有小错可酌情扣分

请输出纯净 JSON，格式如下：
{"results": [{"questionIndex": 0, "correct": true/false, "score": 0到1之间的数字, "explanation": "理由"}]}`;

/** 对学生答案做基础清洗：去除已知注入模式关键词 */
function sanitizeUserAnswer(raw: string): string {
  let text = String(raw ?? '').trim();
  if (!text) return '（未作答）';
  // 去除常见的 prompt injection 模式（defense-in-depth）
  text = text
    .replace(/<\s*\/?\s*system\s*>/gi, '')
    .replace(/ignore\s+(all\s+)?(previous|above|prior)\s+(instructions?|prompts?|rules?)/gi, '')
    .replace(/忽略\s*(以上|之前|上面)\s*(所有\s*)?(指令|提示|规则|要求)/g, '')
    .replace(/给\s*(我\s*)?(满分|100分|全对)/g, '')
    .replace(/return\s*\{?\s*"?\s*score\s*"?\s*:\s*1/gi, '');
  return text || '（未作答）';
}

/** 构建单题评分的 HumanMessage 内容 */
function buildGradingHumanMessage(params: { stem: string; referenceAnswer?: string | null; keyPoints?: string[] | null; maxScore: number; userAnswer: string }): string {
  return [
    `【题目】${params.stem}`,
    `【参考答案】${params.referenceAnswer ?? '（未提供）'}`,
    `【评分要点】${params.keyPoints?.length ? params.keyPoints.join('、') : '（未提供）'}`,
    `【满分】${params.maxScore} 分`,
    '',
    `【学生答案】`,
    sanitizeUserAnswer(params.userAnswer),
  ].join('\n');
}

/** 构建基于 LLM 的简答题/填空题评分器（单题模式，JSON Output + Injection 防御） */
export function createShortAnswerGrader(model: BaseChatModel): ShortAnswerGrader {
  return async (params) => {
    try {
      const response = await model.invoke(
        [
          new SystemMessage(SHORT_ANSWER_GRADING_SYSTEM),
          new HumanMessage(buildGradingHumanMessage(params)),
        ],
        { response_format: { type: 'json_object' } } as any,
      );
      const content = typeof response.content === 'string' ? response.content : '';
      const parsed = JSON.parse(content);
      const maxScore = params.maxScore ?? 1;
      return {
        correct: Boolean(parsed.correct),
        score: Math.max(0, Math.min(maxScore, Number(parsed.score))),
        explanation: String(parsed.explanation ?? ''),
        perBlank: Array.isArray(parsed.perBlank) ? parsed.perBlank.map(Boolean) : undefined,
      };
    } catch (err) {
      console.error('简答题 LLM 评分失败:', err instanceof Error ? err.message : String(err));
      return { correct: false, score: 0, explanation: '评分服务暂时不可用，请老师人工批阅。' };
    }
  };
}

/** 批量简答题参数 */
interface BatchGradeItem {
  questionIndex: number;
  stem: string;
  referenceAnswer?: string | null;
  keyPoints?: string[] | null;
  maxScore: number;
  userAnswer: string;
}

/** 批量评分结果 */
interface BatchGradeResult {
  questionIndex: number;
  correct: boolean;
  score: number;
  explanation: string;
}

/**
 * 批量简答题 LLM 评分（一次调用评多题，JSON Output + Injection 防御）。
 * 如果批量失败，回退到逐题评分。
 */
export async function batchGradeShortAnswers(
  model: BaseChatModel,
  items: BatchGradeItem[],
): Promise<BatchGradeResult[]> {
  if (items.length === 0) return [];
  if (items.length === 1) {
    // 单题直接走单题模式
    const grader = createShortAnswerGrader(model);
    const result = await grader(items[0]);
    return [{ questionIndex: items[0].questionIndex, ...result }];
  }

  // 构造批量评分的 HumanMessage
  const questionList = items.map((item, i) => ({
    questionIndex: item.questionIndex,
    题目: item.stem,
    参考答案: item.referenceAnswer ?? '（未提供）',
    评分要点: item.keyPoints?.length ? item.keyPoints.join('、') : '（未提供）',
    满分: item.maxScore,
    学生答案: sanitizeUserAnswer(item.userAnswer),
  }));

  const humanContent = `请对以下 ${items.length} 道题逐一评分，输出 JSON 数组包含每道题的结果：\n\n${JSON.stringify(questionList, null, 2)}`;

  try {
    const response = await model.invoke(
      [
        new SystemMessage(BATCH_GRADING_SYSTEM),
        new HumanMessage(humanContent),
      ],
      { response_format: { type: 'json_object' } } as any,
    );
    const content = typeof response.content === 'string' ? response.content : '';
    const parsed = JSON.parse(content);
    const results: BatchGradeResult[] = Array.isArray(parsed?.results) ? parsed.results : [];

    // 校验：长度必须匹配，不匹配则回退到逐题
    if (results.length !== items.length) {
      console.warn(`[batchGrade] 返回数量不匹配（期望 ${items.length}，实际 ${results.length}），回退到逐题评分`);
      return fallbackBatchGrade(model, items);
    }

    return results.map((r) => ({
      questionIndex: Number(r.questionIndex),
      correct: Boolean(r.correct),
      score: Math.max(0, Math.min(1, Number(r.score))),
      explanation: String(r.explanation ?? ''),
    }));
  } catch (err) {
    console.warn('[batchGrade] 批量评分失败，回退到逐题评分:', err instanceof Error ? err.message : String(err));
    return fallbackBatchGrade(model, items);
  }
}

/** 批量评分回退：逐题调用 */
async function fallbackBatchGrade(model: BaseChatModel, items: BatchGradeItem[]): Promise<BatchGradeResult[]> {
  const grader = createShortAnswerGrader(model);
  const results: BatchGradeResult[] = [];
  for (const item of items) {
    const r = await grader(item);
    results.push({ questionIndex: item.questionIndex, ...r });
  }
  return results;
}

// ── 填空题 Level 3 LLM 语义判定 ────────────────────────────

interface BlankLevel3Item {
  questionIndex: number;
  blankIndex: number;
  userAnswer: string;
  acceptedAnswers: string[];
}

/**
 * 填空题 Level 3：对 Level 2 规范化匹配未通过的填空题，批量提交给 LLM 做语义等价判定。
 * 仅对未通过的空白触发，不会成为常态开销。
 */
async function batchCheckBlanksLevel3(
  model: BaseChatModel,
  items: BlankLevel3Item[],
): Promise<Map<string, boolean>> {
  const resultMap = new Map<string, boolean>();
  if (items.length === 0) return resultMap;

  const questionList = items.map((item) => ({
    questionIndex: item.questionIndex,
    blankIndex: item.blankIndex,
    studentAnswer: item.userAnswer || '（未作答）',
    acceptedAnswers: item.acceptedAnswers,
  }));

  const systemPrompt = `你是一位严谨的阅卷老师。请判断学生的填空题答案是否与标准答案语义等价。
判断规则：
1. 数学等价：1/2 = 0.5，(x+1)² = x²+2x+1，π ≈ 3.14 等均视为正确
2. 中文同义词：光合作用 ≈ 光合效应 等同义表达视为正确
3. 单位等价：5cm = 5厘米 视为正确
4. 表达差异但语义一致视为正确
5. 完全无关、意义相反或明显错误的答案视为不正确

请输出 JSON：{"results": [{"questionIndex": 0, "blankIndex": 0, "match": true, "reason": "简短理由"}]}`;

  const humanContent = `请判断以下 ${items.length} 个填空题答案是否与标准答案语义等价：\n\n${JSON.stringify(questionList, null, 2)}`;

  try {
    const response = await model.invoke(
      [new SystemMessage(systemPrompt), new HumanMessage(humanContent)],
      { response_format: { type: 'json_object' } } as any,
    );
    const content = typeof response.content === 'string' ? response.content : '';
    const parsed = JSON.parse(content);
    const results: Array<{ questionIndex: number; blankIndex: number; match: boolean }> =
      Array.isArray(parsed?.results) ? parsed.results : [];

    for (const r of results) {
      const key = `${r.questionIndex}:${r.blankIndex}`;
      resultMap.set(key, Boolean(r.match));
    }
  } catch (err) {
    console.warn('[blankLevel3] LLM 语义判定失败，保持原结果:', err instanceof Error ? err.message : String(err));
  }

  return resultMap;
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
  onProgress?: ExamGradingProgressFn,
  options?: { examId?: string; existingResults?: ExamQuestionResult[] },
): Promise<ExamResults> {
  // ── 断点续判：构建已判题目集合，计算进度偏移 ──
  const existingResultsMap = new Map<number, ExamQuestionResult>();
  if (options?.existingResults) {
    for (const r of options.existingResults) existingResultsMap.set(r.index, r);
  }
  const existingCount = existingResultsMap.size;
  const totalQuestions = questions.length;
  // 进度偏移：已判题目占总题数的比例 × 58（客观+简答评分阶段的进度上限）
  const resumeProgressOffset = totalQuestions > 0 ? Math.round((existingCount / totalQuestions) * 58) : 0;
  const initialProgress = Math.max(12, 12 + resumeProgressOffset);

  await onProgress?.({ step: 'grade', message: 'grade', progress: initialProgress });
  const answerMap = new Map(answers.map(a => [a.questionIndex, a.answer]));

  // ── 客观题并行评分（跳过断点已判题目） ────────────────────────────
  const objectiveQuestions = questions.filter(q => q.type !== 'short_answer' && !existingResultsMap.has(q.index));
  const shortAnswerQuestions = questions.filter(q => q.type === 'short_answer' && !existingResultsMap.has(q.index));
  const fillBlankGrader = model ? createShortAnswerGrader(model) : undefined;

  const objectiveResults: ExamQuestionResult[] = await Promise.all(objectiveQuestions.map(async (q) => {
    const answer = answerMap.get(q.index);
    if (!answer) {
      return { index: q.index, correct: false, score: 0, maxScore: q.points, reference: '', explanation: q.explanation || '', knowledgePoint: q.knowledgePoint, knowledgePointId: q.knowledgePointId, literacy: normalizeLiteracies(q.literacies) };
    }
    const toolName = questionTypeToToolName(q.type);
    const rawArgs = buildRawArgs(q);
    const grader = (q.type === 'fill_blank' || q.type === 'short_answer') ? fillBlankGrader : undefined;
    const { result } = await gradeAnswer(toolName, rawArgs, answer, grader);

    // 填空题：使用详细匹配追踪 Level 2 misses（供 Level 3 LLM 语义判定）
    let blankLevel2Misses: Array<{ blankIndex: number; userAnswer: string; acceptedAnswers: string[] }> | undefined;
    if (q.type === 'fill_blank' && answer.type === 'fill_blank') {
      const fillArgs = fillBlankSchema.parse(rawArgs);
      blankLevel2Misses = [];
      const detailedPerBlank: boolean[] = [];
      for (let bi = 0; bi < fillArgs.blanks.length; bi++) {
        const matchResult = fuzzyMatchBlankDetailed(answer.answers[bi] ?? '', fillArgs.blanks[bi].acceptedAnswers);
        detailedPerBlank.push(matchResult.matched);
        if (!matchResult.matched && matchResult.level === 'miss') {
          blankLevel2Misses.push({ blankIndex: bi, userAnswer: answer.answers[bi] ?? '', acceptedAnswers: fillArgs.blanks[bi].acceptedAnswers });
        }
      }
      // 用详细匹配结果覆盖原始 perBlank
      const score = detailedPerBlank.filter(Boolean).length;
      result.perBlank = detailedPerBlank;
      result.score = score;
      result.correct = detailedPerBlank.every(Boolean);
      (result as any).__blankLevel2Misses = blankLevel2Misses;
    }

    const scaledScore = q.type === 'fill_blank' && result.maxScore > 0
      ? Math.round((result.score / result.maxScore) * q.points)
      : result.correct === true ? q.points : 0;
    return {
      index: q.index, correct: result.correct, score: scaledScore, maxScore: q.points,
      reference: result.reference, explanation: result.explanation,
      knowledgePoint: q.knowledgePoint, knowledgePointId: q.knowledgePointId,
      literacy: normalizeLiteracies(q.literacies),
      ...(blankLevel2Misses ? { __blankLevel2Misses: blankLevel2Misses } : {}),
    };
  }));

  // ── 填空题 Level 3 LLM 语义判定（仅对 Level 2 未通过的空白） ──
  if (model) {
    const level3Items: BlankLevel3Item[] = [];
    for (const r of objectiveResults) {
      const misses = (r as any).__blankLevel2Misses as Array<{ blankIndex: number; userAnswer: string; acceptedAnswers: string[] }> | undefined;
      if (misses?.length) {
        for (const m of misses) {
          level3Items.push({ questionIndex: r.index, blankIndex: m.blankIndex, userAnswer: m.userAnswer, acceptedAnswers: m.acceptedAnswers });
        }
      }
    }
    if (level3Items.length > 0) {
      const level3Results = await batchCheckBlanksLevel3(model, level3Items);
      // 根据 Level 3 结果更新分数
      for (const r of objectiveResults) {
        const q = questions.find(x => x.index === r.index);
        if (!q || q.type !== 'fill_blank') continue;
        const misses = (r as any).__blankLevel2Misses as Array<{ blankIndex: number }> | undefined;
        if (!misses?.length) continue;
        const totalBlanks = q.blanks?.length ?? q.blankCount ?? 1;
        let correctedCount = 0;
        for (let bi = 0; bi < totalBlanks; bi++) {
          const wasMiss = misses.find(m => m.blankIndex === bi);
          if (wasMiss) {
            const key = `${r.index}:${bi}`;
            if (level3Results.get(key)) correctedCount++;
          } else {
            correctedCount++; // Level 1/2 passed
          }
        }
        const newScaledScore = Math.round((correctedCount / totalBlanks) * r.maxScore);
        if (newScaledScore > r.score) {
          r.score = newScaledScore;
          r.correct = correctedCount === totalBlanks;
          console.log(`[blankLevel3] Q${r.index + 1} 填空题 Level 3 修正: ${r.score}/${r.maxScore}`);
        }
      }
    }
    // 清理临时字段
    for (const r of objectiveResults) delete (r as any).__blankLevel2Misses;
  } else {
    for (const r of objectiveResults) delete (r as any).__blankLevel2Misses;
  }

  // ── 客观题批改完成，保存断点 ──
  if (options?.examId && objectiveResults.length > 0) {
    const checkpointSoFar: ExamQuestionResult[] = [
      ...existingResultsMap.values(),
      ...objectiveResults,
    ];
    saveGradingCheckpoint(options.examId, checkpointSoFar);
  }

  // ── 简答题批量评分（一次 LLM 调用） ──────────────
  const shortAnswerResults: ExamQuestionResult[] = [];
  if (shortAnswerQuestions.length > 0 && model) {
    const batchItems: BatchGradeItem[] = shortAnswerQuestions.map(q => ({
      questionIndex: q.index,
      stem: q.stem,
      referenceAnswer: q.referenceAnswer,
      keyPoints: q.keyPoints,
      maxScore: q.points,
      userAnswer: (() => {
        const a = answerMap.get(q.index);
        return a && a.type === 'short_answer' ? a.text : '';
      })(),
    }));

    const batchResults = await batchGradeShortAnswers(model, batchItems);
    const resultMap = new Map(batchResults.map(r => [r.questionIndex, r]));

    for (const q of shortAnswerQuestions) {
      const answer = answerMap.get(q.index);
      const gr = resultMap.get(q.index);
      if (!answer || !gr) {
        shortAnswerResults.push({ index: q.index, correct: false, score: 0, maxScore: q.points, reference: q.referenceAnswer ?? '', explanation: q.explanation || '', knowledgePoint: q.knowledgePoint, knowledgePointId: q.knowledgePointId, literacy: normalizeLiteracies(q.literacies) });
      } else {
        const scaledScore = Math.round((gr.score / 1) * q.points);
        shortAnswerResults.push({
          index: q.index, correct: gr.correct, score: scaledScore, maxScore: q.points,
          reference: q.referenceAnswer ?? '', explanation: gr.explanation || q.explanation || '',
          knowledgePoint: q.knowledgePoint, knowledgePointId: q.knowledgePointId,
          literacy: normalizeLiteracies(q.literacies),
        });
      }
    }
  } else {
    // 无模型时简答题不给分
    for (const q of shortAnswerQuestions) {
      shortAnswerResults.push({ index: q.index, correct: null as any, score: 0, maxScore: q.points, reference: q.referenceAnswer ?? '', explanation: q.explanation || '评分服务暂时不可用，请老师人工批阅。', knowledgePoint: q.knowledgePoint, knowledgePointId: q.knowledgePointId, literacy: normalizeLiteracies(q.literacies) });
    }
  }

  // ── 简答题批改完成，保存断点 ──
  if (options?.examId && shortAnswerResults.length > 0) {
    const checkpointAll: ExamQuestionResult[] = [
      ...existingResultsMap.values(),
      ...objectiveResults,
      ...shortAnswerResults,
    ];
    saveGradingCheckpoint(options.examId, checkpointAll);
  }

  // 合并结果并按原始题目顺序排列（含断点已有结果）
  const allResultsMap = new Map<number, ExamQuestionResult>();
  for (const r of existingResultsMap.values()) allResultsMap.set(r.index, r);
  for (const r of objectiveResults) allResultsMap.set(r.index, r);
  for (const r of shortAnswerResults) allResultsMap.set(r.index, r);
  const questionResults = questions.map(q => allResultsMap.get(q.index)!).filter(Boolean);

  await onProgress?.({ step: 'grade', message: 'grade', progress: 58 });

  const totalScore = questionResults.reduce((s, r) => s + r.score, 0);
  const maxScore = questionResults.reduce((s, r) => s + r.maxScore, 0);
  const percentage = maxScore > 0 ? Math.round((totalScore / maxScore) * 100) : 0;

  const grade = percentage >= 90 ? '优秀' : percentage >= 75 ? '良好' : percentage >= 60 ? '及格' : '需努力';

  // ── 判分结果交叉校验 ────────────────────────
  const audit = auditGradingResults(questions, questionResults);
  if (!audit.passed) {
    console.warn('[gradeAudit] 判分校验发现问题:', audit.issues.join('；'));
  }

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
      await onProgress?.({ step: 'analyze', message: 'analyze', progress: 68 });
      const analysis = await generateExamAnalysis(model, questions, examResults, { subject: examInfo?.subject ?? '', grade: examInfo?.grade ?? '' });
      if (analysis) examResults.analysis = analysis;
      await onProgress?.({ step: 'analyze', message: 'analyze', progress: 78 });
    } catch (err) {
      console.warn('[grading] analysis failed:', err);
    }
  } else {
    await onProgress?.({ step: 'analyze', message: 'analyze', progress: 78 });
  }

  return examResults;
}

/** 判分结果交叉校验：检查总分范围、逐题分数、客观题确定性、简答题合理性 */
function auditGradingResults(questions: ExamQuestion[], results: ExamQuestionResult[]): { passed: boolean; issues: string[] } {
  const issues: string[] = [];

  // 1. 总分范围校验
  const totalScore = results.reduce((s, r) => s + r.score, 0);
  const maxScore = results.reduce((s, r) => s + r.maxScore, 0);
  if (totalScore > maxScore) issues.push(`总分 ${totalScore} 超过满分 ${maxScore}`);
  if (totalScore < 0) issues.push(`总分 ${totalScore} 为负`);

  // 2. 逐题分数范围校验
  for (const r of results) {
    if (r.score < 0 || r.score > r.maxScore) {
      issues.push(`第${r.index + 1}题分数 ${r.score}/${r.maxScore} 越界`);
    }
  }

  // 3. 客观题确定性校验
  for (const q of questions) {
    if (q.type === 'multiple_choice' || q.type === 'true_false') {
      const r = results.find(x => x.index === q.index);
      if (r) {
        const expected = r.correct === true ? q.points : 0;
        if (r.score !== expected) {
          issues.push(`第${q.index + 1}题(${q.type})确定性评分不一致: expected ${expected}, got ${r.score}`);
        }
      }
    }
  }

  // 4. 简答题评分合理性
  for (const q of questions) {
    if (q.type === 'short_answer') {
      const r = results.find(x => x.index === q.index);
      if (r && r.correct === true && r.maxScore > 0 && r.score < r.maxScore * 0.8) {
        issues.push(`第${q.index + 1}题标记correct=true但得分率仅${Math.round(r.score / r.maxScore * 100)}%`);
      }
    }
  }

  return { passed: issues.length === 0, issues };
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

// ── 针对性错误详解（按需触发） ────────────────────────────

/**
 * 为答错的客观题生成针对性错误分析（仅在用户请求"查看详解"时触发）。
 * 不增加默认判分流程的延迟。
 */
export async function generateDetailedReview(
  model: BaseChatModel,
  questions: ExamQuestion[],
  answers: Array<{ questionIndex: number; answer: AnswerPayload }>,
  results: ExamResults,
): Promise<ExamQuestionResult[]> {
  // Collect wrong objective questions (multiple_choice, fill_blank, true_false)
  const wrongObjectives = results.questionResults.filter(
    (qr) => qr.correct === false && qr.maxScore > 0,
  );

  if (wrongObjectives.length === 0) return results.questionResults;

  const answerMap = new Map(answers.map((a) => [a.questionIndex, a.answer]));

  // Build per-question context for the LLM
  const questionContexts = wrongObjectives.map((qr) => {
    const q = questions.find((x) => x.index === qr.index);
    const answer = answerMap.get(qr.index);
    if (!q) return null;

    let studentAnswerText = '（未作答）';
    if (answer) {
      if (answer.type === 'multiple_choice') studentAnswerText = (answer as any).selectedKeys?.join(', ') ?? '（未作答）';
      else if (answer.type === 'fill_blank') studentAnswerText = (answer as any).answers?.join(' / ') ?? '（未作答）';
      else if (answer.type === 'true_false') studentAnswerText = (answer as any).value ? '正确' : '错误';
    }

    const typeLabel: Record<string, string> = { multiple_choice: '选择题', fill_blank: '填空题', true_false: '判断题' };

    return {
      index: qr.index,
      type: typeLabel[q.type] ?? q.type,
      stem: q.stem?.slice(0, 300),
      options: q.type === 'multiple_choice' ? q.options?.map((o) => `${o.key}. ${o.text}`).join('；') : undefined,
      correctAnswer: qr.reference || q.explanation?.slice(0, 100),
      studentAnswer: studentAnswerText,
      knowledgePoint: q.knowledgePoint,
    };
  }).filter(Boolean);

  if (questionContexts.length === 0) return results.questionResults;

  // Only include objective question types
  const objectiveContexts = questionContexts.filter((ctx) =>
    ctx!.type === '选择题' || ctx!.type === '填空题' || ctx!.type === '判断题',
  );

  if (objectiveContexts.length === 0) return results.questionResults;

  const systemPrompt = `你是一位耐心的老师。请针对学生的具体错误，解释为什么答案不对以及正确答案是什么。

对于每道错题：
1. 先指出学生答案的具体错误
2. 解释正确思路
3. 给出学习建议

输出 JSON：{"results": [{"index": 0, "explanation": "针对性解析"}]}`;

  const humanContent = `请分析以下 ${objectiveContexts.length} 道错题：\n\n${JSON.stringify(objectiveContexts, null, 2)}`;

  try {
    const response = await model.invoke(
      [new SystemMessage(systemPrompt), new HumanMessage(humanContent)],
      { response_format: { type: 'json_object' } } as any,
    );
    const content = typeof response.content === 'string' ? response.content : '';
    const parsed = JSON.parse(content);
    const detailedResults: Array<{ index: number; explanation: string }> =
      Array.isArray(parsed?.results) ? parsed.results : [];

    // Merge detailed explanations into the existing questionResults
    const resultMap = new Map(detailedResults.map((r) => [r.index, r.explanation]));
    return results.questionResults.map((qr) => {
      const explanation = resultMap.get(qr.index);
      if (explanation) {
        return { ...qr, detailedExplanation: String(explanation) };
      }
      return qr;
    });
  } catch (err) {
    console.warn('[detailedReview] LLM 详解生成失败:', err instanceof Error ? err.message : String(err));
    return results.questionResults;
  }
}

// ── 自动错题收集 ─────────────────────────────────

/**
 * 考试提交后，将失分严重的题目（得分率 < 60%）自动归入错题本。
 * 不需要 OCR，因为题目数据已在系统中。
 * 用 LLM 简要分析错因，映射知识点，写入 mistake_items + mistake_kp_map。
 */
async function autoCollectMistakes(
  userId: string,
  examId: string,
  questions: ExamQuestion[],
  answers: Array<{ questionIndex: number; answer: AnswerPayload }>,
  results: ExamResults,
  subject: string,
  grade: string,
  model?: BaseChatModel,
): Promise<{ count: number; mistakeIds: string[] }> {
  const mistakeIds: string[] = [];
  const answerMap = new Map(answers.map(a => [a.questionIndex, a.answer]));

  // 筛选得分率 < 60% 的题目
  const penalized = results.questionResults.filter(
    (qr) => qr.maxScore > 0 && qr.score / qr.maxScore < 0.6,
  );
  if (penalized.length === 0) return { count: 0, mistakeIds };

  // LLM 简要分析错因 + 生成标题（单次批量调用）
  let analyses: Array<{ errorType: string; errorReason: string; title?: string }> = [];
  if (model && penalized.length > 0) {
    try {
      const prompt = [
        '请简要分析以下考试错题的错误类型和原因，并为每道题生成一个简短标题。',
        '输出 JSON 数组，每个元素包含 errorType、errorReason 和 title。',
        `errorType 可选值：概念混淆 | 计算失误 | 审题遗漏 | 步骤跳步 | 表达不完整 | 其他`,
        'errorReason：用一两句话具体说明错因，不要只写"粗心"。',
        'title：10字以内的精炼摘要，概括该题的核心考点（如"绝对值性质"、"分数加减法"）。',
        '',
        ...penalized.map((qr, i) => {
          const q = questions.find((x) => x.index === qr.index);
          return [
            `第${i + 1}题（${q?.type ?? '未知'}）：`,
            `题干：${q?.stem?.slice(0, 200) ?? '（无题干）'}`,
            `参考答案：${qr.reference?.slice(0, 150) ?? '（无）'}`,
            `得分：${qr.score}/${qr.maxScore}`,
          ].join('\n');
        }),
      ].join('\n');

      const response = await model.invoke(
        [new SystemMessage('你是错题分析助手，只输出可解析 JSON。'), new HumanMessage(prompt)],
        { response_format: { type: 'json_object' } } as any,
      );
      const content = typeof response.content === 'string' ? response.content : '';
      const parsed = JSON.parse(content);
      analyses = (Array.isArray(parsed) ? parsed : parsed.results ?? parsed.analyses ?? []).map(
        (a: any) => ({
          errorType: String(a.errorType ?? '其他'),
          errorReason: String(a.errorReason ?? ''),
          title: a.title ? String(a.title).slice(0, 32) : undefined,
        }),
      );
    } catch (err) {
      console.warn('[autoCollectMistakes] LLM 错因分析失败，跳过:', err instanceof Error ? err.message : err);
    }
  }

  const now = Math.floor(Date.now() / 1000);

  for (let i = 0; i < penalized.length; i++) {
    const qr = penalized[i];
    const q = questions.find((x) => x.index === qr.index);
    if (!q) continue;

    const id = `mistake-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const analysis = analyses[i];
    const errorType = analysis?.errorType ?? undefined;
    const errorReason = analysis?.errorReason ?? undefined;
    const correctAnswer = qr.reference?.slice(0, 2000) ?? undefined;
    const title = analysis?.title ?? (q.stem?.split(/\n|。|\./)[0] ?? '考试错题').slice(0, 32);

    // 提取学生实际答案文本
    const userAnswer = answerMap.get(qr.index);
    let studentAnswerText: string | null = null;
    if (userAnswer) {
      if (userAnswer.type === 'multiple_choice') studentAnswerText = userAnswer.selectedKeys?.join(', ') ?? null;
      else if (userAnswer.type === 'fill_blank') studentAnswerText = userAnswer.answers?.join(' | ') ?? null;
      else if (userAnswer.type === 'true_false') studentAnswerText = userAnswer.value ? '正确' : '错误';
      else if (userAnswer.type === 'short_answer') studentAnswerText = userAnswer.text ?? null;
    }

    // 答案匹配度：基于实际得分率
    const matchScore = qr.maxScore > 0 ? qr.score / qr.maxScore : 0;

    // 创建错题记录（status 直接设为 analyzed，因为考试中已有完整评分信息）
    db.prepare(`
      INSERT INTO mistake_items (
        id, user_id, subject, grade, source_type, status, title, prompt_text,
        student_answer, correct_answer, explanation,
        error_type, error_reason, analysis_confidence,
        answer_match_score, is_correct,
        created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, 'text', 'analyzed', ?, ?,
        ?, ?, ?,
        ?, ?, ?,
        ?, ?,
        ?, ?
      )
    `).run(
      id,
      userId,
      subject,
      grade,
      title,
      q.stem?.slice(0, 8000) ?? '',
      studentAnswerText,
      correctAnswer ?? null,
      q.explanation?.slice(0, 2000) ?? null,
      errorType ?? null,
      errorReason ?? null,
      analysis ? 0.7 : 0.3,
      matchScore,
      0, // is_correct = false (heavily penalized)
      now,
      now,
    );

    // 知识点映射（before 取答题前的值，after 取 DB 当前值）
    const kpTitle = q.knowledgePoint;
    if (kpTitle && results.proficiencyChanges) {
      const qBefore = results.proficiencyChanges.find(p => p.kpTitle === kpTitle);
      if (qBefore) {
        const node = findKnowledgePointNode(kpTitle, subject);
        if (node) {
          const profRow = db.prepare('SELECT weighted_score FROM user_kp_proficiency WHERE user_id=? AND kg_node_id=?').get(userId, node.id) as { weighted_score: number } | undefined;
          const afterScore = profRow?.weighted_score ?? null;
          db.prepare(`
            INSERT OR IGNORE INTO mistake_kp_map (mistake_id, kg_node_id, role, confidence, before_score, after_score, evidence_json)
            VALUES (?, ?, 'primary', 0.7, ?, ?, ?)
          `).run(id, node.id, qBefore.before, afterScore, JSON.stringify({ evidence: `exam:${examId}`, source: 'auto_collect' }));
        }
      }
    }

    mistakeIds.push(id);
  }

  return { count: mistakeIds.length, mistakeIds };
}

// ── 会话管理 ─────────────────────────────────

export function createExamSession(userId: string, config: ExamConfig, data: GeneratedExam): ExamSession {
  const id = `exam-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`INSERT INTO exam_sessions (id, user_id, subject, grade, title, questions, total_score, duration_minutes, status, created_at, blueprint, quality_report) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`).run(
    id,
    userId,
    config.subject,
    config.grade,
    data.title,
    JSON.stringify(data.questions),
    data.totalScore,
    data.durationMinutes,
    now,
    JSON.stringify(data.blueprint),
    JSON.stringify(data.qualityReport),
  );
  return {
    id,
    userId,
    subject: config.subject,
    grade: config.grade,
    title: data.title,
    questions: data.questions,
    totalScore: data.totalScore,
    durationMinutes: data.durationMinutes,
    status: 'pending',
    createdAt: now,
    blueprint: data.blueprint,
    qualityReport: data.qualityReport,
  };
}

/** 更新由 POST /api/exam 预创建的空白考试记录（出卷完成后填充完整数据） */
export function updateExamSession(examId: string, userId: string, config: ExamConfig, data: GeneratedExam): ExamSession | null {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`UPDATE exam_sessions SET subject=?, grade=?, title=?, questions=?, total_score=?, duration_minutes=?, status='pending', updated_at=?, blueprint=?, quality_report=? WHERE id=? AND user_id=?`).run(
    config.subject,
    config.grade,
    data.title,
    JSON.stringify(data.questions),
    data.totalScore,
    data.durationMinutes,
    now,
    JSON.stringify(data.blueprint),
    JSON.stringify(data.qualityReport),
    examId,
    userId,
  );
  return {
    id: examId,
    userId,
    subject: config.subject,
    grade: config.grade,
    title: data.title,
    questions: data.questions,
    totalScore: data.totalScore,
    durationMinutes: data.durationMinutes,
    status: 'pending',
    createdAt: now,
    blueprint: data.blueprint,
    qualityReport: data.qualityReport,
  };
}

export function getExamSession(examId: string, userId: string): ExamSession | null {
  const row = db.prepare(`SELECT * FROM exam_sessions WHERE id=? AND user_id=?`).get(examId, userId) as any;
  if (!row) return null;
  const questions = (JSON.parse(row.questions) as ExamQuestion[]).map((q, i) => {
    const canonical = canonicalizeStoredQuestionTaxonomy(q, row.subject, row.grade);
    // Historical labels that cannot be traced to a published node must never
    // reach the client.  The question remains reviewable, but without a
    // fabricated/legacy taxonomy label.
    const safeQuestion = canonical ?? { ...q, knowledgePointId: undefined, knowledgePoint: undefined, literacies: [] };
    return localFormatFix(safeQuestion, i);
  });
  return {
    id: row.id, userId: row.user_id, subject: row.subject, grade: row.grade, title: row.title,
    questions, totalScore: row.total_score, durationMinutes: row.duration_minutes ?? 45,
    status: row.status, createdAt: row.created_at, submittedAt: row.submitted_at,
    answers: row.answers ? JSON.parse(row.answers) : undefined,
    results: row.results ? JSON.parse(row.results) : undefined,
    blueprint: row.blueprint ? JSON.parse(row.blueprint) : undefined,
    qualityReport: row.quality_report ? JSON.parse(row.quality_report) : undefined,
  };
}

/** 删除一场考试（任意状态，仅限本人）。返回是否删除成功 */
export function deleteExamSession(examId: string, userId: string): boolean {
  const info = db.prepare(`DELETE FROM exam_sessions WHERE id=? AND user_id=?`).run(examId, userId);
  return info.changes > 0;
}

/** 列出用户已完成的考试（概要），按提交时间倒序，供「考试历史」页回顾 */
export function listExamSessions(userId: string): ExamSummary[] {
  const rows = db.prepare(
    `SELECT id, subject, grade, title, total_score, status, created_at, submitted_at, results
     FROM exam_sessions
     WHERE user_id=? AND status='completed'
     ORDER BY COALESCE(submitted_at, created_at) DESC`,
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

// ── 批改断点续判（Grading Checkpoint） ──────────────────

/** 读取考试会话的批改断点（已判完的题目结果） */
function readGradingCheckpoint(examId: string): ExamQuestionResult[] | null {
  const row = db.prepare(`SELECT grading_checkpoint FROM exam_sessions WHERE id=?`).get(examId) as { grading_checkpoint: string | null } | undefined;
  if (!row?.grading_checkpoint) return null;
  try {
    const parsed = JSON.parse(row.grading_checkpoint);
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : null;
  } catch (e) {
    console.warn('[exam] 解析 grading_checkpoint 失败:', e instanceof Error ? e.message.slice(0, 200) : e);
    return null;
  }
}

/** 将已判完的题目结果保存到批改断点 */
function saveGradingCheckpoint(examId: string, results: ExamQuestionResult[]) {
  db.prepare(`UPDATE exam_sessions SET grading_checkpoint=? WHERE id=?`)
    .run(JSON.stringify(results), examId);
}

/** 考试批改完成后清除断点数据 */
function clearGradingCheckpoint(examId: string) {
  db.prepare(`UPDATE exam_sessions SET grading_checkpoint=NULL WHERE id=?`).run(examId);
}

export async function submitExamSession(
  examId: string,
  userId: string,
  answers: Array<{ questionIndex: number; answer: AnswerPayload }>,
  model?: BaseChatModel,
  onProgress?: ExamGradingProgressFn,
): Promise<ExamResults> {
  const session = getExamSession(examId, userId);
  if (!session) throw new Error('考试会话未找到');
  if (session.status === 'completed') throw new Error('该考试已提交');

  await onProgress?.({ step: 'grade', message: 'grade', progress: 4 });

  // ── 断点续判：读取已有批改结果 ──
  const checkpoint = readGradingCheckpoint(examId);
  if (checkpoint && checkpoint.length > 0) {
    await onProgress?.({
      step: 'grade',
      message: `从断点续判：已完成 ${checkpoint.length}/${session.questions.length} 题`,
      progress: Math.round(checkpoint.length / session.questions.length * 50),
    });
  }

  const results = await gradeExam(
    session.questions,
    answers,
    model,
    { subject: session.subject, grade: session.grade },
    onProgress,
    { examId, existingResults: checkpoint ?? undefined },
  );
  await onProgress?.({ step: 'profile', message: 'profile', progress: 84 });

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

  // ── 星月积分结算：评分(主) + 星级跨越奖(额外) ──
  try {
    const outline = getProfileOutline(session.subject, String(session.grade ?? ''), userId) as { overall?: { weightedScore?: number } };
    const S = Math.max(0, outline.overall?.weightedScore ?? 0);
    const scorePoints = computeScorePoints(results.percentage ?? 0, S);
    const starBonus = computeStarBonus(proficiencyChanges, S);
    const total = Math.max(0, Math.round(scorePoints + starBonus));
    if (total > 0) {
      const earn = earnPoints(userId, total, 'exam', examId);
      if (earn.earned > 0 || earn.capped) {
        results.pointsEarned = earn.earned;
        results.pointsBalance = earn.balance;
        results.pointsCapped = earn.capped;
      }
    }
  } catch (err) {
    console.warn('[currency] 考试积分结算失败（不影响考试提交）:', err instanceof Error ? err.message : err);
  }

  // ── 自动错题收集：将失分严重的题目归入错题本 ──
  try {
    await onProgress?.({ step: 'save', message: '正在收集错题…', progress: 88 });
    const collected = await autoCollectMistakes(
      userId,
      examId,
      session.questions,
      answers,
      results,
      session.subject,
      session.grade,
      model,
    );
    if (collected.count > 0) {
      results.mistakesCollected = { count: collected.count, mistakeIds: collected.mistakeIds };
      console.log(`[autoCollectMistakes] 已收集 ${collected.count} 道错题到错题本`);
    }
  } catch (err) {
    console.warn('[autoCollectMistakes] 错题收集失败（不影响考试提交）:', err instanceof Error ? err.message : err);
  }

  await onProgress?.({ step: 'save', message: 'save', progress: 94 });
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`UPDATE exam_sessions SET status='completed', answers=?, results=?, submitted_at=? WHERE id=? AND user_id=?`).run(JSON.stringify(answers), JSON.stringify(results), now, examId, userId);
  // 批改完成，清除断点数据
  clearGradingCheckpoint(examId);
  await onProgress?.({ step: 'complete', message: 'complete', progress: 100 });

  return results;
}
