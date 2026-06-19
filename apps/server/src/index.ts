import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
import type { AnalyzeMistakeEvent, ChatRequest, AnswerRequest, SseEvent } from '@boen/shared';
import db from './db.js';
import { lookupKnowledgePoint, retrieveCurriculum } from './curriculum.js';
import { getNodesByType, getNeighbors, getKgContextForUnit, formatKgContext, ensureKnowledgeGraphTables } from './knowledge-graph.js';
import { getWeightInfo, getWeightDistribution, formatWeightGuide } from './kg-weights.js';
import { updateProficiency, getAllProficiencies, getWeakPoints, getStrongPoints, getLiteracyProficiency, getRecommendedKPs, getPrerequisiteWeaknessChain, getProfileOutline, seedProficiencyFromHistory } from './knowledge-profile.js';
import {
  createConversation,
  getConversations,
  getConversation,
  updateConversationTitle,
  deleteConversation,
  addMessage,
  getMessages,
  getRecentMessages,
  updateQuestionMessage,
} from './conversation.js';
import {
  analyzeMistake,
  archiveMistake,
  createMistake,
  formatMistakePracticePrompt,
  getMistakeAssetFile,
  getMistakeDetail,
  listMistakes,
  readMistakeAsset,
  retrieveMistakeStyleSamples,
  updateMistake,
} from './mistakes.js';

// 从仓库根加载 .env
const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(__dirname, '../../../.env') });

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY ?? '';

function createModel(provider: string) {
  if (provider === 'deepseek' || provider === 'default') {
    return getChatModel({ provider: 'deepseek', model: 'deepseek-v4-flash', apiKey: DEEPSEEK_API_KEY });
  }
  return getChatModel({
    provider: (process.env.BOEN_PROVIDER ?? 'openai') as 'openai' | 'anthropic',
    model: process.env.BOEN_MODEL ?? 'astron-code-latest',
    apiKey: process.env.BOEN_API_KEY ?? '',
    baseUrl: process.env.BOEN_BASE_URL,
  });
}
let model = createModel('default');
let graph = buildBoenGraph(model, { retrieveCurriculum, lookupKnowledgePoint });

/** 切换模型并重建 LangGraph 图 */
function switchModel(provider: string) {
  model = createModel(provider);
  graph = buildBoenGraph(model, { retrieveCurriculum, lookupKnowledgePoint });
  return provider;
}

// ── Frost ID：服务端换 token（内网直连，client_secret 只留服务端）──
const FROST_ID_INTERNAL_URL = process.env.FROST_ID_INTERNAL_URL ?? 'http://127.0.0.1:4000';
const FROST_ID_CLIENT_ID = process.env.FROST_ID_CLIENT_ID ?? 'boen-client';
const FROST_ID_CLIENT_SECRET = process.env.FROST_ID_CLIENT_SECRET ?? '';

// 用 Bearer token 经 Frost ID 内网 userinfo 解析出用户 id（sub），带短缓存避免每请求开销
const userIdCache = new Map<string, { sub: string; exp: number; subscription?: { tier: string; isPremium: boolean; expiresAt: number | null } }>();
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
  } catch (err) {
    console.error('[auth] userinfo failed:', err);
    return null;
  }
}

// ── 订阅系统辅助函数 ──────────────────────────────
const FREE_DAILY_LIMIT = 10;

interface SubscriptionInfo {
  tier: 'free' | 'premium';
  isPremium: boolean;
  expiresAt: number | null;
}

/** 解析用户 ID 并查询订阅状态（复用 userIdCache，5 分钟 TTL） */
async function resolveSubscription(c: Context): Promise<{ userId: string; sub: SubscriptionInfo } | null> {
  const authz = c.req.header('authorization');
  if (!authz?.startsWith('Bearer ')) return null;
  const token = authz.slice(7);
  const cached = userIdCache.get(token);
  // 若缓存中有 userId 且有订阅信息且未过期，直接返回
  if (cached && cached.exp > Date.now() && cached.subscription) {
    return { userId: cached.sub, sub: cached.subscription as SubscriptionInfo };
  }
  // 先拿到 userId（可能已缓存但未含 subscription）
  const userId = await resolveUserId(c);
  if (!userId) return null;
  // 查订阅表
  const row = db.prepare('SELECT tier, expires_at FROM subscriptions WHERE user_id = ?').get(userId) as
    | { tier: string; expires_at: number | null }
    | undefined;
  const now = Math.floor(Date.now() / 1000);
  const sub: SubscriptionInfo = {
    tier: (row?.tier === 'premium' ? 'premium' : 'free') as 'free' | 'premium',
    isPremium: row?.tier === 'premium' && row?.expires_at != null && row.expires_at > now,
    expiresAt: row?.expires_at ?? null,
  };
  // 回写缓存
  const entry = userIdCache.get(token);
  if (entry) {
    entry.subscription = sub;
  }
  return { userId, sub };
}

