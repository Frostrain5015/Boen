import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import { serve } from '@hono/node-server';
import { HumanMessage, SystemMessage, ToolMessage, type BaseMessage, type AIMessage } from '@langchain/core/messages';
import {
  getChatModel,
  buildBoenGraph,
  QUIZ_TOOL_NAMES,
  COMPLETE_REVIEW_TOOL,
  toQuestionPayload,
  gradeAnswer,
} from '@boen/agent-core';
import type { ChatRequest, AnswerRequest, SseEvent } from '@boen/shared';
import db from './db.js';
import { lookupKnowledgePoint, retrieveCurriculum } from './curriculum.js';
import { getNodesByType, getNeighbors, getKgContextForUnit, formatKgContext, ensureKnowledgeGraphTables } from './knowledge-graph.js';
import { getWeightInfo, getWeightDistribution, formatWeightGuide } from './kg-weights.js';
import { updateProficiency, getAllProficiencies, getWeakPoints, getStrongPoints, getLiteracyProficiency, getRecommendedKPs, getPrerequisiteWeaknessChain, getProfileOutline, seedProficiencyFromHistory } from './knowledge-profile.js';
import { execSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  createConversation,
  getConversations,
  getConversation,
  updateConversationTitle,
  deleteConversation,
  addMessage,
  getMessages,
  getRecentMessages,
} from './conversation.js';

// 从仓库根加载 .env
const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(__dirname, '../../../.env') });

const provider = (process.env.BOEN_PROVIDER ?? 'openai') as 'openai' | 'anthropic';
const model = getChatModel({
  provider,
  model: process.env.BOEN_MODEL ?? 'astron-code-latest',
  apiKey: process.env.BOEN_API_KEY ?? '',
  baseUrl: process.env.BOEN_BASE_URL,
});
// RAG 检索器注入：agent-core 的 loadCurriculum 节点据此召回课程知识库（按年级+学科）
const graph = buildBoenGraph(model, { retrieveCurriculum, lookupKnowledgePoint });

// ── Frost ID：服务端换 token（内网直连，client_secret 只留服务端）──
const FROST_ID_INTERNAL_URL = process.env.FROST_ID_INTERNAL_URL ?? 'http://127.0.0.1:4000';
const FROST_ID_CLIENT_ID = process.env.FROST_ID_CLIENT_ID ?? 'boen-client';
const FROST_ID_CLIENT_SECRET = process.env.FROST_ID_CLIENT_SECRET ?? '';

// 用 Bearer token 经 Frost ID 内网 userinfo 解析出用户 id（sub），带短缓存避免每请求开销
const userIdCache = new Map<string, { sub: string; exp: number }>();
async function resolveUserId(c: Context): Promise<string | null> {
  const authz = c.req.header('authorization');
  if (!authz?.startsWith('Bearer ')) return null;
  const token = authz.slice(7);
  const cached = userIdCache.get(token);
  if (cached && cached.exp > Date.now()) return cached.sub;
  try {
    const res = await fetch(`${FROST_ID_INTERNAL_URL}/oauth/userinfo`, { headers: { Authorization: authz } });
    if (!res.ok) return null;
    const data = (await res.json()) as { sub?: string };
    if (!data.sub) return null;
    userIdCache.set(token, { sub: data.sub, exp: Date.now() + 5 * 60_000 });
    return data.sub;
  } catch {
    return null;
  }
}

type ToolCall = { id?: string; name: string; args: Record<string, unknown> };
const runConfig = (threadId: string) => ({ version: 'v2' as const, configurable: { thread_id: threadId } });

