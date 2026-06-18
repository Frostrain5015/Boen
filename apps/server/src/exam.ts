/**
 * exam.ts — 考试模式：生成试卷 + 批量批改 + 分层报告
 *
 * 三步生成流程：
 *   1. 规划（Analyze）：分析用户画像+知识图谱+权重 → 试卷蓝图
 *   2. 出题（Write）：按蓝图分步生成各题型题目
 *   3. 审核（Review）：校验格式并修复
 *
 * 每步向前端发送进度 SSE 事件。
 */

import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { SystemMessage, HumanMessage } from '@langchain/core/messages';
import type { ExamQuestion, ExamResults, AnswerPayload, ExamQuestionResult } from '@boen/shared';
import { gradeAnswer } from '@boen/agent-core';
import { getWeightDistribution, WEIGHT_TIERS } from './kg-weights.js';
import { updateProficiency, getWeakPoints, getRecommendedKPs } from './knowledge-profile.js';
import db from './db.js';

// ── 配置类型 ─────────────────────────────────

export interface ExamConfig {
  subject: string;
  grade: string;
  chapters?: string[];
  difficulty?: string;
  totalScore?: number;
  durationMinutes?: number;
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
  results?: ExamResults;
}

/** 进度回调：每步执行时通知前端（可返回 Promise 以保证 SSE 写入有序） */
export interface ExamProgress {
  step: 'analyze' | 'write' | 'review';
  message: string;
  progress?: number; // 0-100
}
export type ExamProgressFn = (p: ExamProgress) => void | Promise<void>;

// ── 考试生成（三步流水线） ──────────────────

export async function generateExam(
  model: BaseChatModel,
  config: ExamConfig,
  onProgress?: ExamProgressFn,
  userId?: string,
): Promise<{ title: string; questions: ExamQuestion[]; totalScore: number; durationMinutes: number }> {
  const weightDist = getWeightDistribution(config.subject, config.grade);

  // ─── Step 1: 规划 ───────────────────────────
  await onProgress?.({ step: 'analyze', message: '正在分析知识图谱与权重分布…', progress: 5 });
  const weightGuide = buildWeightGuideForPrompt(weightDist);
  const profileContext = userId ? await buildProfileContext(userId, config) : '';
  await onProgress?.({ step: 'analyze', message: '正在生成试卷蓝图…', progress: 10 });
  const blueprint = await stepAnalyze(model, config, weightGuide, profileContext);

  await onProgress?.({ step: 'analyze', message: `蓝图生成完成：${blueprint.title}，共 ${blueprint.sections} 个板块`, progress: 20 });

  // ─── Step 2: 出题 ───────────────────────────
  await onProgress?.({ step: 'write', message: '正在编写选择题…', progress: 25 });
  const allQuestions: ExamQuestion[] = [];

  for (let i = 0; i < blueprint.questionTypes.length; i++) {
    const qt = blueprint.questionTypes[i];
    await onProgress?.({
      step: 'write',
      message: `正在编写${qt.label}（${i + 1}/${blueprint.questionTypes.length}）…`,
      progress: 25 + Math.round((i / blueprint.questionTypes.length) * 60),
    });
    const questions = await stepWriteQuestions(model, config, qt, blueprint, allQuestions.flatMap(q => [q]));
    allQuestions.push(...questions);
  }

  await onProgress?.({ step: 'write', message: `已完成 ${allQuestions.length} 道题`, progress: 85 });

  // ─── Step 3: 审核 ───────────────────────────
  await onProgress?.({ step: 'review', message: '正在审核试卷格式…', progress: 88 });
  const reviewed = await stepReview(model, allQuestions, config, blueprint, onProgress);

  await onProgress?.({ step: 'review', message: `审核完成，共 ${reviewed.questions.length} 道题`, progress: 100 });

  const estMinutes = config.durationMinutes ?? Math.max(20, Math.min(90, Math.round(reviewed.questions.length * 1.5)));
  return { title: blueprint.title, questions: reviewed.questions, totalScore: reviewed.totalScore, durationMinutes: estMinutes };
}

// ─── 规划阶段 ────────────────────────────────

interface ExamBlueprint {
  title: string;
  sections: number;
  totalScore: number;
  questionTypes: Array<{ type: string; label: string; count: number; pointsPer: number; focusKps: string[] }>;
}

