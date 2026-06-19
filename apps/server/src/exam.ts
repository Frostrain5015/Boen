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
import { z } from 'zod';
import type { ExamQuestion, ExamResults, AnswerPayload, ExamQuestionResult, ExamSummary, ExamBlueprint, ExamQualityReport } from '@boen/shared';
import { gradeAnswer, multipleChoiceSchema, fillBlankSchema, trueFalseSchema, shortAnswerSchema } from '@boen/agent-core';
import type { ShortAnswerGrader } from '@boen/agent-core';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { writeFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { getWeightDistribution, WEIGHT_TIERS } from './kg-weights.js';
import { updateProficiency, getWeakPoints, getRecommendedKPs } from './knowledge-profile.js';
import db from './db.js';
import { retrieveCurriculum } from './curriculum.js';
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
  return ['综合素养'];
}

const TYPE_LABELS: Record<string, string> = { multiple_choice: '选择题', fill_blank: '填空题', true_false: '判断题', short_answer: '简答题' };

const OPTION_KEYS = ['A', 'B', 'C', 'D', 'E', 'F'];

function stripOptionPrefix(text: string, key?: string): string {
  const k = key ? key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '[A-Fa-f]';
  return String(text ?? '').trim().replace(new RegExp(`^(?:选项\\s*)?${k}\\s*[.．、:：)]\\s*`, 'i'), '').trim();
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
  const extracted = extractOptionsFromStem(stem);
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
  if (valid.length >= 2) return { stem: stem.trim(), options: valid };

  // 原始选项有内容但全被占位符过滤 → 回退到清洗后的（保留模型本意）
  if (cleaned.length >= 2) {
    console.warn('[normalizeOptions] 选项文本疑似占位符，保留原始值');
    return { stem: stem.trim(), options: cleaned };
  }

  // 从题干提取
  if (extracted.options.length >= 2) {
    return { stem: extracted.stem || stem, options: extracted.options };
  }

  return { stem: stem.trim(), options: cleaned };
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
  if (!q2.knowledgePoint) q2.knowledgePoint = '综合';
  if (!q2.explanation) q2.explanation = '详见参考答案。';
  q2.literacies = normalizeLiteracies(q2.literacies);
  if (!q2.literacies.length) q2.literacies = ['综合素养'];
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
  const text = raw.trim();
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
): Promise<GeneratedExam> {
  try {
    const weightDist = getWeightDistribution(config.subject, config.grade);
    const mode = (config.durationMinutes ?? 45) <= 15 ? 'quiz' : 'exam';

    // ─── 阶段一：蓝图架构师 ────────────────────
    await onProgress?.({ step: 'blueprint', message: 'blueprint', progress: 5 });
    const weightGuide = buildWeightGuideForPrompt(weightDist);
    const profileContext = userId ? await buildProfileContext(userId, config) : '';
    const scopeQuery = [config.chapters?.join(' '), config.notes].filter(Boolean).join('\n');
    const curriculumContext = await retrieveCurriculum({ subject: config.subject, grade: config.grade, query: scopeQuery }).catch(() => '');
    const styleContext = userId ? await retrieveMistakeStyleSamples(userId, config.subject, config.grade, scopeQuery, [], 3).catch(() => '') : '';
    const enrichedConfig: ExamConfig = { ...config, styleContext };

    await onProgress?.({ step: 'blueprint', message: 'blueprint', progress: 10 });
    const blueprint = await stepBlueprintArchitect(
      model,
      { subject: enrichedConfig.subject, grade: enrichedConfig.grade, totalScore: enrichedConfig.totalScore, notes: enrichedConfig.notes },
      weightGuide,
      [curriculumContext, profileContext, styleContext].filter(Boolean).join('\n\n'),
      mode,
    );

    await onProgress?.({ step: 'blueprint', message: 'blueprint', progress: 20 });

    // ─── 阶段二：题目编写组（按 section × questionType 并发，限 6 路） ────
    const writeTasks = flattenBlueprint(blueprint);
    await onProgress?.({ step: 'write', message: 'write', progress: 25 });

    let completedGroups = 0;
    const writeResults = await withConcurrencyLimit(
      writeTasks.map((task) => async () => {
        const result = await stepWriteQuestionsV2(model, enrichedConfig, task, blueprint, writeTasks, []);
        completedGroups++;
        await onProgress?.({
          step: 'write',
          message: 'write',
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
    await onProgress?.({ step: 'write', message: 'write', progress: 82 });

    // ─── 阶段三：审核委员会（5 维度并发） ──────
    await onProgress?.({ step: 'review', message: 'review', progress: 85 });
    let { scores } = await reviewBoard(model, questions, { subject: enrichedConfig.subject, grade: enrichedConfig.grade }, blueprint);
    const regeneratedIndices = new Set<number>();
    const qualityWarnings = new Set<number>();

    let regenCount = scores.filter(s => s.needsRegeneration).length;
    await onProgress?.({ step: 'review', message: 'review', progress: 90 });

    const maxRegenerationRounds = 3;
    for (let round = 1; regenCount > 0 && round <= maxRegenerationRounds; round++) {
      await onProgress?.({ step: 'regenerate', message: 'regenerate', progress: Math.min(98, 90 + round * 2) });
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
      for (const index of regenResult.report.regeneratedIndices) regeneratedIndices.add(index);
      for (const index of regenResult.report.qualityWarnings) qualityWarnings.add(index);

      await onProgress?.({ step: 'review', message: 'review', progress: Math.min(99, 92 + round * 2) });
      const nextReview = await reviewBoard(model, questions, { subject: enrichedConfig.subject, grade: enrichedConfig.grade }, blueprint);
      scores = nextReview.scores;
      regenCount = scores.filter(s => s.needsRegeneration).length;
      if (regenCount > 0) {
        console.warn(`[exam] 第 ${round} 轮重出后仍有 ${regenCount} 题未通过质量审核`);
      }
    }

    const stillFailing = scores.filter(s => s.needsRegeneration);
    for (const s of stillFailing) qualityWarnings.add(s.index);
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
      throw new Error(`试卷质量审核未通过：${summary}`);
    }

    await onProgress?.({ step: 'complete', message: 'complete', progress: 100 });

    if (questions.length === 0) {
      throw new Error('试卷生成失败：没有生成任何有效题目');
    }

    // 修正总分精确等于目标分
    let totalScore = questions.reduce((s, q) => s + q.points, 0);
    const targetTotal = blueprint.totalScore;
    if (totalScore !== targetTotal && questions.length > 0) {
      const diff = targetTotal - totalScore;
      // 把差值调整到最后一题上
      const last = questions[questions.length - 1];
      last.points = Math.max(1, last.points + diff);
      totalScore = questions.reduce((s, q) => s + q.points, 0);
      console.warn(`[exam] 总分 ${totalScore - diff} → ${totalScore}（${diff > 0 ? '补' : '减'}${Math.abs(diff)} 分到第 ${last.index + 1} 题）`);
    }
    const estMinutes = enrichedConfig.durationMinutes ?? Math.max(20, Math.min(90, Math.round(questions.length * 1.5)));

    // ─── TikZ 预渲染：出题阶段直接交给服务器 LaTeX 引擎编译 ────
    {
      const tikzQS = questions.filter(q => tikzSourceTexts(q).some(hasTikzBlocks));
      if (tikzQS.length > 0) {
        await Promise.all(tikzQS.map(async (q) => {
          const svgs: Record<string, string> = {};
          const blocks = tikzSourceTexts(q).flatMap((text) => extractTikzBlocks(text));
          for (const block of blocks) {
            const hash = simpleHash(block.code);
            if (svgs[hash]) continue;
            const tmpDir = mkdtempSync(join(tmpdir(), 'tikz-'));
            try {
              const texPath = join(tmpDir, 'tikz.tex'), pdfPath = join(tmpDir, 'tikz.pdf'), svgPath = join(tmpDir, 'tikz.svg');
              writeFileSync(texPath, `\\documentclass{standalone}\\usepackage{fontspec}\\usepackage{xeCJK}\\setCJKmainfont{Noto Sans CJK SC}\\usepackage{tikz}\\usetikzlibrary{shapes,arrows,positioning,calc,angles,quotes,intersections,through,math,matrix,fit,patterns,decorations.pathmorphing,decorations.pathreplacing}\\usepackage{pgfplots}\\pgfplotsset{compat=1.18}\\usepackage{xlop}\\begin{document}${block.code}\\end{document}`, 'utf-8');
              execSync(`xelatex -no-shell-escape -interaction=nonstopmode -output-directory="${tmpDir}" "${texPath}"`, { timeout: 30000, stdio: 'pipe' });
              if (existsSync(pdfPath)) {
                execSync(`dvisvgm --pdf --no-fonts -o "${svgPath}" "${pdfPath}"`, { timeout: 15000, stdio: 'pipe' });
                if (existsSync(svgPath)) { const svg = execSync(`cat "${svgPath}"`, { encoding: 'utf-8', timeout: 5000 }); if (svg) svgs[hash] = svg; }
              }
            } catch { /* 单个 TikZ 编译失败不影响整卷 */ } finally { try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 清理 */ } }
          }
          if (Object.keys(svgs).length) q.tikzSvgs = svgs;
        }));
      }
    }

    return { title: blueprint.title, questions, totalScore, durationMinutes: estMinutes, blueprint, qualityReport };
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
        return toValidatedExamQuestions(questions, task);
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
      if (questions.length > 0) return toValidatedExamQuestions(questions, task);
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

function toValidatedExamQuestions(rawQuestions: any[], task: WriteTask): ExamQuestion[] {
  if (rawQuestions.length !== task.count) {
    throw new Error(`出题数量不匹配：期望 ${task.count} 道，实际 ${rawQuestions.length} 道`);
  }
  const questions = rawQuestions.map((q: any, i: number) => localFormatFix(toExamQuestion(q, task, i), i));
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
    multiple_choice: `{"questions":[{"stem":"题干（不要含选项字母）","options":[{"key":"A","text":"选项1"},{"key":"B","text":"选项2"},{"key":"C","text":"选项3"},{"key":"D","text":"选项4"}],"correctKeys":["A"],"multiSelect":false,"knowledgePoint":"考点名称","knowledgePointId":123,"literacies":["核心素养1"],"difficulty":"medium","explanation":"解析内容"}]}`,
    fill_blank: `{"questions":[{"stem":"题干 ____","blanks":[{"acceptedAnswers":["标准答案"]}],"knowledgePoint":"考点名称","knowledgePointId":123,"literacies":["核心素养"],"difficulty":"medium","explanation":"解析内容"}]}`,
    true_false: `{"questions":[{"stem":"判断题陈述","answer":true,"knowledgePoint":"考点名称","knowledgePointId":123,"literacies":["核心素养"],"difficulty":"medium","explanation":"解析内容"}]}`,
    short_answer: `{"questions":[{"stem":"题干内容","referenceAnswer":"参考答案","keyPoints":["要点1","要点2"],"knowledgePoint":"考点名称","knowledgePointId":123,"literacies":["核心素养"],"difficulty":"medium","explanation":"解析内容"}]}`,
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
function toExamQuestion(raw: any, task: WriteTask, index: number): ExamQuestion {
  const base: ExamQuestion = {
    index,
    type: task.questionType as ExamQuestion['type'],
    points: task.pointsPer,
    stem: raw.stem ?? '',
    passage: normalizeOptionalPassage(raw.passage),
    knowledgePoint: raw.knowledgePoint ?? task.focusKps[0] ?? '综合',
    knowledgePointId: raw.knowledgePointId,
    literacies: normalizeLiteracies(raw.literacies),
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
      lines.push(`  - #${item.id} ${item.title} (${item.classHours}课时)`);
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
  onProgress?: ExamGradingProgressFn,
): Promise<ExamResults> {
  await onProgress?.({ step: 'grade', message: 'grade', progress: 12 });
  const answerMap = new Map(answers.map(a => [a.questionIndex, a.answer]));
  const shortAnswerGrader = model ? createShortAnswerGrader(model) : undefined;

  const questionResults: ExamQuestionResult[] = await Promise.all(questions.map(async (q) => {
    const answer = answerMap.get(q.index);
    if (!answer) {
      return { index: q.index, correct: false, score: 0, maxScore: q.points, reference: '', explanation: q.explanation || '', knowledgePoint: q.knowledgePoint, knowledgePointId: q.knowledgePointId, literacy: normalizeLiteracies(q.literacies) };
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
      knowledgePointId: q.knowledgePointId,
      literacy: normalizeLiteracies(q.literacies),
    };
  }));

  await onProgress?.({ step: 'grade', message: 'grade', progress: 58 });

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

export function getExamSession(examId: string, userId: string): ExamSession | null {
  const row = db.prepare(`SELECT * FROM exam_sessions WHERE id=? AND user_id=?`).get(examId, userId) as any;
  if (!row) return null;
  const questions = (JSON.parse(row.questions) as ExamQuestion[]).map((q, i) => localFormatFix(q, i));
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
  const results = await gradeExam(session.questions, answers, model, { subject: session.subject, grade: session.grade }, onProgress);
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

  await onProgress?.({ step: 'save', message: 'save', progress: 94 });
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`UPDATE exam_sessions SET status='completed', answers=?, results=?, submitted_at=? WHERE id=? AND user_id=?`).run(JSON.stringify(answers), JSON.stringify(results), now, examId, userId);
  await onProgress?.({ step: 'complete', message: 'complete', progress: 100 });

  return results;
}
