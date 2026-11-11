import { HumanMessage } from '@langchain/core/messages';
import { REPLY_MODEL_TAG, buildBoenGraph, getChatModel } from '@boen/agent-core';
import { expect, it } from 'vitest';
import { rewriteQuery, setRewriteModel } from '../query-rewriter.js';

it('keeps the rewritten retrieval query out of the reply stream', async () => {
  const question = '有理数和无理数共同构成的概念集合叫什么？';
  const rewrite = '有理数和无理数共同构成的集合称为什么？';
  const answer = '叫实数集。';
  const model = getChatModel({
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    apiKey: 'fixture',
    fetch: async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
      const text = request.messages[0]?.content.includes('查询优化器') ? rewrite : answer;
      const chunk = { id: 'fixture', model: 'deepseek-v4-flash', created: 1 };
      return new Response([
        `data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: { content: text } }] })}\n\n`,
        `data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`,
        'data: [DONE]\n\n',
      ].join(''), { headers: { 'Content-Type': 'text/event-stream' } });
    },
  });
  setRewriteModel(model);
  const graph = buildBoenGraph(model, {
    async retrieveCurriculum({ query }) {
      expect(query).toBe(question);
      const rewritten = await rewriteQuery(query, 'math', '8');
      expect(rewritten.query).toBe(rewrite);
      return '教材将有理数和无理数统称为实数。';
    },
  });
  const chunks: string[] = [];
  const replyChunks: string[] = [];
  for await (const event of graph.streamEvents({
    messages: [new HumanMessage(question)], subject: 'math', grade: '8', gradeBand: 'middle',
  }, { version: 'v2', configurable: { thread_id: 'reply-stream' } })) {
    if (event.event !== 'on_chat_model_stream' || typeof event.data.chunk?.content !== 'string') continue;
    chunks.push(event.data.chunk.content);
    if (event.tags?.includes(REPLY_MODEL_TAG)) replyChunks.push(event.data.chunk.content);
  }
  expect(chunks.join('')).toContain(rewrite);
  expect(replyChunks.join('')).toBe(answer);
});
