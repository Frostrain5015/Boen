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
import type { ExamQuestion, ExamResults, AnswerPayload, ExamQuestionResult, ExamSummary } from '@boen/shared';
import { gradeAnswer } from '@boen/agent-core';
import type { ShortAnswerGrader } from '@boen/agent-core';
import { getWeightDistribution, WEIGHT_TIERS } from './kg-weights.js';
import { updateProficiency, getWeakPoints, getRecommendedKPs } from './knowledge-profile.js';
import db from './db.js';
import { getExamStructure, getStructureByTotalScore, getQuestionTypesForMode, type ExamStructure } from './exam-structures.js';

// ── 配置类型 ─────────────────────────────────

export interface ExamConfig {
  subject: string;
  grade: string;
  chapters?: string[];
  totalScore?: number;
  durationMinutes?: number;
  /** 用户备注：期望考查的教材章节、知识点或其他特殊要求 */
  notes?: string;
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
  step: 'analyze' | 'write' | 'review';
  message: string;
  progress?: number; // 0-100
}
export type ExamProgressFn = (p: ExamProgress) => void | Promise<void>;

// ── 重试工具 ──────────────────────────────

/** 带重试的模型调用，每次重试独立超时 */
async function modelInvokeWithRetry(model: BaseChatModel, prompt: SystemMessage, retries = 2): Promise<any> {
  let lastError: any;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await model.invoke([prompt]);
    } catch (err: any) {
      lastError = err;
      const isTimeout = err?.message?.includes('timeout') || err?.message?.includes('timed out') || err?.name === 'TimeoutError';
      console.warn(`模型调用失败(第${attempt + 1}次): ${err?.message?.slice(0, 80) || err}`);
      if (attempt < retries) {
        // 退避 1s → 2s
        await new Promise(r => setTimeout(r, (attempt + 1) * 1000));
      }
    }
  }
  throw lastError;
}

// ── 通用加固工具 ──────────────────────────