/** 流式跑一次图：推送 token，结束后返回最后一条消息 */
async function runGraph(
  input: Record<string, unknown>,
  threadId: string,
  send: (e: SseEvent) => Promise<void>,
): Promise<BaseMessage | undefined> {
  const events = graph.streamEvents(input, runConfig(threadId));
  let quizSignaled = false; // 「博文正在出题」只发一次
  for await (const ev of events) {
    if (ev.event === 'on_chat_model_stream') {
      const chunk = ev.data?.chunk as
        | { content?: unknown; tool_call_chunks?: Array<{ name?: string }> }
        | undefined;
      const text = typeof chunk?.content === 'string' ? chunk.content : '';
      if (text) await send({ type: 'token', value: text });
      // 纯工具信号：模型一旦开始流式产出出题工具调用，立即通知前端
      if (!quizSignaled && (chunk?.tool_call_chunks ?? []).some((t) => t.name && QUIZ_TOOL_NAMES.has(t.name))) {
        quizSignaled = true;
        await send({ type: 'quiz_generating' });
      }
    }
  }
  const state = await graph.getState({ configurable: { thread_id: threadId } });
  const msgs = (state.values?.messages ?? []) as BaseMessage[];
  return msgs[msgs.length - 1];
}

/** 检测并发送 review_complete 事件 */
async function emitReviewCompleteIfAny(last: BaseMessage | undefined, send: (e: SseEvent) => Promise<void>) {
  const calls = ((last as AIMessage | undefined)?.tool_calls ?? []) as ToolCall[];
  const reviewCall = calls.find((c) => c.name === COMPLETE_REVIEW_TOOL);
  if (reviewCall?.args) {
    const args = reviewCall.args as Record<string, unknown>;
    await send({
      type: 'review_complete',
      summary: String(args.summary ?? ''),
      score: Number(args.overallScore ?? 0),
      totalQuestions: Number(args.totalQuestions ?? 0),
      correctAnswers: Number(args.correctAnswers ?? 0),
    });
  }
}

