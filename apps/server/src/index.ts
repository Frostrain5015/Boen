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

app.post('/api/chat', async (c) => {
  const body = (await c.req.json()) as ChatRequest;
  return streamSSE(c, async (stream) => {
    const send = (e: SseEvent) => stream.writeSSE({ data: JSON.stringify(e) });
    try {
      const last = await runGraph(
        {
          messages: [new HumanMessage(body.message)],
          gradeBand: body.gradeBand,
          ...(body.mode ? { mode: body.mode } : {}),
        },
        body.threadId,
        send,
      );
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