/** 守卫：要求 premium 订阅，否则返回 403 */
function requirePremium(c: Context, result: { userId: string; sub: SubscriptionInfo } | null) {
  if (!result) return c.json({ error: 'unauthorized' }, 401);
  if (!result.sub.isPremium) {
    return c.json({ error: 'premium_required', message: '此功能需要订阅会员才能使用' }, 403);
  }
  return null;
}

/** 查询当日消息用量 */
function getDailyUsage(userId: string): number {
  const today = new Date().toISOString().slice(0, 10);
  const row = db.prepare('SELECT message_count FROM daily_chat_usage WHERE user_id = ? AND date = ?').get(userId, today) as
    | { message_count: number }
    | undefined;
  return row?.message_count ?? 0;
}

/** 检查并递增每日用量，返回是否允许 + 剩余条数 */
function checkAndIncrementUsage(userId: string): { allowed: boolean; remaining: number } {
  const today = new Date().toISOString().slice(0, 10);
  const current = getDailyUsage(userId);
  if (current >= FREE_DAILY_LIMIT) return { allowed: false, remaining: 0 };
  db.prepare(`
    INSERT INTO daily_chat_usage (user_id, date, message_count)
    VALUES (?, ?, 1)
    ON CONFLICT(user_id, date) DO UPDATE SET message_count = message_count + 1
  `).run(userId, today);
  return { allowed: true, remaining: FREE_DAILY_LIMIT - current - 1 };
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
  let toolNameBuf = '';     // 累积可能被切分到多个 chunk 的工具名片段
  // 出题工具名均以 ask_ 开头；前缀 + 全名双重匹配，兼容模型分片/整块返回 tool_call
  const looksLikeQuiz = (n?: string | null): boolean => !!n && (QUIZ_TOOL_NAMES.has(n) || n.startsWith('ask_'));
  const signalQuiz = async () => {
    if (quizSignaled) return;
    quizSignaled = true;
    await send({ type: 'quiz_generating' });
  };
  for await (const ev of events) {
    if (ev.event === 'on_chat_model_stream') {
      const chunk = ev.data?.chunk as
        | { content?: unknown; tool_call_chunks?: Array<{ name?: string }>; tool_calls?: Array<{ name?: string }> }
        | undefined;
      const text = typeof chunk?.content === 'string' ? chunk.content : '';
      if (text) await send({ type: 'token', value: text });
      // 模型一旦开始产出出题工具调用就立即通知前端（名字可能被分片，累积后匹配）
      if (!quizSignaled) {
        for (const tc of chunk?.tool_call_chunks ?? []) if (tc.name) toolNameBuf += tc.name;
        const names = [
          ...(chunk?.tool_call_chunks ?? []).map((t) => t.name),
          ...(chunk?.tool_calls ?? []).map((t) => t.name),
          toolNameBuf,
        ];
        if (names.some(looksLikeQuiz)) await signalQuiz();
      }
    } else if (ev.event === 'on_chat_model_end' && !quizSignaled) {
      // 兜底：模型不分片流式输出 tool_call 时，turn 结束从完整输出里识别
      const out = ev.data?.output as { tool_calls?: Array<{ name?: string }> } | undefined;
      if ((out?.tool_calls ?? []).some((t) => looksLikeQuiz(t.name))) await signalQuiz();
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
    console.warn('[title] auto-generation failed');
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

app.get('/api/health', (c) => c.json({ ok: true, provider: process.env.BOEN_PROVIDER ?? 'openai', model: process.env.BOEN_MODEL ?? 'astron-code-latest', actual: 'Kimi K2.6' }));

// ── 模型切换 API ────────────────────────────
/** POST /api/model/switch — 切换模型提供商 */
app.post('/api/model/switch', async (c) => {
  const body = await c.req.json() as { provider?: string };
  const p = body.provider;
  if (p !== 'deepseek' && p !== 'default') return c.json({ error: '不支持的 provider' }, 400);
  const switched = switchModel(p);
  return c.json({ success: true, provider: switched });
});

/** GET /api/model/status — 当前模型状态 */
app.get('/api/model/status', (c) => {
  const current = model as any;
  return c.json({
    provider: process.env.BOEN_PROVIDER ?? 'openai',
    model: current.modelName ?? 'unknown',
    deepseekAvailable: !!DEEPSEEK_API_KEY,
  });
});

function formString(form: FormData, key: string): string | undefined {
  const value = form.get(key);
  return typeof value === 'string' ? value : undefined;
}

function isFormFile(value: unknown): value is { name?: string; type?: string; arrayBuffer: () => Promise<ArrayBuffer> } {
  return !!value && typeof value === 'object' && 'arrayBuffer' in value && typeof (value as any).arrayBuffer === 'function';
}

// ── TiKZ 渲染 API（安全加固版） ──────────────

/** POST /api/render-tikz — 安全加固的 TikZ → SVG 渲染 */
app.post('/api/render-tikz', async (c) => {
  // 1. 鉴权
  const userId = await resolveUserId(c);
  if (!userId) return c.json({ error: 'unauthorized' }, 401);

  const { code } = await c.req.json<{ code?: string }>();
  if (!code?.trim()) return c.json({ error: 'TikZ code required' }, 400);

  // 2. 代码长度限制
  if (code.length > 10000) return c.json({ error: 'code too long' }, 400);

  // 3. 代码黑名单：禁用危险 LaTeX 命令
  const DANGEROUS_PATTERNS = [
    /\\input\s*\{/i,
    /\\write18/i,
    /\\openout/i,
    /\\readline/i,
    /\\catcode/i,
    /\\immediate\s*\\write/i,
    /\\def\s*\\shell/i,
    /\\lstinputlisting/i,
    /\\include\s*\{/i,
  ];
  for (const pat of DANGEROUS_PATTERNS) {
    if (pat.test(code)) return c.json({ error: 'dangerous code rejected' }, 400);
  }

  // 4. 跨平台临时目录
  const tmpDir = mkdtempSync(join(tmpdir(), 'tikz-'));
  const texPath = join(tmpDir, 'tikz.tex');
  const pdfPath = join(tmpDir, 'tikz.pdf');
  const svgPath = join(tmpDir, 'tikz.svg');

  const tex = `\\documentclass{standalone}
\\usepackage{fontspec}
\\usepackage{xeCJK}
\\setCJKmainfont{Noto Sans CJK SC}
\\usepackage{tikz}
\\usetikzlibrary{shapes,arrows,positioning,calc,angles,quotes,intersections,through,math,matrix,fit,patterns,decorations.pathmorphing,decorations.pathreplacing}
\\usepackage{pgfplots}
\\pgfplotsset{compat=1.18}
\\usepackage{xlop}
\\begin{document}
${code}
\\end{document}`;

  try {
    writeFileSync(texPath, tex, 'utf-8');
    // 5. -no-shell-escape 禁用 RCE
    execSync(`xelatex -no-shell-escape -interaction=nonstopmode -output-directory="${tmpDir}" "${texPath}"`, { timeout: 30000, stdio: 'pipe' });

    const pdfExists = existsSync(pdfPath);
    if (!pdfExists) return c.json({ error: 'pdflatex failed' }, 500);

    execSync(`dvisvgm --pdf --no-fonts -o "${svgPath}" "${pdfPath}"`, { timeout: 15000, stdio: 'pipe' });
    const svg = existsSync(svgPath) ? execSync(`cat "${svgPath}"`, { encoding: 'utf-8', timeout: 5000 }) : '';
    if (!svg) return c.json({ error: 'dvisvgm produced empty output' }, 500);

    // 6. 只返回 SVG，不返回编译日志
    return c.json({ svg });
  } catch (err) {
    const msg = err instanceof Error ? err.message.slice(0, 200) : String(err);
    console.error('[tikz] render failed:', msg);
    return c.json({ error: 'tikz render failed' }, 500);
  } finally {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 清理临时目录 */ }
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
  const authResult = await resolveSubscription(c);
  const gate = requirePremium(c, authResult);
  if (gate) return gate;
  const userId = authResult!.userId;
  const subject = c.req.query('subject') || 'math';
  const grade = c.req.query('grade');
  const profs = getAllProficiencies(userId, subject, grade);
  return c.json({ proficiencies: profs });
});

/** GET /api/profile/report — LLM 生成诊断报告 */
app.get('/api/profile/report', async (c) => {
  const authResult = await resolveSubscription(c);
  const gate = requirePremium(c, authResult);
  if (gate) return gate;
  const userId = authResult!.userId;
  const subject = c.req.query('subject') || 'math';
  const grade = c.req.query('grade') || '7';
  const profs = getAllProficiencies(userId, subject, grade);
  const weak = profs.filter(p => p.weightedScore < 60).slice(0, 8);
  const strong = profs.filter(p => p.weightedScore >= 80).slice(0, 5);
  const literacy = getLiteracyProficiency(userId, subject);
  const subjectLabel: Record<string, string> = { chinese: '语文', math: '数学', english: '英语', science: '科学' };

  const prompt = [
    `你是一位经验丰富的学科教师。请根据以下学习数据，生成一份简短的学习诊断报告。`,
    `学科：${subjectLabel[subject] ?? subject}`,
    `年级：${grade}，掌握知识点：${profs.length} 个`,
    weak.length ? `薄弱点（< 60%）：${weak.map(w => `${w.title}(${w.weightedScore}%)`).join('、')}` : '暂无薄弱点',
    strong.length ? `掌握良好（≥ 80%）：${strong.map(s => `${s.title}(${s.weightedScore}%)`).join('、')}` : '',
    literacy.length ? `核心素养：${literacy.map(l => `${l.literacy} ${l.percentage}%`).join('、')}` : '',
    '',
    '请用 Markdown 格式输出：',
    '1. **总体评价** — 一两句话概括，语气鼓励',
    '2. **需要优先突破** — 列出 2-3 个最该先抓的薄弱点及原因',
    '3. **学习建议** — 针对每个薄弱点给具体做法',
    '4. **下一步方向** — 下一阶段建议',
  ].join('\n');
  try {
    const response = await model.invoke([new SystemMessage(prompt)]);
    const content = typeof response.content === 'string' ? response.content : JSON.stringify(response.content);
    return c.json({ report: content.trim() });
  } catch { return c.json({ error: '生成报告失败' }, 500); }
});

/** GET /api/profile/weak-points — 薄弱知识点 */
app.get('/api/profile/weak-points', async (c) => {
  const authResult = await resolveSubscription(c);
  const gate = requirePremium(c, authResult);
  if (gate) return gate;
  const userId = authResult!.userId;
  const subject = c.req.query('subject') || 'math';
  const grade = c.req.query('grade');
  const threshold = c.req.query('threshold') ? Number(c.req.query('threshold')) : 60;
  const limit = c.req.query('limit') ? Number(c.req.query('limit')) : 10;
  const weak = getWeakPoints(userId, subject, grade, threshold, limit);
  return c.json({ weakPoints: weak });
});

/** GET /api/profile/strong-points — 优势知识点 */
app.get('/api/profile/strong-points', async (c) => {
  const authResult = await resolveSubscription(c);
  const gate = requirePremium(c, authResult);
  if (gate) return gate;
  const userId = authResult!.userId;
  const subject = c.req.query('subject') || 'math';
  const grade = c.req.query('grade');
  const threshold = c.req.query('threshold') ? Number(c.req.query('threshold')) : 75;
  const limit = c.req.query('limit') ? Number(c.req.query('limit')) : 10;
  const strong = getStrongPoints(userId, subject, grade, threshold, limit);
  return c.json({ strongPoints: strong });
});

/** GET /api/profile/literacies — 素养熟练度 */
app.get('/api/profile/literacies', async (c) => {
  const authResult = await resolveSubscription(c);
  const gate = requirePremium(c, authResult);
  if (gate) return gate;
  const userId = authResult!.userId;
  const subject = c.req.query('subject') || 'math';
  const lits = getLiteracyProficiency(userId, subject);
  return c.json({ literacies: lits });
});

/** GET /api/profile/recommendations — 练习推荐 */
app.get('/api/profile/recommendations', async (c) => {
  const authResult = await resolveSubscription(c);
  const gate = requirePremium(c, authResult);
  if (gate) return gate;
  const userId = authResult!.userId;
  const subject = c.req.query('subject') || 'math';
  const grade = c.req.query('grade') || '7';
  const limit = c.req.query('limit') ? Number(c.req.query('limit')) : 5;
  const recs = getRecommendedKPs(userId, subject, grade, limit);
  return c.json({ recommendations: recs });
});

/** GET /api/profile/weakness-chain/:nodeId — 前置弱点追溯 */
app.get('/api/profile/weakness-chain/:nodeId', async (c) => {
  const authResult = await resolveSubscription(c);
  const gate = requirePremium(c, authResult);
  if (gate) return gate;
  const userId = authResult!.userId;
  const nodeId = Number(c.req.param('nodeId'));
  if (isNaN(nodeId)) return c.json({ error: 'nodeId 无效' }, 400);
  const chain = getPrerequisiteWeaknessChain(userId, nodeId);
  return c.json({ chain });
});

/** POST /api/profile/seed — 从历史答题记录回填熟练度 */
app.post('/api/profile/seed', async (c) => {
  const authResult = await resolveSubscription(c);
  const gate = requirePremium(c, authResult);
  if (gate) return gate;
  const userId = authResult!.userId;
  const { updated } = seedProficiencyFromHistory(userId);
  return c.json({ updated });
});

// ── 错题本 API ─────────────────────────────────────────────
app.get('/api/mistakes', async (c) => {
  const authResult = await resolveSubscription(c);
  const gate = requirePremium(c, authResult);
  if (gate) return gate;
  const userId = authResult!.userId;
  return c.json(listMistakes(userId, {
    subject: c.req.query('subject') || undefined,
    grade: c.req.query('grade') || undefined,
    status: (c.req.query('status') as any) || undefined,
    limit: c.req.query('limit') ? Number(c.req.query('limit')) : undefined,
    includeCorrect: c.req.query('includeCorrect') === '1' || c.req.query('includeCorrect') === 'true',
  }));
});

app.post('/api/mistakes', async (c) => {
  const authResult = await resolveSubscription(c);
  const gate = requirePremium(c, authResult);
  if (gate) return gate;
  const userId = authResult!.userId;
  try {
    const contentType = c.req.header('content-type') ?? '';
    if (contentType.includes('multipart/form-data')) {
      const form = await c.req.formData();
      const file = form.get('image') ?? form.get('file');
      const asset = isFormFile(file)
        ? {
            bytes: Buffer.from(await file.arrayBuffer()),
            filename: file.name,
            mimeType: file.type || 'application/octet-stream',
          }
        : undefined;
      const mistake = createMistake(userId, {
        sourceType: (formString(form, 'sourceType') as any) || (asset ? 'image' : 'text'),
        subject: formString(form, 'subject') || 'math',
        grade: formString(form, 'grade') || '7',
        promptText: formString(form, 'promptText'),
        studentAnswer: formString(form, 'studentAnswer'),
        note: formString(form, 'note'),
        asset,
      });
      return c.json({ mistake }, 201);
    }
    const body = await c.req.json<{
      sourceType?: string;
      subject?: string;
      grade?: string;
      promptText?: string;
      studentAnswer?: string;
      note?: string;
    }>();
    const mistake = createMistake(userId, {
      sourceType: (body.sourceType as any) || 'text',
      subject: body.subject || 'math',
      grade: body.grade || '7',
      promptText: body.promptText,
      studentAnswer: body.studentAnswer,
      note: body.note,
    });
    return c.json({ mistake }, 201);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

app.post('/api/mistakes/:id/analyze', async (c) => {
  const authResult = await resolveSubscription(c);
  const gate = requirePremium(c, authResult);
  if (gate) return gate;
  const userId = authResult!.userId;
  const mistakeId = c.req.param('id');
  return streamSSE(c, async (stream) => {
    const send = (e: AnalyzeMistakeEvent) => stream.writeSSE({ data: JSON.stringify(e) });
    try {
      await analyzeMistake(mistakeId, userId, model,
        (p) => send({ type: 'mistake_progress', step: p.step, message: p.message, progress: p.progress }),
        (mistake) => send({ type: 'mistake_ready', mistake }),
      );
      await send({ type: 'done' });
    } catch (err) {
      await send({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  });
});

app.get('/api/mistakes/:id', async (c) => {
  const authResult = await resolveSubscription(c);
  const gate = requirePremium(c, authResult);
  if (gate) return gate;
  const userId = authResult!.userId;
  const detail = getMistakeDetail(c.req.param('id'), userId);
  if (!detail) return c.json({ error: '错题不存在' }, 404);
  return c.json(detail);
});

app.patch('/api/mistakes/:id', async (c) => {
  const authResult = await resolveSubscription(c);
  const gate = requirePremium(c, authResult);
  if (gate) return gate;
  const userId = authResult!.userId;
  try {
    const body = await c.req.json<{ promptText?: string; studentAnswer?: string; correctAnswer?: string; errorReason?: string }>();
    const mistake = updateMistake(c.req.param('id'), userId, body);
    return c.json({ mistake });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

app.delete('/api/mistakes/:id', async (c) => {
  const authResult = await resolveSubscription(c);
  const gate = requirePremium(c, authResult);
  if (gate) return gate;
  const userId = authResult!.userId;
  const ok = archiveMistake(c.req.param('id'), userId);
  if (!ok) return c.json({ error: '错题不存在' }, 404);
  return c.json({ success: true });
});

app.get('/api/mistakes/:id/assets/:assetId', async (c) => {
  const authResult = await resolveSubscription(c);
  const gate = requirePremium(c, authResult);
  if (gate) return gate;
  const userId = authResult!.userId;
  const asset = getMistakeAssetFile(c.req.param('id'), Number(c.req.param('assetId')), userId);
  if (!asset) return c.json({ error: '图片不存在' }, 404);
  const bytes = await readMistakeAsset(asset.filePath);
  return c.body(new Uint8Array(bytes), 200, { 'Content-Type': asset.mimeType, 'Cache-Control': 'private, max-age=3600' });
});

app.post('/api/mistakes/:id/practice', async (c) => {
  const authResult = await resolveSubscription(c);
  const gate = requirePremium(c, authResult);
  if (gate) return gate;
  const userId = authResult!.userId;
  const detail = getMistakeDetail(c.req.param('id'), userId);
  if (!detail) return c.json({ error: '错题不存在' }, 404);
  return c.json({ prompt: formatMistakePracticePrompt(detail.mistake) });
});

import { generateExam, createExamSession, getExamSession, submitExamSession, listExamSessions, deleteExamSession, createShortAnswerGrader, findKnowledgePointNode } from './exam.js';

/** POST /api/exam/generate — 生成新试卷（SSE 流式：实时推送规划→出题→审核进度） */
app.post('/api/exam/generate', async (c) => {
  const authResult = await resolveSubscription(c);
  const gate = requirePremium(c, authResult);
  if (gate) return gate;
  const userId = authResult!.userId;
  const body = await c.req.json() as { subject: string; grade: string; difficulty?: string; durationMinutes?: number; notes?: string; totalScore?: number };
  if (!body.subject || !body.grade) return c.json({ error: '缺少必填字段：subject, grade' }, 400);
  return streamSSE(c, async (stream) => {
    const send = (e: SseEvent) => stream.writeSSE({ data: JSON.stringify(e) });
    try {
      await send({ type: 'exam_generating' });
      const exam = await generateExam(
        model,
        { subject: body.subject, grade: body.grade, durationMinutes: body.durationMinutes, notes: body.notes, totalScore: body.totalScore },
        (p) => send({ type: 'exam_progress', step: p.step, message: p.message, progress: p.progress ?? 0 }),
        userId,
      );
      const session = createExamSession(userId, { subject: body.subject, grade: body.grade }, exam);
      await send({
        type: 'exam_ready',
        examId: session.id,
        title: exam.title,
        totalQuestions: exam.questions.length,
        totalScore: exam.totalScore,
        durationMinutes: exam.durationMinutes,
      });
      await send({ type: 'done' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('出卷失败:', msg.slice(0, 200));
      try { await send({ type: 'error', message: msg }); } catch {}
    }
  });
});

/** POST /api/exam/submit — 提交考试答案 */
app.post('/api/exam/submit', async (c) => {
  const authResult = await resolveSubscription(c);
  const gate = requirePremium(c, authResult);
  if (gate) return gate;
  const userId = authResult!.userId;
  const body = await c.req.json() as { examId: string; answers?: Array<{ questionIndex: number; answer: any }> };
  if (!body.examId) return c.json({ error: '缺少必填字段：examId' }, 400);
  // 允许 answers 为空数组（用户可能留空全部题目），未作答的题由评分逻辑按 0 分处理
  const answers = Array.isArray(body.answers) ? body.answers : [];
  try {
    const results = await submitExamSession(body.examId, userId, answers as any, model);
    return c.json({ success: true, results });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

/** POST /api/exam/submit/stream - stream real grading progress */
app.post('/api/exam/submit/stream', async (c) => {
  const authResult = await resolveSubscription(c);
  const gate = requirePremium(c, authResult);
  if (gate) return gate;
  const userId = authResult!.userId;
  const body = await c.req.json() as { examId: string; answers?: Array<{ questionIndex: number; answer: any }> };
  if (!body.examId) return c.json({ error: '缺少必填字段：examId' }, 400);
  const answers = Array.isArray(body.answers) ? body.answers : [];

  return streamSSE(c, async (stream) => {
    const send = (e: SseEvent) => stream.writeSSE({ data: JSON.stringify(e) });
    try {
      const results = await submitExamSession(
        body.examId,
        userId,
        answers as any,
        model,
        (p) => send({ type: 'exam_grading_progress', step: p.step, message: p.message, progress: p.progress }),
      );
      await send({ type: 'exam_graded', examId: body.examId, results });
      await send({ type: 'done' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      try { await send({ type: 'error', message: msg }); } catch {}
    }
  });
});

/** GET /api/exams — 当前用户的考试历史列表（概要） */
app.get('/api/exams', async (c) => {
  const authResult = await resolveSubscription(c);
  const gate = requirePremium(c, authResult);
  if (gate) return gate;
  const userId = authResult!.userId;
  return c.json({ exams: listExamSessions(userId) });
});

/** DELETE /api/exam/:examId — 删除一场考试（任意状态，仅限本人） */
app.delete('/api/exam/:examId', async (c) => {
  const authResult = await resolveSubscription(c);
  const gate = requirePremium(c, authResult);
  if (gate) return gate;
  const userId = authResult!.userId;
  const ok = deleteExamSession(c.req.param('examId'), userId);
  if (!ok) return c.json({ error: '考试未找到' }, 404);
  return c.json({ success: true });
});

/** GET /api/exam/:examId — 获取考试详情和结果
 *  - 进行中（pending）：返回脱敏题目（不含正确答案），用于答题
 *  - 已完成（completed）：返回完整题目（含答案）+ 用户作答，用于历史回顾
 */
app.get('/api/exam/:examId', async (c) => {
  const authResult = await resolveSubscription(c);
  const gate = requirePremium(c, authResult);
  if (gate) return gate;
  const userId = authResult!.userId;
  const examId = c.req.param('examId');
  const session = getExamSession(examId, userId);
  if (!session) return c.json({ error: '考试未找到' }, 404);
  const completed = session.status === 'completed';
  const questions = completed
    ? session.questions // 已交卷：揭示完整题目（正确答案/解析）供回顾
    : session.questions.map(q => ({
        index: q.index, type: q.type, stem: q.stem, passage: q.passage, points: q.points,
        knowledgePoint: q.knowledgePoint, difficulty: q.difficulty,
        options: q.type === 'multiple_choice' ? q.options : undefined,
        multiSelect: q.type === 'multiple_choice' ? q.multiSelect : undefined,
        blankCount: q.type === 'fill_blank' ? (q.blankCount ?? q.blanks?.length ?? 1) : undefined,
        tikzSvgs: q.tikzSvgs,
      }));
  return c.json({ exam: { id: session.id, title: session.title, subject: session.subject, grade: session.grade, totalScore: session.totalScore, durationMinutes: session.durationMinutes, status: session.status, createdAt: session.createdAt, submittedAt: session.submittedAt, questions, answers: completed ? session.answers : undefined, results: session.results } });
});



// ── 订阅状态 API ────────────────────────────
app.get('/api/subscription/status', async (c) => {
  const result = await resolveSubscription(c);
  if (!result) return c.json({ error: 'unauthorized' }, 401);
  const dailyUsed = result.sub.isPremium ? null : getDailyUsage(result.userId);
  return c.json({
    tier: result.sub.tier,
    isPremium: result.sub.isPremium,
    expiresAt: result.sub.expiresAt,
    dailyLimit: result.sub.isPremium ? null : FREE_DAILY_LIMIT,
    dailyUsed,
    dailyRemaining: result.sub.isPremium ? null : Math.max(0, FREE_DAILY_LIMIT - (dailyUsed ?? 0)),
  });
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
  // 硬认证：必须登录才能对话
  const result = await resolveSubscription(c);
  if (!result) return c.json({ error: 'unauthorized' }, 401);
  const userId = result.userId;

  // 免费用户每日限额检查
  let usageInfo: { dailyLimit: number; dailyUsed: number; dailyRemaining: number } | null = null;
  if (!result.sub.isPremium) {
    const usage = checkAndIncrementUsage(userId);
    if (!usage.allowed) {
      return c.json({ error: 'daily_limit_reached', message: '今日免费对话次数已用完，请明天再试或订阅会员', dailyLimit: FREE_DAILY_LIMIT, dailyUsed: FREE_DAILY_LIMIT, dailyRemaining: 0 }, 429);
    }
    usageInfo = { dailyLimit: FREE_DAILY_LIMIT, dailyUsed: FREE_DAILY_LIMIT - usage.remaining, dailyRemaining: usage.remaining };
  }

  const owned =
    !!body.conversationId && getConversation(body.conversationId)?.userId === userId;
  return streamSSE(c, async (stream) => {
    const send = (e: SseEvent) => stream.writeSSE({ data: JSON.stringify(e) });
    try {
      // 如果有归属本人的 conversationId，保存用户消息
      if (owned) {
        addMessage(body.conversationId!, 'user', body.message);
      }

      // 新对话标题：与主回复并发生成（隐藏延迟），在流关闭前回填 title_updated 事件
      const titlePromise =
        owned && getConversation(body.conversationId!)?.title === '新对话'
          ? autoGenerateTitle(body.conversationId!, body.message, async (title) => {
              await send({ type: 'title_updated', conversationId: body.conversationId!, title });
            })
          : null;

      // 若存在未作答的题目卡片，先补「跳过」ToolMessage，避免悬空 tool_calls 触发 API 报错
      const skipMsgs = await pendingSkipToolMessages(body.threadId);

      // 突破模式：加载知识画像中的薄弱点数据
      let weaknessData: string | undefined;
      if (body.mode === 'weakness' && userId) {
        try {
          const weakPoints = getWeakPoints(userId, body.subject ?? 'math', body.grade, 60, 8);
          if (weakPoints.length > 0) {
            weaknessData = '【你的薄弱知识点（来自知识画像）】\n' + weakPoints.map(w =>
              `- ${w.title}（当前掌握度 ${w.weightedScore}%，等级：${w.level === 'needs_practice' ? '需练习' : w.level === 'developing' ? '发展中' : w.level === 'proficient' ? '熟练' : '掌握'}，最近更新：${new Date(w.lastUpdated * 1000).toLocaleDateString('zh-CN')}）`
            ).join('\n');
          } else {
            weaknessData = '【知识画像】当前暂无明显的薄弱知识点记录。可以通过考试或练习来建立你的知识画像。';
          }
        } catch (err) {
          console.warn('[profile] weakness data retrieval failed:', err);
          weaknessData = undefined;
        }
      }

      // 通知前端开始加载知识库
      let styleExamples: string | undefined;
      if (userId && (body.mode === 'weakness' || body.practiceType || /错题|举一反三|出题|练习|测验|测试|考我|quiz/i.test(body.message))) {
        try {
          styleExamples = await retrieveMistakeStyleSamples(userId, body.subject ?? 'math', body.grade ?? '7', body.message, [], 3);
        } catch (err) {
          console.warn('[mistakes] style samples retrieval failed:', err);
          styleExamples = undefined;
        }
      }

      const last = await runGraph(
        {
          messages: [...skipMsgs, new HumanMessage(body.message)],
          gradeBand: body.gradeBand ?? 'middle',
          grade: body.grade,
          subject: body.subject ?? 'math',
          userName: body.userName,
          weaknessData,
          styleExamples,
          practiceType: body.practiceType,
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

      await emitQuestionIfAny(last, send);
      await emitReviewCompleteIfAny(last, send);
      // 等标题生成完成，确保 title_updated 在流关闭（done）之前送达前端
      if (titlePromise) await titlePromise;
      // 发送每日用量信息（供前端更新剩余次数）
      if (usageInfo) await send({ type: 'usage', ...usageInfo });
      await send({ type: 'done' });
    } catch (err) {
      await send({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  });
});

app.post('/api/answer', async (c) => {
  const body = (await c.req.json()) as AnswerRequest;
  const userId = await resolveUserId(c);
  if (!userId) return c.json({ error: 'unauthorized' }, 401);

  // 免费用户每次 AI 调用都计为一次
  const subInfo = userId ? await resolveSubscription(c).catch(() => null) : null;
  if (subInfo && !subInfo.sub.isPremium) {
    const usage = checkAndIncrementUsage(userId);
    if (!usage.allowed) {
      return c.json({ error: 'daily_limit_reached', message: '今日免费对话次数已用完，请明天再试或订阅会员', dailyLimit: FREE_DAILY_LIMIT, dailyUsed: FREE_DAILY_LIMIT, dailyRemaining: 0 }, 429);
    }
  }

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

      // 简答题走 LLM 语义评分（只有简答题需要，避免不必要开销）
      const shortAnswerGrader = target.name === 'ask_short_answer' ? createShortAnswerGrader(model) : undefined;

      // 判分
      const { result, toolContent } = await gradeAnswer(target.name, target.args, body.answer, shortAnswerGrader);

      // 更新知识画像：优先用 knowledgePointId 直连节点，否则回退到文本模糊匹配
      const profChanges: Array<{ kp: string; before: number; after: number }> = [];
      if (userId) {
        const subject = (state.values as any)?.subject ?? 'math';
        // 收集要更新的节点：ID 优先
        const nodesToUpdate: Array<{ id: number; title: string }> = [];
        if (result.knowledgePointId) {
          const node = db.prepare('SELECT id, title FROM kg_nodes WHERE id=?').get(result.knowledgePointId) as { id: number; title: string } | undefined;
          if (node) nodesToUpdate.push(node);
        }
        // 若无 ID 或 ID 无效，则从文本模糊匹配
        if (nodesToUpdate.length === 0 && result.knowledgePoints?.length) {
          for (const kpName of result.knowledgePoints) {
            for (const kp of kpName.split(/[；;]/).map(s => s.trim()).filter(Boolean)) {
              const node = findKnowledgePointNode(kp, subject);
              if (node) nodesToUpdate.push({ id: node.id, title: kp });
            }
          }
        }
        for (const node of nodesToUpdate) {
          const oldRow = db.prepare('SELECT weighted_score FROM user_kp_proficiency WHERE user_id=? AND kg_node_id=?').get(userId, node.id) as { weighted_score: number } | undefined;
          const before = oldRow?.weighted_score ?? -1;
          const currentMode = ((state.values as any)?.mode as string) ?? 'qa';
          updateProficiency(userId, node.id, result.score, result.maxScore, currentMode);
          const newRow = db.prepare('SELECT weighted_score FROM user_kp_proficiency WHERE user_id=? AND kg_node_id=?').get(userId, node.id) as { weighted_score: number } | undefined;
          const after = newRow?.weighted_score ?? -1;
          profChanges.push({ kp: node.title, before: Math.max(0, before), after: Math.max(0, after) });
        }
      }
      if (profChanges.length) { (result as any).proficiencyChanges = profChanges; }

      // 发送判分结果（含熟练度变化）
      await send({ type: 'grading', toolCallId: body.toolCallId, result });

      // 持久化判分结果：更新题目消息为已作答状态（含答案 + 判分），避免重载时状态分裂
      if (body.conversationId && body.answer) {
        updateQuestionMessage(body.conversationId, body.toolCallId, JSON.stringify({
          __boen_type: 'question',
          toolCallId: body.toolCallId,
          payload: null, // 原始 payload 在旧消息中，但前端优先使用 messages 里的原始 question 消息
          answered: true,
          grading: result,
          userAnswer: body.answer,
        }));
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
