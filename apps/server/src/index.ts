import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import { serve } from '@hono/node-server';
import { HumanMessage, ToolMessage, type BaseMessage, type AIMessage } from '@langchain/core/messages';
import {
  getChatModel,
  buildBoenGraph,
  QUIZ_TOOL_NAMES,
  toQuestionPayload,
  gradeAnswer,
} from '@boen/agent-core';
import type { ChatRequest, AnswerRequest, SseEvent } from '@boen/shared';
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
const graph = buildBoenGraph(model);

// ── Frost ID：服务端换 token（内网直连，client_secret 只留服务端）──
const FROST_ID_INTERNAL_URL = process.env.FROST_ID_INTERNAL_URL ?? 'http://127.0.0.1:4000';
const FROST_ID_CLIENT_ID = process.env.FROST_ID_CLIENT_ID ?? 'boen-client';
const FROST_ID_CLIENT_SECRET = process.env.FROST_ID_CLIENT_SECRET ?? '';

type ToolCall = { id?: string; name: string; args: Record<string, unknown> };
const runConfig = (threadId: string) => ({ version: 'v2' as const, configurable: { thread_id: threadId } });

/** 流式跑一次图：推送 token，结束后返回最后一条消息 */
async function runGraph(
  input: Record<string, unknown>,
  threadId: string,
  send: (e: SseEvent) => Promise<void>,
): Promise<BaseMessage | undefined> {
  const events = graph.streamEvents(input, runConfig(threadId));
  for await (const ev of events) {
    if (ev.event === 'on_chat_model_stream') {
      const text = typeof ev.data?.chunk?.content === 'string' ? ev.data.chunk.content : '';
      if (text) await send({ type: 'token', value: text });
    }
  }
  const state = await graph.getState({ configurable: { thread_id: threadId } });
  const msgs = (state.values?.messages ?? []) as BaseMessage[];
  return msgs[msgs.length - 1];
}

/** 若最后一条消息触发了出题工具，推送 question 事件（每次只呈现第一道） */
async function emitQuestionIfAny(last: BaseMessage | undefined, send: (e: SseEvent) => Promise<void>) {
  const calls = ((last as AIMessage | undefined)?.tool_calls ?? []) as ToolCall[];
  const quiz = calls.find((c) => QUIZ_TOOL_NAMES.has(c.name));
  if (quiz?.id) {
    await send({ type: 'question', toolCallId: quiz.id, question: toQuestionPayload(quiz.name, quiz.args) });
  }
}

const app = new Hono();
app.use('/api/*', cors());

app.get('/api/health', (c) => c.json({ ok: true, provider, model: process.env.BOEN_MODEL }));

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

/** GET /api/conversations - 获取用户的所有对话 */
app.get('/api/conversations', async (c) => {
  const userId = c.req.header('x-user-id') ?? 'anonymous';
  const conversations = getConversations(userId);
  return c.json({ conversations });
});

/** POST /api/conversations - 创建新对话 */
app.post('/api/conversations', async (c) => {
  const body = await c.req.json<{ title?: string; subject?: string }>();
  const userId = c.req.header('x-user-id') ?? 'anonymous';
  const conversation = createConversation(userId, body.title ?? '新对话', body.subject ?? 'math');
  return c.json({ conversation }, 201);
});

/** GET /api/conversations/:id - 获取单个对话 */
app.get('/api/conversations/:id', async (c) => {
  const id = c.req.param('id');
  const conversation = getConversation(id);
  if (!conversation) return c.json({ error: 'Conversation not found' }, 404);
  const messages = getMessages(id);
  return c.json({ conversation, messages });
});

/** PATCH /api/conversations/:id - 更新对话标题 */
app.patch('/api/conversations/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ title?: string }>();
  if (body.title) updateConversationTitle(id, body.title);
  return c.json({ success: true });
});

/** DELETE /api/conversations/:id - 删除对话 */
app.delete('/api/conversations/:id', async (c) => {
  const id = c.req.param('id');
  deleteConversation(id);
  return c.json({ success: true });
});

// ── 聊天 API ────────────────────────────────

app.post('/api/chat', async (c) => {
  const body = (await c.req.json()) as ChatRequest & { conversationId?: string; subject?: string };
  return streamSSE(c, async (stream) => {
    const send = (e: SseEvent) => stream.writeSSE({ data: JSON.stringify(e) });
    try {
      // 如果有 conversationId，保存用户消息
      if (body.conversationId) {
        addMessage(body.conversationId, 'user', body.message);
      }

      const last = await runGraph(
        {
          messages: [new HumanMessage(body.message)],
          gradeBand: body.gradeBand ?? 'middle',
          ...(body.mode ? { mode: body.mode } : {}),
        },
        body.threadId,
        send,
      );

      // 保存助手回复
      if (body.conversationId && last) {
        const content = typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
        addMessage(body.conversationId, 'assistant', content);
      }

      await emitQuestionIfAny(last, send);
      await send({ type: 'done' });
    } catch (err) {
      await send({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  });
});

app.post('/api/answer', async (c) => {
  const body = (await c.req.json()) as AnswerRequest;
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

      // 判分，并把结果回灌给模型
      const { result, toolContent } = gradeAnswer(target.name, target.args, body.answer);
      await send({ type: 'grading', toolCallId: body.toolCallId, result });

      // 答复该 AIMessage 的全部 tool_calls，保证消息序列合法（正常只有一个）
      const toolMsgs: ToolMessage[] = calls.map((t) =>
        t.id === body.toolCallId
          ? new ToolMessage({ content: toolContent, tool_call_id: t.id })
          : new ToolMessage({ content: '（已跳过）', tool_call_id: t.id! }),
      );

      const last = await runGraph({ messages: toolMsgs }, body.threadId, send);
      await emitQuestionIfAny(last, send);
      await send({ type: 'done' });
    } catch (err) {
      await send({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  });
});

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port });
console.log(`博文 Boen server → http://localhost:${port}`);