async function buildProfileContext(userId: string, config: ExamConfig): Promise<string> {
  const weak = getWeakPoints(userId, config.subject, config.grade, 60, 5);
  const recs = getRecommendedKPs(userId, config.subject, config.grade, 5);
  const parts: string[] = [];
  if (weak.length) parts.push('薄弱知识点（应优先考查）：' + weak.map(w => w.title).join('、'));
  if (recs.length) parts.push('推荐强化知识点：' + recs.map(r => r.title).join('、'));
  return parts.join('\n');
}

async function stepAnalyze(model: BaseChatModel, config: ExamConfig, weightGuide: string, profileContext: string): Promise<ExamBlueprint> {
  const subjectLabel: Record<string, string> = { chinese: '语文', math: '数学', english: '英语', science: '科学' };
  const gradeLabel = (g: string) => { const n = Number(g); return n <= 6 ? `小学${'一二三四五六'[n - 1]}年级` : `初${'一二三'[n - 7]}`; };
  const totalScore = config.totalScore ?? 100;

  const prompt = [
    `你是一位经验丰富的考试命题专家。请为${subjectLabel[config.subject] ?? config.subject}（${gradeLabel(config.grade)}）设计一份试卷蓝图。`,
    `难度级别：${config.difficulty || 'medium'}。总分：${totalScore}分。`,
    `知识点权重分布（用于决定题目分布）：\n${weightGuide}`,
    profileContext ? `\n学生学情：\n${profileContext}` : '',
    '',
    '输出 JSON 格式的试卷蓝图：',
    '```json',
    `{"title":"${subjectLabel[config.subject] ?? config.subject}${gradeLabel(config.grade)}试卷","sections":3,"totalScore":${totalScore},"questionTypes":[{"type":"multiple_choice","label":"选择题","count":8,"pointsPer":5,"focusKps":[]},{"type":"fill_blank","label":"填空题","count":4,"pointsPer":5,"focusKps":[]},{"type":"true_false","label":"判断题","count":3,"pointsPer":5,"focusKps":[]},{"type":"short_answer","label":"简答题","count":2,"pointsPer":10,"focusKps":[]}]}`,
    '```',
    `各题型 pointsPer * count 之和必须等于总分 ${totalScore}。选择题不超过 10 道。`,
  ].filter(Boolean).join('\n');

  const response = await model.invoke([new SystemMessage(prompt)]);
  const content = typeof response.content === 'string' ? response.content : '';
  const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  const jsonStr = (jsonMatch ? jsonMatch[1].trim() : content.trim()).replace(/^[^{]*({[\s\S]*})[^}]*$/, '$1');

  try {
    const parsed = JSON.parse(jsonStr);
    return {
      title: parsed.title || `${subjectLabel[config.subject]}试卷`,
      sections: parsed.sections || 3,
      totalScore: parsed.totalScore || (config.totalScore || 100),
      questionTypes: (parsed.questionTypes || []).map((qt: any) => ({
        type: qt.type, label: qt.label, count: qt.count || 3, pointsPer: qt.pointsPer || 5, focusKps: qt.focusKps || [],
      })),
    };
  } catch {
    // 解析失败用默认蓝图
    return {
      title: `${subjectLabel[config.subject]}${gradeLabel(config.grade)}综合试卷`,
      sections: 3, totalScore: config.totalScore || 100,
      questionTypes: [
        { type: 'multiple_choice', label: '选择题', count: 8, pointsPer: 5, focusKps: [] },
        { type: 'fill_blank', label: '填空题', count: 4, pointsPer: 5, focusKps: [] },
        { type: 'true_false', label: '判断题', count: 3, pointsPer: 5, focusKps: [] },
        { type: 'short_answer', label: '简答题', count: 2, pointsPer: 10, focusKps: [] },
      ],
    };
  }
}

// ─── 出题阶段 ────────────────────────────────