/** 更宽容的 JSON 解析：自动修复 LLM 常见的格式问题 */
function safeParseJson(raw: string): any {
  // 尝试原生解析
  try { return JSON.parse(raw); } catch { /* 继续修复 */ }

  let fixed = raw
    // 中文引号 → 英文引号
    .replace(/["""]/g, '"')
    // 对象 key 没加引号：{a: 1} → {"a": 1}
    .replace(/([{,]\s*)(\w+)(\s*:)/g, '$1"$2"$3')
    // 多余逗号：{a:1,} → {a:1}  [a, ] → [a]
    .replace(/,\s*([}\]])/g, '$1')
    // 单引号 → 双引号（只针对值，不破坏已存在的双引号结构）
    .replace(/'(.*?)'(?=\s*[,}\]])/g, '"$1"')
    // LaTeX 反斜杠修复：非转义反斜杠加倍
    .replace(/\\(?!["\\/bfnrtu])/g, '\\\\')
    .replace(/\\\\begin/g, '\\begin').replace(/\\\\end/g, '\\end')
    .replace(/\\\\[{}\\]/g, (m: string) => m.replace('\\\\', '\\'))
    // 去除 \n 字面量（LLM 有时会输出字面 \n 而非真正换行）
    .replace(/\\n/g, '\\n');

  try { return JSON.parse(fixed); } catch {}
  // 终极兜底：尝试提取最外层 {…} 或 […]
  const braceMatch = raw.match(/\{[\s\S]*\}/) ?? raw.match(/\[[\s\S]*\]/);
  if (braceMatch) {
    try { return JSON.parse(braceMatch[0]); } catch {}
    try { return JSON.parse(braceMatch[0].replace(/,\s*([}\]])/g, '$1')); } catch {}
  }
  throw new Error('JSON 解析失败');
}

/** 默认试卷蓝图（stepAnalyze 降级用） */
function defaultBlueprint(
  subjectLabel: Record<string, string>, gradeLabel: (g: string) => string, config: ExamConfig,
) {
  const totalScore = config.totalScore || 100;
  return {
    title: `${subjectLabel[config.subject] ?? config.subject}${gradeLabel(config.grade)}综合试卷`,
    sections: 3, totalScore,
    questionTypes: blueprintForTotalScore(totalScore, config.grade, 'exam'),
  };
}

// ── 固定题分与配比 ────────────────────────

/** 各题型固定基础分值（不因总分档位变化） */
const FIXED_POINTS: Record<string, number> = {
  multiple_choice: 3,
  fill_blank: 3,
  true_false: 2,
  short_answer: 8,
};

/** 根据年级、模式和总分返回题型配比（从知识库按需加载） */
function blueprintForTotalScore(totalScore: number, grade?: string, mode: 'exam' | 'quiz' = 'exam'): Array<{ type: string; label: string; count: number; pointsPer: number; focusKps: string[] }> {
  const gradeStr = grade ?? '7';
  const { questionTypes } = getQuestionTypesForMode(gradeStr, mode, totalScore);
  return questionTypes.map(qt => ({
    type: qt.type,
    label: qt.label,
    count: qt.count,
    pointsPer: FIXED_POINTS[qt.type] ?? qt.pointsPer,
    focusKps: [] as string[],
  }));
}

// ── 考试生成（三步流水线） ──────────────────

export async function generateExam(
  model: BaseChatModel,
  config: ExamConfig,
  onProgress?: ExamProgressFn,
  userId?: string,
): Promise<{ title: string; questions: ExamQuestion[]; totalScore: number; durationMinutes: number }> {
  try {
    const weightDist = getWeightDistribution(config.subject, config.grade);

    // ─── Step 1: 规划 ───────────────────────────
    await onProgress?.({ step: 'analyze', message: '正在分析知识图谱与权重分布…', progress: 5 });
    const weightGuide = buildWeightGuideForPrompt(weightDist);
    const profileContext = userId ? await buildProfileContext(userId, config) : '';
    await onProgress?.({ step: 'analyze', message: '正在生成试卷蓝图…', progress: 10 });
    const blueprint = await stepAnalyze(model, config, weightGuide, profileContext);

  await onProgress?.({ step: 'analyze', message: `蓝图生成完成：${blueprint.title}，共 ${blueprint.sections} 个板块`, progress: 20 });

  // 标准化：用固定基础分值覆盖 LLM 自由分配的点数，仅保留题型数量和配比
  const mode = (config.durationMinutes ?? 45) <= 15 ? 'quiz' : 'exam';
  const fixedTypes = blueprintForTotalScore(config.totalScore ?? blueprint.totalScore, config.grade, mode);
  blueprint.questionTypes = blueprint.questionTypes.map((qt, i) => ({
    ...qt,
    pointsPer: FIXED_POINTS[qt.type] ?? qt.pointsPer,
    count: fixedTypes.find(t => t.type === qt.type)?.count ?? qt.count,
  }));
  // 重新计算总分
  blueprint.totalScore = blueprint.questionTypes.reduce((s, qt) => s + qt.count * qt.pointsPer, 0);

  // ─── Step 2: 出题（并发：4 种题型同时编写） ──
  await onProgress?.({ step: 'write', message: '正在并行编写试题…', progress: 25 });
  const allQuestions: ExamQuestion[] = [];

  const writeResults = await Promise.allSettled(
    blueprint.questionTypes.map(qt =>
      stepWriteQuestions(model, config, qt, blueprint, [])
    )
  );
  for (const r of writeResults) {
    if (r.status === 'fulfilled') allQuestions.push(...r.value);
    else console.error(`出题失败:`, r.reason?.message?.slice(0, 100));
  }

  await onProgress?.({ step: 'write', message: `已完成 ${allQuestions.length} 道题`, progress: 85 });

  // ─── Step 3: 审核 ───────────────────────────
  await onProgress?.({ step: 'review', message: '正在审核试卷格式…', progress: 88 });
  const reviewed = await stepReview(model, allQuestions, config, blueprint, onProgress);

  await onProgress?.({ step: 'review', message: `审核完成，共 ${reviewed.questions.length} 道题`, progress: 100 });

  // 安全兜底：极端情况下 0 道题 → 注入一道默认题
  if (reviewed.questions.length === 0) {
    const defaultQs: ExamQuestion[] = [{
      index: 0, type: 'multiple_choice', points: Math.max(reviewed.totalScore || 100, 10),
      stem: '请选出正确答案。', knowledgePoint: '综合', literacies: ['综合素养'],
      difficulty: 'medium', explanation: '本题为备选题目。',
      options: [{ key: 'A', text: 'A' }, { key: 'B', text: 'B' }, { key: 'C', text: 'C' }, { key: 'D', text: 'D' }],
      correctKeys: ['A'], multiSelect: false,
    }];
    return { title: blueprint.title, questions: defaultQs, totalScore: defaultQs[0].points, durationMinutes: config.durationMinutes ?? 20 };
  }

  const estMinutes = config.durationMinutes ?? Math.max(20, Math.min(90, Math.round(reviewed.questions.length * 1.5)));
  return { title: blueprint.title, questions: reviewed.questions, totalScore: reviewed.totalScore, durationMinutes: estMinutes };
  } catch (e: any) {
    console.error('生成试卷失败:', e?.message?.slice(0, 200));
    throw new Error(`生成试卷失败：${e?.message || '未知错误'}`);
  }
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
    `总分：${totalScore}分。`,
    config.notes ? `用户特殊要求：${config.notes}` : '',
    `知识点权重分布（用于决定题目分布）：\n${weightGuide}`,
    profileContext ? `\n学生学情：\n${profileContext}` : '',
    '',
    '输出 JSON 格式的试卷蓝图：',
    '```json',
    `{"title":"${subjectLabel[config.subject] ?? config.subject}${gradeLabel(config.grade)}试卷","sections":3,"totalScore":${totalScore},"questionTypes":[{"type":"multiple_choice","label":"选择题","count":8,"pointsPer":5,"focusKps":[]},{"type":"fill_blank","label":"填空题","count":4,"pointsPer":5,"focusKps":[]},{"type":"true_false","label":"判断题","count":3,"pointsPer":5,"focusKps":[]},{"type":"short_answer","label":"简答题","count":2,"pointsPer":10,"focusKps":[]}]}`,
    '```',
    `各题型 pointsPer * count 之和必须等于总分 ${totalScore}。选择题不超过 10 道。`,
    '排版：公式一律用 KaTeX。行内 $...$、行间 $$...$$（独占一行）。$$ 必须成对出现：开头 $$ + 内容 + 结尾 $$。定理、定义、重要公式用行间公式。',
  ].filter(Boolean).join('\n');

  let response;
  try {
    response = await model.invoke([new SystemMessage(prompt)]);
  } catch {
    // 模型调用失败走默认蓝图
    return defaultBlueprint(subjectLabel, gradeLabel, config);
  }
  const content = typeof response.content === 'string' ? response.content : '';
  const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  const jsonStr = (jsonMatch ? jsonMatch[1].trim() : content.trim()).replace(/^[^{]*({[\s\S]*})[^}]*$/, '$1');

  try {
    const parsed = safeParseJson(jsonStr);
    return {
      title: parsed.title || `${subjectLabel[config.subject]}试卷`,
      sections: parsed.sections || 3,
      totalScore: parsed.totalScore || (config.totalScore || 100),
      questionTypes: (parsed.questionTypes || []).map((qt: any) => ({
        type: qt.type, label: qt.label, count: qt.count || 3, pointsPer: qt.pointsPer || 5, focusKps: qt.focusKps || [],
      })),
    };
  } catch {
    return defaultBlueprint(subjectLabel, gradeLabel, config);
  }
}

/** 把 AI 可能返回的字符串格式 literacies 归一化为数组 */
function normalizeLiteracies(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((l): l is string => typeof l === 'string');
  if (typeof raw === 'string') return raw.split(/[,，、\s]+/).filter(Boolean);
  return ['综合素养'];
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
    `每题 ${qt.pointsPer} 分。`,
    qt.focusKps.length ? `重点考查知识点：${qt.focusKps.join('、')}` : '',
    config.notes ? `用户特殊要求：${config.notes}` : '',
    `试卷标题：${blueprint.title}`,
    existingQuestions.length ? `已出的题目类型：${[...new Set(existingQuestions.map(q => q.type))].join('、')}。请避免知识点重复。` : '',
    '⚠ 重要：各题之间的题干情景、数据、设问必须差异化。同一组数字或同一道应用题情景不能在不同题目中原样出现。',
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
    '分步设问：如果多题共享同一段阅读材料或同一个题干场景（如阅读理解、几何大题），给它们相同的 groupId（数字），并将共享内容写在第一题的 passage 字段中，后续同组题不再重复 passage。没有分组的题不填 groupId。',
    '排版：公式/方程一律用 KaTeX。行内用 $...$（如 $y = 3x - 5$），行间用 $$...$$ 独占一行（如 $$\\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}$$）。**$$ 必须成对出现**：开头 $$ + 内容 + 结尾 $$，绝不能只有结尾没有开头。**定理、定义、重要公式、推导必须用行间公式 $$...$$**。',
    '题目涉及几何图形、函数图像、受力分析、电路、坐标系、统计图等可视化内容时，',
    '在 stem（或 explanation）里用 TikZ 代码块（```tikz ... ```）画示意图，前端会编译成矢量图——直观的示意图更利于学生理解；不要用字符拼图。',
    ...((config.grade === '2' || config.grade === '3')
      ? ['列竖式计算用 \\opadd / \\opsub / \\opmul / \\opdiv 直接写在题干文本中（如 \\opadd{698}{213}），前端自动渲染为竖式。']
      : []),
    '注意：stem 是 JSON 字符串，内部的反斜杠和换行需正确转义（如 \\\\begin、\\\\draw、\\n）。',
  ].filter(Boolean).join('\n');

  try {
    const response = await model.invoke([new SystemMessage(prompt)]);
    const content = typeof response.content === 'string' ? response.content : '';
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    const jsonStr = (jsonMatch ? jsonMatch[1].trim() : content.trim()).replace(/^[^{]*({[\s\S]*})[^}]*$/, '$1');

    let parsed: any;
    try {
      parsed = safeParseJson(jsonStr);
    } catch {
      throw new Error('JSON 解析失败');
    }
    return (parsed.questions || []).map((q: any, i: number) => {
      const base: any = { index: i, type: q.type || qt.type, points: q.points ?? qt.pointsPer, stem: q.stem || '', passage: q.passage, knowledgePoint: q.knowledgePoint || (qt.focusKps[i] || ''), literacies: normalizeLiteracies(q.literacies), difficulty: q.difficulty || 'medium', explanation: q.explanation || '', groupId: q.groupId ?? undefined };
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
    // 兜底：用更充实的备选替代（review 阶段会再次标记重出）
    const subjectLabel: Record<string, string> = { chinese: '语文', math: '数学', english: '英语', science: '科学' };
    const subj = subjectLabel[config.subject] ?? '综合';
    const fallbackTemplates: Record<string, () => any> = {
      multiple_choice: () => ({
        stem: `${subj}题：以下关于${subj}基本知识的描述，哪一项是正确的？`,
        options: [
          { key: 'A', text: `${subj}基础知识包括概念、定理和公式` },
          { key: 'B', text: `${subj}只需要记忆不需要理解` },
          { key: 'C', text: `${subj}与日常生活没有关系` },
          { key: 'D', text: `${subj}只需要做题不需要思考` },
        ],
        correctKeys: ['A'], multiSelect: false,
      }),
      fill_blank: () => ({
        stem: `请写出${subj}中的一个核心概念名称：____。`,
        blanks: [{ acceptedAnswers: ['概念', '公式', '定理'] }],
      }),
      true_false: () => ({
        stem: `${subj}学习中，理解比记忆更重要。`,
        answer: true,
      }),
      short_answer: () => ({
        stem: `请简要说明${subj}这一学科最重要的学习方法，并解释原因。`,
        referenceAnswer: `${subj}学习需要理论与实践相结合。`,
        keyPoints: ['学习方法', '理由阐述'],
      }),
    };
    const tpl = fallbackTemplates[qt.type];
    const extra = tpl ? tpl() : {};
    // 兜底也要出够 qt.count 道题，每道用不同情景
    const count = Math.max(qt.count, 1);
    return Array.from({ length: count }, (_, i) => {
      const seeded = { ...(tpl?.() ?? {}) };
      // 为每道兜底题生成不同的 stem（加序号以示区别）
      if (seeded.stem) seeded.stem = `${seeded.stem.replace(/[。！？\s]$/, '')}（${i + 1}）${seeded.stem.includes('？') || seeded.stem.includes('吗') ? '' : '。'}`;
      return {
        index: i, type: qt.type, points: qt.pointsPer,
        stem: seeded.stem ?? `${subj}${qt.label}题（${i + 1}）。`,
        knowledgePoint: '综合', literacies: ['综合素养'],
        difficulty: 'medium',
        explanation: '本题为备选题目，审核阶段将重新生成。',
        ...seeded,
      };
    });
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
  q2.literacies = normalizeLiteracies(q2.literacies);
  if (!q2.literacies.length) q2.literacies = ['综合素养'];
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

  // ── 本地预检：标记显式兜底题 ─────────────────
  const FALLBACK_MARKERS = ['请回答一道', '请回答', '默认题目', 'fallback', '备选题目'];
  const localIssues: Array<{ index: number; issue: string }> = [];
  for (const q of fixed) {
    const stem = q.stem ?? '';
    if (FALLBACK_MARKERS.some(m => stem.includes(m))) {
      localIssues.push({ index: q.index, issue: `题干疑似兜底内容："${stem.slice(0, 30)}"` });
    }
    if (q.type === 'multiple_choice' && (!q.options || q.options.length < 3)) {
      localIssues.push({ index: q.index, issue: `选择题选项不足（${q.options?.length ?? 0}个）` });
    }
  }
  // 本地预检命中的直接重出，不等 LLM
  if (localIssues.length > 0) {
    for (const li of localIssues) {
      const bad = fixed[li.index];
      if (!bad) continue;
      console.warn(`本地预检 Q${li.index + 1}: ${li.issue}，直接重出`);
      await onProgress?.({ step: 'review', message: `重出第 ${li.index + 1} 题（格式问题）…`, progress: 90 });
      try {
        const qt = {
          type: bad.type, label: TYPE_LABELS[bad.type] ?? '题目', count: 1,
          pointsPer: bad.points,
          focusKps: bad.knowledgePoint && bad.knowledgePoint !== '综合' ? [bad.knowledgePoint] : [],
        };
        const others = fixed.filter((_, i) => i !== li.index);
        const regenerated = await stepWriteQuestions(model, config, qt, blueprint, others);
        if (regenerated[0]) fixed[li.index] = localFormatFix({ ...regenerated[0], points: bad.points }, li.index);
      } catch { /* 保留原题 */ }
    }
    fixed = fixed.map((q, i) => localFormatFix(q, i));
  }

  // ── LLM 深度审核（质量 + 内容正确性 + 蓝图匹配） ──
  // 构造每道题的详细快照供审核
  const questionDetails = fixed.map((q) => {
    const lines: string[] = [];
    lines.push(`Q${q.index + 1} | ${TYPE_LABELS[q.type] ?? q.type} | ${q.points}分 | 难度:${q.difficulty} | 考点:${q.knowledgePoint}`);
    lines.push(`  题干: ${q.stem?.slice(0, 200)}`);
    if (q.type === 'multiple_choice' && q.options) {
      for (const o of q.options) {
        const correct = q.correctKeys?.includes(o.key) ? ' ✓' : '';
        lines.push(`  ${o.key}. ${o.text}${correct}`);
      }
    }
    if (q.type === 'true_false') lines.push(`  答案: ${q.answer ? '正确' : '错误'}`);
    if (q.type === 'short_answer') {
      lines.push(`  参考答案: ${(q as any).referenceAnswer ?? '（无）'}`);
      lines.push(`  要点: ${((q as any).keyPoints ?? []).join('、') || '（无）'}`);
    }
    if (q.explanation) lines.push(`  解析: ${q.explanation.slice(0, 120)}`);
    return lines.join('\n');
  }).join('\n\n');

  // 蓝图的考查要求摘要
  const blueprintSummary = blueprint.questionTypes
    .map(qt => `  ${qt.label}（${qt.type}）${qt.count}题×${qt.pointsPer}分，重点考查：${qt.focusKps.join('、') || '综合'}`)
    .join('\n');

  // ── 本地相似性预检：题干去重 ──────────────
  const seenStems = new Set<string>();
  for (const q of fixed) {
    const norm = q.stem?.replace(/\s+/g, '').slice(0, 30) ?? '';
    for (const seen of seenStems) {
      // 编辑距离或公共子串检测：前 30 个字符交集超过 70% 视为雷同
      const common = [...norm].filter(c => seen.includes(c)).length;
      const ratio = Math.max(norm.length, seen.length) > 0 ? common / Math.max(norm.length, seen.length) : 0;
      if (ratio > 0.7) {
        localIssues.push({ index: q.index, issue: `题干与前序题目高度相似（"${norm.slice(0, 20)}…"），疑似雷同` });
        break;
      }
    }
    seenStems.add(norm);
  }

  const currentPoints = fixed.reduce((s, q) => s + q.points, 0);
  const expectedTotal = config.totalScore ?? 100;
  const prompt = [
    '你是一位经验丰富的试卷审核专家。以下是刚刚生成的一套试卷，请逐题审核。',
    '⚠ 注意：4 种题型是并行生成的，各题型之间不知道彼此内容，因此跨题型雷同的风险比以往更高——请重点检查相似性。',
    '',
    '=== 试卷蓝图（考查要求）===',
    blueprintSummary,
    `总分：${expectedTotal} 分`,
    '',
    '=== 各题目详情 ===',
    questionDetails,
    '',
    `当前各题分值和：${currentPoints} 分（应为 ${expectedTotal} 分）`,
    '',
    '### 审核维度',
    '1. **题目间相似性**（★ 最重要）— 各题题干情景、数据、设问是否雷同？不同题型的题目可以用同一知识点，但情景和数据必须差异化。注意检查选择题选项文本是否与填空/简答题干接近。',
    '2. **内容正确性** — 参考答案/解析是否有知识性错误、解法漏洞或逻辑矛盾？',
    '3. **蓝图匹配度** — 题目是否真的考查了 blueprint 指定的知识点？难度是否匹配？',
    '4. **格式完整性** — 题干是否有实质性内容？选择题选项有无明显凑数？题干/解析中的 KaTeX/TikZ/\\op 语法是否正确闭合？',
    '5. **区分度** — 题目是否太 trivial（如选项有常识性送分答案）或超纲？',
    '',
    '### 输出格式',
    '输出 JSON（不要 markdown 代码块）：',
    '{',
    '  "ok": true/false,   // true = 全部合格；false = 有题需要修正',
    '  "issues": [         // 有问题的题目列表，ok=true 时可为空',
    '    { "index": 0, "severity": "error|warn", "issue": "问题描述" }',
    '  ]',
    '}',
    '',
    '注意：',
    '- **绝大多数情况下试卷都是合格的，ok: true 是预期结果**',
    '- 轻微问题（severity=warn）仅在 issues 中说明，不触发重出',
    '- 只有内容/答案有实质性错误才标 error 触发重出',
    '- 不要为了证明自己审核过而挑刺——合格的题直接放过',
  ].join('\n');

  try {
    const response = await model.invoke([new SystemMessage(prompt)]);
    const content = typeof response.content === 'string' ? response.content : '';
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    const jsonStr = (jsonMatch ? jsonMatch[1].trim() : content.trim()).replace(/^[^{]*({[\s\S]*})[^}]*$/, '$1');
    const result = JSON.parse(jsonStr);

    // 只重出 error 级别的题（warn 不放），最多重出全部而非硬编码 3 道
    const errorIssues = (result.issues ?? [])
      .filter((it: any) => it?.severity === 'error' && typeof it.index === 'number' && it.index >= 0 && it.index < fixed.length);

    const warnMessages = (result.issues ?? [])
      .filter((it: any) => it?.severity === 'warn')
      .map((it: any) => `Q${it.index + 1}: ${it.issue}`);

    if (warnMessages.length > 0) {
      console.warn(`审核警告（已放过）: ${warnMessages.join('; ')}`);
    }

    for (const issue of errorIssues) {
      const idx = issue.index;
      const bad = fixed[idx];
      console.warn(`审核发现问题 Q${idx + 1}: ${issue.issue}，正在重出…`);
      await onProgress?.({
        step: 'review',
        message: `重出第 ${idx + 1} 题（${errorIssues.indexOf(issue) + 1}/${errorIssues.length}）…`,
        progress: 92 + Math.round((errorIssues.indexOf(issue) / errorIssues.length) * 6),
      });
      try {
        const qt = {
          type: bad.type, label: TYPE_LABELS[bad.type] ?? '题目', count: 1,
          pointsPer: bad.points,
          focusKps: bad.knowledgePoint && bad.knowledgePoint !== '综合' ? [bad.knowledgePoint] : [],
        };
        const others = fixed.filter((_, i) => i !== idx);
        const regenerated = await stepWriteQuestions(model, config, qt, blueprint, others);
        if (regenerated[0]) fixed[idx] = localFormatFix({ ...regenerated[0], points: bad.points }, idx);
      } catch (e: any) {
        console.warn(`Q${idx + 1} 重出失败，保留原题:`, e?.message?.slice(0, 80));
      }
    }
    // 重出后重新编号
    fixed = fixed.map((q, i) => localFormatFix(q, i));
  } catch (e: any) {
    // 审核失败不阻断整卷生成
    console.warn('审核阶段 LLM 调用/解析失败，已跳过:', e?.message?.slice(0, 100));
  }

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
    } catch { /* 分析失败不阻断评分结果 */ }
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
  const base: Record<string, unknown> = { stem: q.stem, explanation: q.explanation ?? '', knowledgePoint: q.knowledgePoint, literacies: normalizeLiteracies(q.literacies), difficulty: q.difficulty };
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

  // 更新知识画像并记录变化
  const proficiencyChanges: Array<{ kpTitle: string; before: number; after: number; score: number; maxScore: number }> = [];
  for (const qr of results.questionResults) {
    if (!qr.knowledgePoint) continue;
    const kps = qr.knowledgePoint.split(/[；;]/).map(s => s.trim()).filter(Boolean);
    for (const kp of kps) {
      const node = findKnowledgePointNode(kp, session.subject);
      if (!node) continue;
      // 记录更新前
      const oldRow = db.prepare('SELECT weighted_score FROM user_kp_proficiency WHERE user_id=? AND kg_node_id=?').get(userId, node.id) as { weighted_score: number } | undefined;
      const before = oldRow?.weighted_score ?? -1;
      updateProficiency(userId, node.id, qr.score, qr.maxScore);
      // 记录更新后
      const newRow = db.prepare('SELECT weighted_score FROM user_kp_proficiency WHERE user_id=? AND kg_node_id=?').get(userId, node.id) as { weighted_score: number } | undefined;
      const after = newRow?.weighted_score ?? -1;
      if (before !== after || before === -1) {
        proficiencyChanges.push({ kpTitle: kp, before: Math.max(0, before), after, score: qr.score, maxScore: qr.maxScore });
      }
    }
  }
  if (proficiencyChanges.length) results.proficiencyChanges = proficiencyChanges;

  return results;
}