/** 为新对话自动生成标题（基于首轮用户消息） */
async function autoGenerateTitle(conversationId: string, userMessage: string, onTitle: (title: string) => Promise<void>) {
  try {
    const result = await model.invoke([
      new SystemMessage('用 2-8 个字概括用户提问的主题，直接输出标题，不要引号和标点。'),
      new HumanMessage(userMessage),
    ]);
    let title = (typeof result.content === 'string' ? result.content : '').trim().replace(/["""']/g, '');
    if (!title) return;
    // 限制标题长度
    if (title.length > 20) title = title.slice(0, 20);
    const conv = getConversation(conversationId);
    if (conv && conv.title === '新对话') {
      updateConversationTitle(conversationId, title);
      await onTitle(title);
    }
  } catch {
    // 标题生成失败不影响主流程
  }
}

/** 若最后一条消息触发了出题工具，推送 question 事件（每次只呈现第一道） */
async function emitQuestionIfAny(last: BaseMessage | undefined, send: (e: SseEvent) => Promise<void>) {
  const calls = ((last as AIMessage | undefined)?.tool_calls ?? []) as ToolCall[];
  const quiz = calls.find((c) => QUIZ_TOOL_NAMES.has(c.name));
  if (quiz?.id) {
    await send({ type: 'question', toolCallId: quiz.id, question: toQuestionPayload(quiz.name, quiz.args) });
  }
}

/**
 * 若上一轮留下未作答的出题工具调用（AIMessage 带 tool_calls 但无 ToolMessage 响应），
 * 生成「跳过」ToolMessage 以保持消息序列合法——否则紧跟 HumanMessage 会让模型 API 报错。
 */
async function pendingSkipToolMessages(threadId: string): Promise<ToolMessage[]> {
  const state = await graph.getState({ configurable: { thread_id: threadId } });
  const msgs = (state.values?.messages ?? []) as BaseMessage[];
  const last = msgs[msgs.length - 1] as AIMessage | undefined;
  const calls = (last?.tool_calls ?? []) as ToolCall[];
  return calls
    .filter((t) => t.id)
    .map((t) => new ToolMessage({ content: '（用户未作答此题，已跳过）', tool_call_id: t.id! }));
}

/** 获取出题工具调用的结果（若最后一条消息触发了出题） */
function extractQuestionPayload(last: BaseMessage | undefined): { toolCallId: string; question: import('@boen/shared').QuestionPayload } | null {
  const calls = ((last as AIMessage | undefined)?.tool_calls ?? []) as ToolCall[];
  const quiz = calls.find((c) => QUIZ_TOOL_NAMES.has(c.name));
  if (quiz?.id) {
    return { toolCallId: quiz.id, question: toQuestionPayload(quiz.name, quiz.args) };
  }
  return null;
}

const app = new Hono();
app.use('/api/*', cors());

app.get('/api/health', (c) => c.json({ ok: true, provider, model: process.env.BOEN_MODEL }));

// ── TiKZ 渲染 API（服务端 PGF/TikZ → SVG）───
/** POST /api/render-tikz — 接收 TikZ 源码，返回 SVG */
app.post('/api/render-tikz', async (c) => {
  const { code } = await c.req.json<{ code?: string }>();
  if (!code?.trim()) return c.json({ error: 'TikZ code required' }, 400);

  const tmpDir = mkdtempSync('/tmp/tikz-');
  const texPath = join(tmpDir, 'tikz.tex');
  const pdfPath = join(tmpDir, 'tikz.pdf');
  const svgPath = join(tmpDir, 'tikz.svg');

  const tex = `\\documentclass[tikz]{standalone}
\\usepackage{tikz}
\\usetikzlibrary{shapes,arrows,positioning,calc,angles,quotes,intersections,through,math,matrix,fit,patterns,decorations.pathmorphing,decorations.pathreplacing}
\\usepackage{pgfplots}
\\pgfplotsset{compat=1.18}
\\begin{document}
${code}
\\end{document}`;

  try {
    writeFileSync(texPath, tex, 'utf-8');
    execSync(`pdflatex -interaction=nonstopmode -output-directory="${tmpDir}" "${texPath}"`, { timeout: 30000, stdio: 'pipe' });
    const pdfExists = existsSync(pdfPath);
    if (!pdfExists) {
      const log = existsSync(join(tmpDir, 'tikz.log')) ? execSync(`tail -30 "${tmpDir}/tikz.log"`, { encoding: 'utf-8' }) : '';
      return c.json({ error: 'pdflatex failed', log }, 500);
    }
    execSync(`dvisvgm --pdf --no-fonts -o "${svgPath}" "${pdfPath}"`, { timeout: 15000, stdio: 'pipe' });
    const svg = existsSync(svgPath) ? execSync(`cat "${svgPath}"`, { encoding: 'utf-8' }) : '';
    if (!svg) return c.json({ error: 'dvisvgm produced empty output' }, 500);
    return c.json({ svg });
  } catch (err) {
    const log = existsSync(join(tmpDir, 'tikz.log')) ? execSync(`tail -30 "${tmpDir}/tikz.log"`, { encoding: 'utf-8' }) : '';
    return c.json({ error: err instanceof Error ? err.message : String(err), log }, 500);
  } finally {
    execSync(`rm -rf "${tmpDir}"`);
  }
});

// ── 知识图谱 API ────────────────────────────
// 初始化表（幂等）
ensureKnowledgeGraphTables();

/** GET /api/kg/nodes?type=theme&subject=math — 按类型查节点 */
app.get('/api/kg/nodes', (c) => {
  const type = c.req.query('type') as any;
  const subject = c.req.query('subject');
  if (!type) return c.json({ error: 'type 参数必填' }, 400);
  const nodes = getNodesByType(type, subject);
  return c.json({ nodes });
});

/** GET /api/kg/neighbors/:nodeId — 查某节点的相邻节点 */
app.get('/api/kg/neighbors/:nodeId', (c) => {
  const nodeId = Number(c.req.param('nodeId'));
  const edgeType = c.req.query('edgeType') as any;
  if (isNaN(nodeId)) return c.json({ error: 'nodeId 无效' }, 400);
  const neighbors = getNeighbors(nodeId, edgeType);
  return c.json({ neighbors });
});

/** GET /api/kg/unit/:unitId — 查某章节的知识图谱上下文 */
app.get('/api/kg/unit/:unitId', (c) => {
  const unitId = Number(c.req.param('unitId'));
  if (isNaN(unitId)) return c.json({ error: 'unitId 无效' }, 400);
  const context = getKgContextForUnit(unitId);
  return c.json({ unitId, context });
});

// ── 知识点权重 API ────────────────────────────
/** GET /api/kg/weights/distribution?subject=math&grade=7 — 权重分布 */
app.get('/api/kg/weights/distribution', (c) => {
  const subject = c.req.query('subject') || 'math';
  const grade = c.req.query('grade');
  const dist = getWeightDistribution(subject, grade);
  return c.json({ subject, grade, total: dist.length, distribution: dist });
});

/** GET /api/kg/weights/guide?subject=math&grade=7 — 出题参考文本 */
app.get('/api/kg/weights/guide', (c) => {
  const subject = c.req.query('subject') || 'math';
  const grade = c.req.query('grade') || '7';
  const guide = formatWeightGuide(subject, grade);
  return c.json({ subject, grade, guide });
});
// ── 知识画像 API ────────────────────────────
/** GET /api/profile/outline?subject=math&grade=7 — 章节树+掌握度 */
app.get('/api/profile/outline', async (c) => {
  const userId = await resolveUserId(c);
  const subject = c.req.query('subject') || 'math';
  const grade = c.req.query('grade') || '7';
  const outline = getProfileOutline(subject, grade, userId ?? undefined);
  return c.json(outline);
});

/** GET /api/profile/proficiency — 用户熟练度数据 */
app.get('/api/profile/proficiency', async (c) => {
  const userId = await resolveUserId(c);
  if (!userId) return c.json({ error: 'unauthorized' }, 401);
  const subject = c.req.query('subject') || 'math';
  const grade = c.req.query('grade');
  const profs = getAllProficiencies(userId, subject, grade);
  return c.json({ proficiencies: profs });
});

/** GET /api/profile/weak-points — 薄弱知识点 */
app.get('/api/profile/weak-points', async (c) => {
  const userId = await resolveUserId(c);
  if (!userId) return c.json({ error: 'unauthorized' }, 401);
  const subject = c.req.query('subject') || 'math';
  const grade = c.req.query('grade');
  const threshold = c.req.query('threshold') ? Number(c.req.query('threshold')) : 60;
  const limit = c.req.query('limit') ? Number(c.req.query('limit')) : 10;
  const weak = getWeakPoints(userId, subject, grade, threshold, limit);
  return c.json({ weakPoints: weak });
});

/** GET /api/profile/strong-points — 优势知识点 */
app.get('/api/profile/strong-points', async (c) => {
  const userId = await resolveUserId(c);
  if (!userId) return c.json({ error: 'unauthorized' }, 401);
  const subject = c.req.query('subject') || 'math';
  const grade = c.req.query('grade');
  const threshold = c.req.query('threshold') ? Number(c.req.query('threshold')) : 75;
  const limit = c.req.query('limit') ? Number(c.req.query('limit')) : 10;
  const strong = getStrongPoints(userId, subject, grade, threshold, limit);
  return c.json({ strongPoints: strong });
});

/** GET /api/profile/literacies — 素养熟练度 */
app.get('/api/profile/literacies', async (c) => {
  const userId = await resolveUserId(c);
  if (!userId) return c.json({ error: 'unauthorized' }, 401);
  const subject = c.req.query('subject') || 'math';
  const lits = getLiteracyProficiency(userId, subject);
  return c.json({ literacies: lits });
});

/** GET /api/profile/recommendations — 练习推荐 */
app.get('/api/profile/recommendations', async (c) => {
  const userId = await resolveUserId(c);
  if (!userId) return c.json({ error: 'unauthorized' }, 401);
  const subject = c.req.query('subject') || 'math';
  const grade = c.req.query('grade') || '7';
  const limit = c.req.query('limit') ? Number(c.req.query('limit')) : 5;
  const recs = getRecommendedKPs(userId, subject, grade, limit);
  return c.json({ recommendations: recs });
});

/** GET /api/profile/weakness-chain/:nodeId — 前置弱点追溯 */
app.get('/api/profile/weakness-chain/:nodeId', async (c) => {
  const userId = await resolveUserId(c);
  if (!userId) return c.json({ error: 'unauthorized' }, 401);
  const nodeId = Number(c.req.param('nodeId'));
  if (isNaN(nodeId)) return c.json({ error: 'nodeId 无效' }, 400);
  const chain = getPrerequisiteWeaknessChain(userId, nodeId);
  return c.json({ chain });
});

/** POST /api/profile/seed — 从历史答题记录回填熟练度 */
app.post('/api/profile/seed', async (c) => {
  const userId = await resolveUserId(c);
  if (!userId) return c.json({ error: 'unauthorized' }, 401);
  const { updated } = seedProficiencyFromHistory(userId);
  return c.json({ updated });
});

import { generateExam, createExamSession, getExamSession, submitExamSession } from './exam.js';

/** POST /api/exam/generate — 生成新试卷 */
app.post('/api/exam/generate', async (c) => {
  const userId = await resolveUserId(c);
  if (!userId) return c.json({ error: 'unauthorized' }, 401);
  const body = await c.req.json() as { subject: string; grade: string; difficulty?: string; durationMinutes?: number };
  if (!body.subject || !body.grade) return c.json({ error: '缺少必填字段：subject, grade' }, 400);
  return streamSSE(c, async (stream) => {
    const send = (e: SseEvent) => stream.writeSSE({ data: JSON.stringify(e) });
    try {
      await send({ type: 'exam_generating' });
      const exam = await generateExam(model, { subject: body.subject, grade: body.grade, difficulty: body.difficulty, durationMinutes: body.durationMinutes });
      const session = createExamSession(userId, {subject:body.subject,grade:body.grade}, exam);
      const publicQuestions = exam.questions.map(q => ({
        index: q.index, type: q.type, stem: q.stem, passage: q.passage, points: q.points,
        knowledgePoint: q.knowledgePoint, difficulty: q.difficulty,
        options: q.type === 'multiple_choice' ? q.options : undefined,
        multiSelect: q.type === 'multiple_choice' ? q.multiSelect : undefined,
        blankCount: q.type === 'fill_blank' ? q.blanks?.length : undefined,
      }));
      await send({ type: 'exam_ready', examId: session.id, title: exam.title, totalQuestions: exam.questions.length, totalScore: exam.totalScore, durationMinutes: exam.durationMinutes });
      await send({ type: 'done' });
    } catch (err) {
      await send({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  });
});

/** POST /api/exam/submit — 提交考试答案 */
app.post('/api/exam/submit', async (c) => {
  const userId = await resolveUserId(c);
  if (!userId) return c.json({ error: 'unauthorized' }, 401);
  const body = await c.req.json() as { examId: string; answers: Array<{ questionIndex: number; answer: any }> };
  if (!body.examId || !body.answers?.length) return c.json({ error: '缺少必填字段' }, 400);
  try {
    const results = submitExamSession(body.examId, userId, body.answers as any);
    return c.json({ success: true, results });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

/** GET /api/exam/:examId — 获取考试详情和结果 */
app.get('/api/exam/:examId', async (c) => {
  const userId = await resolveUserId(c);
  if (!userId) return c.json({ error: 'unauthorized' }, 401);
  const examId = c.req.param('examId');
  const session = getExamSession(examId, userId);
  if (!session) return c.json({ error: '考试未找到' }, 404);
  const publicQuestions = session.questions.map(q => ({
    index: q.index, type: q.type, stem: q.stem, passage: q.passage, points: q.points,
    knowledgePoint: q.knowledgePoint, difficulty: q.difficulty,
    options: q.type === 'multiple_choice' ? q.options : undefined,
    multiSelect: q.type === 'multiple_choice' ? q.multiSelect : undefined,
    blankCount: q.type === 'fill_blank' ? q.blanks?.length : undefined,
  }));
  return c.json({ exam: { id: session.id, title: session.title, subject: session.subject, grade: session.grade, totalScore: session.totalScore, durationMinutes: session.durationMinutes, status: session.status, createdAt: session.createdAt, submittedAt: session.submittedAt, questions: publicQuestions, results: session.results } });
});



// ── Frost ID 认证代理（服务端换 token，浏览器只与本服务同源通信）──

/** POST /api/auth/token - 用授权码换 access_token（携带 client_secret + code_verifier）*/
app.post('/api/auth/token', async (c) => {
  const { code, codeVerifier, redirectUri } = await c.req.json<{
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }>();
  const upstream = await fetch(`${FROST_ID_INTERNAL_URL}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: FROST_ID_CLIENT_ID,
      client_secret: FROST_ID_CLIENT_SECRET,
      code_verifier: codeVerifier,
    }),
  });
  const text = await upstream.text();
  return new Response(text, { status: upstream.status, headers: { 'Content-Type': 'application/json' } });
});

/** GET /api/auth/userinfo - 透传 Bearer 取用户信息 */
app.get('/api/auth/userinfo', async (c) => {
  const auth = c.req.header('authorization');
  if (!auth) return c.json({ error: 'invalid_token' }, 401);
  const upstream = await fetch(`${FROST_ID_INTERNAL_URL}/oauth/userinfo`, { headers: { Authorization: auth } });
  const text = await upstream.text();
  return new Response(text, { status: upstream.status, headers: { 'Content-Type': 'application/json' } });
});

/** POST /api/auth/revoke - 服务端撤销 token */
app.post('/api/auth/revoke', async (c) => {
  const { token } = await c.req.json<{ token: string }>();
  await fetch(`${FROST_ID_INTERNAL_URL}/oauth/revoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      token,
      client_id: FROST_ID_CLIENT_ID,
      client_secret: FROST_ID_CLIENT_SECRET,
    }),
  });
  return c.json({ success: true });
});

// ── 对话管理 API ────────────────────────────

/** GET /api/conversations - 获取当前登录用户的所有对话 */
app.get('/api/conversations', async (c) => {
  const userId = await resolveUserId(c);
  if (!userId) return c.json({ error: 'unauthorized' }, 401);
  const conversations = getConversations(userId);
  return c.json({ conversations });
});

/** POST /api/conversations - 创建新对话 */
app.post('/api/conversations', async (c) => {
  const userId = await resolveUserId(c);
  if (!userId) return c.json({ error: 'unauthorized' }, 401);
  const body = await c.req.json<{ title?: string; subject: string }>();
  const conversation = createConversation(userId, body.title ?? '新对话', body.subject ?? 'math');
  return c.json({ conversation }, 201);
});

/** GET /api/conversations/:id - 获取单个对话（仅限本人） */
app.get('/api/conversations/:id', async (c) => {
  const userId = await resolveUserId(c);
  if (!userId) return c.json({ error: 'unauthorized' }, 401);
  const id = c.req.param('id');
  const conversation = getConversation(id);
  if (!conversation || conversation.userId !== userId) return c.json({ error: 'Conversation not found' }, 404);
  const messages = getMessages(id);
  return c.json({ conversation, messages });
});

/** PATCH /api/conversations/:id - 更新对话标题（仅限本人） */
app.patch('/api/conversations/:id', async (c) => {
  const userId = await resolveUserId(c);
  if (!userId) return c.json({ error: 'unauthorized' }, 401);
  const id = c.req.param('id');
  const conversation = getConversation(id);
  if (!conversation || conversation.userId !== userId) return c.json({ error: 'Conversation not found' }, 404);
  const body = await c.req.json<{ title?: string }>();
  if (body.title) updateConversationTitle(id, body.title);
  return c.json({ success: true });
});

/** DELETE /api/conversations/:id - 删除对话（仅限本人） */
app.delete('/api/conversations/:id', async (c) => {
  const userId = await resolveUserId(c);
  if (!userId) return c.json({ error: 'unauthorized' }, 401);
  const id = c.req.param('id');
  const conversation = getConversation(id);
  if (!conversation || conversation.userId !== userId) return c.json({ error: 'Conversation not found' }, 404);
  deleteConversation(id);
  return c.json({ success: true });
});

// ── 聊天 API ────────────────────────────────

app.post('/api/chat', async (c) => {
  const body = (await c.req.json()) as ChatRequest & { conversationId?: string; subject: string };
  // 仅在 conversationId 属于当前登录用户时才落库，避免串写他人对话
  const userId = await resolveUserId(c);
  const owned =
    !!body.conversationId && !!userId && getConversation(body.conversationId)?.userId === userId;
  return streamSSE(c, async (stream) => {
    const send = (e: SseEvent) => stream.writeSSE({ data: JSON.stringify(e) });
    try {
      // 如果有归属本人的 conversationId，保存用户消息
      if (owned) {
        addMessage(body.conversationId!, 'user', body.message);
      }

      // 若存在未作答的题目卡片，先补「跳过」ToolMessage，避免悬空 tool_calls 触发 API 报错
      const skipMsgs = await pendingSkipToolMessages(body.threadId);

      const last = await runGraph(
        {
          messages: [...skipMsgs, new HumanMessage(body.message)],
          gradeBand: body.gradeBand ?? 'middle',
          grade: body.grade,
          subject: body.subject ?? 'math',
          userName: body.userName,
          ...(body.mode ? { mode: body.mode } : {}),
        },
        body.threadId,
        send,
      );

      // 保存助手回复
      if (owned && last) {
        const content = typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
        addMessage(body.conversationId!, 'assistant', content);
        // 如果该回复触发了出题，同时保存题目载荷（用于会话重载时还原题目卡片）
        const qData = extractQuestionPayload(last);
        if (qData) {
          addMessage(body.conversationId!, 'system', JSON.stringify({ __boen_type: 'question', toolCallId: qData.toolCallId, payload: qData.question, answered: false }));
        }
      }

      // 新对话自动生成标题（不阻塞主流程）
      if (owned && last && getConversation(body.conversationId!)?.title === '新对话') {
        autoGenerateTitle(body.conversationId!, body.message, async (title) => {
          await send({ type: 'title_updated', conversationId: body.conversationId!, title });
        });
      }

      await emitQuestionIfAny(last, send);
      await emitReviewCompleteIfAny(last, send);
      await send({ type: 'done' });
    } catch (err) {
      await send({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  });
});

app.post('/api/answer', async (c) => {
  const body = (await c.req.json()) as AnswerRequest;
  const userId = await resolveUserId(c);
  return streamSSE(c, async (stream) => {
    const send = (e: SseEvent) => stream.writeSSE({ data: JSON.stringify(e) });
    try {
      const state = await graph.getState({ configurable: { thread_id: body.threadId } });
      const msgs = (state.values?.messages ?? []) as BaseMessage[];
      const aiMsg = [...msgs]
        .reverse()
        .find((m) => ((m as AIMessage).tool_calls ?? []).some((t) => t.id === body.toolCallId)) as
        | AIMessage
        | undefined;
      const calls = (aiMsg?.tool_calls ?? []) as ToolCall[];
      const target = calls.find((t) => t.id === body.toolCallId);
      if (!target) throw new Error('找不到对应的题目，请重新开始一轮。');

      // 该题已被作答或跳过（历史里已存在对应 ToolMessage）：避免重复回灌触发 API 报错
      const alreadyAnswered = msgs.some(
        (m) => (m as ToolMessage).tool_call_id === body.toolCallId,
      );
      if (alreadyAnswered) throw new Error('这道题已经结束啦，换道新题试试～');

      // 判分，并把结果回灌给模型
      const { result, toolContent } = gradeAnswer(target.name, target.args, body.answer);
      await send({ type: 'grading', toolCallId: body.toolCallId, result });

      // 更新知识画像（如果用户已认证）
      if (userId && result.knowledgePoints?.length) {
        for (const kpName of result.knowledgePoints) {
          const node = db.prepare(`SELECT id FROM kg_nodes WHERE type='knowledge_point' AND title=?`).get(kpName) as { id: number } | undefined;
          if (node) {
            updateProficiency(userId, node.id, result.score, result.maxScore);
          }
        }
      }

      // 持久化判分结果（用于会话重载时恢复题目卡片的已答状态）
      if (body.conversationId) {
        addMessage(body.conversationId, 'system', JSON.stringify({ __boen_type: 'grading_result', toolCallId: body.toolCallId, result }));
      }

      // 答复该 AIMessage 的全部 tool_calls，保证消息序列合法（正常只有一个）
      const toolMsgs: ToolMessage[] = calls.map((t) =>
        t.id === body.toolCallId
          ? new ToolMessage({ content: toolContent, tool_call_id: t.id })
          : new ToolMessage({ content: '（已跳过）', tool_call_id: t.id! }),
      );

      const last = await runGraph({ messages: toolMsgs }, body.threadId, send);
      await emitQuestionIfAny(last, send);
      await emitReviewCompleteIfAny(last, send);
      await send({ type: 'done' });
    } catch (err) {
      await send({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  });
});

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port });
console.log(`博文 Boen server → http://localhost:${port}`);
