/**
 * exam.ts — 考试模式：生成试卷 + 批量批改 + 分层报告
 *
 * 与复习模式不同，考试模式不经过 LangGraph 图。
 * 直接调用 LLM 一次性生成完整试卷，学生全部答完后统一提交批改。
 */

import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { SystemMessage } from '@langchain/core/messages';
import type { ExamQuestion, ExamResults, AnswerPayload, ExamQuestionResult } from '@boen/shared';
import { gradeAnswer } from '@boen/agent-core';
import { getWeightDistribution, WEIGHT_TIERS } from './kg-weights.js';
import { updateProficiency } from './knowledge-profile.js';
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

// ── 考试生成 ─────────────────────────────────

export async function generateExam(
  model: BaseChatModel,
  config: ExamConfig,
): Promise<{ title: string; questions: ExamQuestion[]; totalScore: number; durationMinutes: number }> {
  const weightDist = getWeightDistribution(config.subject, config.grade);
  const weightGuide = buildWeightGuideForPrompt(weightDist);
  const prompt = buildExamPrompt(config, weightGuide);

  const response = await model.invoke([new SystemMessage(prompt)]);
  const content = typeof response.content === 'string' ? response.content : '';
  const exam = parseExamResponse(content);

  // 自动计算限时：每题 1.5 分钟，最少 20 分钟，最多 90 分钟
  const estMinutes = Math.max(20, Math.min(90, Math.round(exam.questions.length * 1.5)));
  const durationMinutes = config.durationMinutes ?? estMinutes;

  return { ...exam, durationMinutes };
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

function buildExamPrompt(config: ExamConfig, weightGuide: string): string {
  const { subject, grade, difficulty = 'medium', totalScore = 100 } = config;
  const subjectLabel: Record<string, string> = { chinese: '语文', math: '数学', english: '英语', science: '科学' };
  const gradeLabel = (g: string) => {
    const n = Number(g);
    return n <= 6 ? `小学${'一二三四五六'[n - 1]}年级` : `初${'一二三'[n - 7]}`;
  };

  return [
    `你是一位经验丰富的中学教师。请为${subjectLabel[subject] ?? subject}（${gradeLabel(grade)}）生成一份标准试卷。`,
    `试卷总分：${totalScore}分。难度级别：${difficulty}。`,
    '',
    weightGuide ? `知识点权重分布（用于决定题目分布）：\n${weightGuide}` : '',
    '',
    '你必须严格按照以下 JSON 格式输出，不要有任何其他文字：',
    '```json',
    '{',
    '  "title": "试卷标题（包含学科和年级信息）",',
    '  "totalScore": 100,',
    '  "questions": [',
    '    {',
    '      "index": 0,',
    '      "type": "multiple_choice",',
    '      "points": 5,',
    '      "stem": "题干",',
    '      "options": [{"key": "A", "text": "选项A"}, {"key": "B", "text": "选项B"}, {"key": "C", "text": "选项C"}, {"key": "D", "text": "选项D"}],',
    '      "correctKeys": ["A"],',
    '      "multiSelect": false,',
    '      "knowledgePoint": "所属知识点",',
    '      "literacies": ["核心素养1", "核心素养2"],',
    '      "difficulty": "medium",',
    '      "explanation": "答案解析"',
    '    }',
    '  ]',
    '}',
    '```',
    '',
    '注意事项：',
    '- 题目覆盖多个知识点，按照权重分布合理分配比例。',
    '- 核心知识点出 40% 的题，重要知识点出 30%，标准知识点出 20%，了解不超过 10%。',
    '- 包含选择题、填空题、判断题、简答题等多种题型。',
    '- 选择题和判断题每题 5 分，填空题每空 5 分，简答题每题 10 分。',
    '- 所有题目要有完整的参考答案和解析。',
    '- 填空题用 blanks 字段：{"blanks": [{"acceptedAnswers": ["答案1", "答案2"]}]}',
    '- 判断题用 answer 字段（boolean），简答题用 referenceAnswer 和 keyPoints。',
    '- knowledgePoint 和 literacies 必须填写。',
  ].join('\n');
}

function parseExamResponse(content: string): { title: string; questions: ExamQuestion[]; totalScore: number } {
  const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  const jsonStr = (jsonMatch ? jsonMatch[1].trim() : content.trim()).replace(/^[^{]*({[\s\S]*})[^}]*$/, '$1');
  const parsed = JSON.parse(jsonStr);

  const questions: ExamQuestion[] = (parsed.questions ?? []).map((q: any, i: number) => {
    const base = {
      index: i,
      type: q.type || 'multiple_choice',
      points: q.points ?? 5,
      stem: q.stem || '',
      passage: q.passage,
      knowledgePoint: q.knowledgePoint,
      literacies: q.literacies ?? [],
      difficulty: q.difficulty ?? 'medium',
      explanation: q.explanation || '',
    };

    if (q.type === 'multiple_choice') {
      return { ...base, type: 'multiple_choice' as const, options: q.options ?? [], correctKeys: q.correctKeys ?? [], multiSelect: q.multiSelect ?? false };
    }
    if (q.type === 'fill_blank') {
      return { ...base, type: 'fill_blank' as const, blanks: q.blanks ?? [] };
    }
    if (q.type === 'true_false') {
      return { ...base, type: 'true_false' as const, answer: q.answer ?? true };
    }
    if (q.type === 'short_answer') {
      return { ...base, type: 'short_answer' as const, referenceAnswer: q.referenceAnswer, keyPoints: q.keyPoints ?? [] };
    }
    return { ...base, type: 'multiple_choice' as const, options: q.options ?? [], correctKeys: q.correctKeys ?? [], multiSelect: false };
  });

  return {
    title: parsed.title || `${parsed.subject ?? ''}试卷`,
    questions,
    totalScore: parsed.totalScore ?? questions.reduce((s: number, q: ExamQuestion) => s + q.points, 0),
  };
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