async function stepWriteQuestions(
  model: BaseChatModel, config: ExamConfig,
  qt: ExamBlueprint['questionTypes'][0], blueprint: ExamBlueprint,
  existingQuestions: ExamQuestion[],
): Promise<ExamQuestion[]> {
  const subjectLabel: Record<string, string> = { chinese: '语文', math: '数学', english: '英语', science: '科学' };
  const gradeLabel = (g: string) => { const n = Number(g); return n <= 6 ? `小学${'一二三四五六'[n - 1]}年级` : `初${'一二三'[n - 7]}`; };

  const typeInstructions: Record<string, string> = {
    multiple_choice: '选择题：必须包含 4 个选项（A/B/C/D），correctKeys 必须是其中之一。\n格式: {"type":"multiple_choice","stem":"题干","options":[{"key":"A","text":"选项"},...],"correctKeys":["A"],"multiSelect":false}',
    fill_blank: '填空题：用 blanks 数组表示每个空的可接受答案。\n格式: {"type":"fill_blank","stem":"题干____。","blanks":[{"acceptedAnswers":["答案1","答案2"]}]}',
    true_false: '判断题：answer 为 boolean。\n格式: {"type":"true_false","stem":"陈述句","answer":true}',
    short_answer: '简答题：含 referenceAnswer 和 keyPoints。\n格式: {"type":"short_answer","stem":"题干","referenceAnswer":"参考答案","keyPoints":["要点1","要点2"]}',
  };

  const prompt = [
    `你是命题专家。请为${subjectLabel[config.subject] ?? config.subject}（${gradeLabel(config.grade)}）编写 ${qt.count} 道 ${qt.label}。`,
    `难度：${config.difficulty || 'medium'}。每题 ${qt.pointsPer} 分。`,
    qt.focusKps.length ? `重点考查知识点：${qt.focusKps.join('、')}` : '',
    `试卷标题：${blueprint.title}`,
    existingQuestions.length ? `已出的题目类型：${[...new Set(existingQuestions.map(q => q.type))].join('、')}。请避免知识点重复。` : '',
    '',
    typeInstructions[qt.type] || '',
    '',
    '必须严格按以下 JSON 格式输出，且只能输出 JSON，不要有其他文字：',
    '```json',
    `{"questions": [${'{}'.repeat(Math.min(qt.count, 1))}]}`,
    '```',
    '',
    `一次性输出全部 ${qt.count} 道题的数组。每道题必须包含: type, stem, points, knowledgePoint, literacies, difficulty, explanation。`,
    'knowledgePoint 和 literacies 必须填写，不能为空。',
  ].filter(Boolean).join('\n');

  const response = await model.invoke([new SystemMessage(prompt)]);
  const content = typeof response.content === 'string' ? response.content : '';
  const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  const jsonStr = (jsonMatch ? jsonMatch[1].trim() : content.trim()).replace(/^[^{]*({[\s\S]*})[^}]*$/, '$1');

  try {
  let parsed: any;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    // 兜底修复：中文引号、多余逗号、LaTeX 反斜杠
    let fixed = jsonStr
      .replace(/["""]/g, "'")
      .replace(/,\s*([}\]])/g, '$1')
      .replace(/\\(?!["\\/bfnrtu])/g, '\\\\')
      .replace(/\\\\begin/g, '\\begin').replace(/\\\\end/g, '\\end')
      .replace(/\\\\[{}\\]/g, (m) => m.replace('\\\\', '\\'));
    try { parsed = JSON.parse(fixed); }
    catch { throw new Error('JSON 解析失败'); }
  }
    return (parsed.questions || []).map((q: any, i: number) => {
      const base: any = { index: i, type: q.type || qt.type, points: q.points ?? qt.pointsPer, stem: q.stem || '', passage: q.passage, knowledgePoint: q.knowledgePoint || (qt.focusKps[i] || ''), literacies: q.literacies || [], difficulty: q.difficulty || config.difficulty || 'medium', explanation: q.explanation || '' };
      if (base.type === 'multiple_choice') {
        const opts = (q.options || []).filter((o: any) => o?.key);
        while (opts.length < 2) opts.push({ key: String.fromCharCode(65 + opts.length), text: '选项' + String.fromCharCode(65 + opts.length) });
        base.options = opts; base.correctKeys = (q.correctKeys || []).filter((k: string) => opts.some((o: any) => o.key === k));
        if (!base.correctKeys.length) base.correctKeys = [opts[0].key]; base.multiSelect = q.multiSelect ?? false;
      }
      if (base.type === 'fill_blank') { base.blanks = q.blanks || []; }
      if (base.type === 'true_false') { base.answer = q.answer ?? true; }
      if (base.type === 'short_answer') { base.referenceAnswer = q.referenceAnswer || ''; base.keyPoints = q.keyPoints || []; }
      if (!base.knowledgePoint) base.knowledgePoint = '综合';
      if (!base.explanation) base.explanation = '详见参考答案。';
      if (!base.literacies?.length) base.literacies = ['综合素养'];
      return base;
    });
  } catch (e: any) {
    console.error(`出题阶段 ${qt.type} 解析失败:`, e.message?.slice(0, 100));
    // 兜底：返回一道默认题避免前端完全空白
    const fallback: any = { index: 0, type: qt.type, points: qt.pointsPer, stem: `请回答一道${qt.label}。`, knowledgePoint: '综合', literacies: ['综合素养'], difficulty: config.difficulty || 'medium', explanation: '详见参考答案。' };
    if (qt.type === 'multiple_choice') { fallback.options = [{ key: 'A', text: '正确' }, { key: 'B', text: '错误' }]; fallback.correctKeys = ['A']; fallback.multiSelect = false; }
    if (qt.type === 'fill_blank') fallback.blanks = [{ acceptedAnswers: ['答案'] }];
    if (qt.type === 'true_false') fallback.answer = true;
    if (qt.type === 'short_answer') { fallback.referenceAnswer = '参考答案'; fallback.keyPoints = ['要点']; }
    return [fallback];
  }
}

// ─── 审核阶段 ────────────────────────────────

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
  if (!q2.literacies?.length) q2.literacies = ['综合素养'];
  return q2;
}

async function stepReview(
  model: BaseChatModel,
  questions: ExamQuestion[],
  config: ExamConfig,
  blueprint: ExamBlueprint,
  onProgress?: ExamProgressFn,
): Promise<{ questions: ExamQuestion[]; totalScore: number }> {
  if (questions.length === 0) return { questions, totalScore: 0 };

  // 先做本地格式校验并修复
  let fixed = questions.map((q, i) => localFormatFix(q, i));

  // 将整卷发给 LLM 做最终审核（只校验，标记需要重出的题）
  const summary = fixed.map(q => `Q${q.index + 1}[${q.type}] ${q.stem?.slice(0, 40)} KP:${q.knowledgePoint}`).join('\n');
  const prompt = [
    '你是一个试卷审题专家。请检查以下试卷的每道题是否存在格式或质量问题（如题干残缺、选项不足、答案缺失、知识点为空、与其他题重复）。',
    '只检查，不要改写题目内容。',
    '',
    summary,
    '',
    '如果所有题目都合格，输出：{"ok":true}',
    '如果有题目需要重新出，输出：{"ok":false,"issues":[{"index":0,"issue":"描述问题"}]}',
    'index 从 0 开始，对应上面 Q1=0、Q2=1 …',
  ].join('\n');

  try {
    const response = await model.invoke([new SystemMessage(prompt)]);
    const content = typeof response.content === 'string' ? response.content : '';
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    const jsonStr = (jsonMatch ? jsonMatch[1].trim() : content.trim()).replace(/^[^{]*({[\s\S]*})[^}]*$/, '$1');
    const result = JSON.parse(jsonStr);

    if (!result.ok && Array.isArray(result.issues) && result.issues.length) {
      // 只重出有问题的题（最多 3 道，避免审核阶段无限放大耗时）
      const issues = result.issues
        .filter((it: any) => typeof it?.index === 'number' && it.index >= 0 && it.index < fixed.length)
        .slice(0, 3);

      for (let k = 0; k < issues.length; k++) {
        const issue = issues[k];
        const idx = issue.index;
        const bad = fixed[idx];
        console.warn(`审核发现问题 Q${idx + 1}: ${issue.issue}，正在重新出题…`);
        await onProgress?.({ step: 'review', message: `重出第 ${idx + 1} 题（${k + 1}/${issues.length}）…`, progress: 92 + Math.round((k / issues.length) * 6) });
        try {
          const qt = {
            type: bad.type,
            label: TYPE_LABELS[bad.type] ?? '题目',
            count: 1,
            pointsPer: bad.points,
            focusKps: bad.knowledgePoint && bad.knowledgePoint !== '综合' ? [bad.knowledgePoint] : [],
          };
          const others = fixed.filter((_, i) => i !== idx);
          const regenerated = await stepWriteQuestions(model, config, qt, blueprint, others);
          if (regenerated[0]) {
            // 保留原分值与位置，替换题目内容
            fixed[idx] = localFormatFix({ ...regenerated[0], points: bad.points }, idx);
          }
        } catch (e: any) {
          console.warn(`Q${idx + 1} 重出失败，保留原题:`, e?.message?.slice(0, 80));
        }
      }
      // 重出后重新编号兜底
      fixed = fixed.map((q, i) => localFormatFix(q, i));
    }
  } catch { /* 审核失败不阻断整卷生成 */ }

  const totalScore = fixed.reduce((s, q) => s + q.points, 0);
  return { questions: fixed, totalScore };
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

// ── 考试评分 ─────────────────────────────────

export function gradeExam(
  questions: ExamQuestion[],
  answers: Array<{ questionIndex: number; answer: AnswerPayload }>,
): ExamResults {
  const answerMap = new Map(answers.map(a => [a.questionIndex, a.answer]));

  const questionResults: ExamQuestionResult[] = questions.map((q) => {
    const answer = answerMap.get(q.index);
    if (!answer) {
      return { index: q.index, correct: false, score: 0, maxScore: q.points, reference: '', explanation: q.explanation || '', knowledgePoint: q.knowledgePoint, literacy: q.literacies };
    }

    const toolName = questionTypeToToolName(q.type);
    const rawArgs = buildRawArgs(q);
    const { result } = gradeAnswer(toolName, rawArgs, answer);

    const scaledScore = result.correct === true ? q.points : (q.type === 'fill_blank' && result.perBlank ? Math.round((result.score / result.maxScore) * q.points) : 0);

    return {
      index: q.index,
      correct: result.correct,
      score: scaledScore,
      maxScore: q.points,
      reference: result.reference,
      explanation: result.explanation,
      knowledgePoint: q.knowledgePoint,
      literacy: q.literacies,
    };
  });

  const totalScore = questionResults.reduce((s, r) => s + r.score, 0);
  const maxScore = questionResults.reduce((s, r) => s + r.maxScore, 0);
  const percentage = maxScore > 0 ? Math.round((totalScore / maxScore) * 100) : 0;

  const grade = percentage >= 90 ? '优秀' : percentage >= 75 ? '良好' : percentage >= 60 ? '及格' : '需努力';

  return {
    totalScore, maxScore, percentage, grade,
    questionResults,
    tierBreakdown: computeTierBreakdown(questions, questionResults),
    kpBreakdown: computeKpBreakdown(questionResults),
    literacyBreakdown: computeLiteracyBreakdown(questionResults),
  };
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

function computeLiteracyBreakdown(results: ExamQuestionResult[]): Array<{ literacy: string; score: number; maxScore: number }> {
  const map = new Map<string, { score: number; maxScore: number }>();
  for (const r of results) {
    for (const lit of r.literacy ?? []) {
      const prev = map.get(lit) ?? { score: 0, maxScore: 0 };
      prev.score += r.score;
      prev.maxScore += r.maxScore;
      map.set(lit, prev);
    }
  }
  return Array.from(map.entries()).map(([lit, v]) => ({ literacy: lit, score: v.score, maxScore: v.maxScore }));
}

function getKpTier(kp: string): string {
  const node = db.prepare(`SELECT weight FROM kg_nodes WHERE type='knowledge_point' AND title=?`).get(kp) as { weight: number } | undefined;
  if (!node) return 'Standard';
  if (node.weight >= 0.75) return 'Core';
  if (node.weight >= 0.5) return 'Important';
  return 'Standard';
}

// ── 辅助 ────────────────────────────────────

function questionTypeToToolName(type: string): string {
  const map: Record<string, string> = { multiple_choice: 'ask_multiple_choice', fill_blank: 'ask_fill_blank', true_false: 'ask_true_false', short_answer: 'ask_short_answer' };
  return map[type] || 'ask_multiple_choice';
}

function buildRawArgs(q: ExamQuestion): Record<string, unknown> {
  const base: Record<string, unknown> = { stem: q.stem, explanation: q.explanation ?? '', knowledgePoint: q.knowledgePoint, literacies: q.literacies, difficulty: q.difficulty };
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
    results: row.results ? JSON.parse(row.results) : undefined,
  };
}

export function submitExamSession(examId: string, userId: string, answers: Array<{ questionIndex: number; answer: AnswerPayload }>): ExamResults {
  const session = getExamSession(examId, userId);
  if (!session) throw new Error('考试会话未找到');
  if (session.status === 'completed') throw new Error('该考试已提交');

  const results = gradeExam(session.questions, answers);
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`UPDATE exam_sessions SET status='completed', answers=?, results=?, submitted_at=? WHERE id=? AND user_id=?`).run(JSON.stringify(answers), JSON.stringify(results), now, examId, userId);

  // 更新知识画像
  for (const qr of results.questionResults) {
    if (qr.knowledgePoint) {
      const node = db.prepare(`SELECT id FROM kg_nodes WHERE type='knowledge_point' AND title=?`).get(qr.knowledgePoint) as { id: number } | undefined;
      if (node) updateProficiency(userId, node.id, qr.score, qr.maxScore);
    }
  }

  return results;
}
