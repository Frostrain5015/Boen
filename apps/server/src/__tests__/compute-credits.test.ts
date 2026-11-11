import Database from 'better-sqlite3';
import { getChatModel } from '@boen/agent-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { creditBalance, finishCreditOperation, grantCredit, initComputeCredits, openCreditOperation, syncCreditGrants } from '../compute-credits.js';
import { creditScope, meteredDeepSeekFetch, newCreditMeter, settleCreditMeter } from '../compute-meter.js';

const monday = Date.parse('2026-11-09T00:00:00+08:00') / 1000;
const week = 7 * 86400;
const memoryDb = () => {
  const db = new Database(':memory:');
  initComputeCredits(db);
  return db;
};
afterEach(() => vi.unstubAllGlobals());

describe('compute credit settlement', () => {
  it('grants once, uses the earliest expiry first, and issues the next Beijing week only', () => {
    const db = memoryDb();
    syncCreditGrants(db, 'alice', 1000, monday + 3 * week, monday);
    syncCreditGrants(db, 'alice', 1000, monday + 3 * week, monday + 1);
    grantCredit(db, 'alice', 'purchase:test:order', 'purchase', 1500, null, monday);
    expect(creditBalance(db, 'alice', monday)).toMatchObject({ balance: 3000, weeklyResetsAt: monday + week });
    const operation = openCreditOperation(db, 'alice', 'chat', 2000, monday + 2);
    expect(() => openCreditOperation(db, 'alice', 'chat', 2000, monday + 3)).toThrow(/仍在进行/);
    expect(finishCreditOperation(db, 'alice', operation, 1100, monday + 3)).toBe(1100);
    expect(finishCreditOperation(db, 'alice', operation, 1100, monday + 4)).toBe(0);
    expect(creditBalance(db, 'alice', monday + 4)).toMatchObject({ weekly: 0, welcome: 400, purchased: 1500 });
    syncCreditGrants(db, 'alice', 5000, monday + 3 * week, monday + week);
    expect(creditBalance(db, 'alice', monday + week)).toMatchObject({ weekly: 5000, welcome: 400, purchased: 1500 });
  });

  it('uses SDK calls and streams, sums cache/output cost, then rounds once', async () => {
    const db = memoryDb();
    syncCreditGrants(db, 'alice', 0, null);
    const usage = { prompt_tokens: 150, prompt_cache_hit_tokens: 50, prompt_cache_miss_tokens: 100, completion_tokens: 50 };
    const text = { id: 'test-id', created: 1, model: 'deepseek-flash', choices: [{ index: 0, message: { role: 'assistant', content: '答案' }, finish_reason: 'stop' }], usage };
    const upstream = vi.fn<typeof fetch>(async (_input, init) => {
      expect(new Headers(init?.headers).has('content-length')).toBe(false);
      const body = JSON.parse(String(init?.body)) as { stream?: boolean; stream_options?: { include_usage: boolean } };
      if (!body.stream) return Response.json(text);
      expect(body.stream_options?.include_usage).toBe(true);
      return new Response([
        `data: ${JSON.stringify({ ...text, usage: null, choices: [{ index: 0, delta: { content: '答案' } }] })}\n\n`,
        `data: ${JSON.stringify({ ...text, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`,
        'data: [DONE]\n\n',
      ].join(''), { headers: { 'content-type': 'text/event-stream' } });
    });
    vi.stubGlobal('fetch', upstream);
    const model = getChatModel({ provider: 'deepseek', model: 'deepseek-flash', apiKey: 'fixture', fetch: meteredDeepSeekFetch });
    const meter = newCreditMeter(db, 'alice', 'chat');
    await creditScope.run(meter, async () => {
      await model.invoke('第一题');
      const stream = await model.stream('第二题');
      for await (const _ of stream) { /* read the upstream stream to completion */ }
      expect(settleCreditMeter(true)).toEqual({ charged: 2, balance: 498 });
    });
    expect(upstream).toHaveBeenCalledTimes(2);
  });
});
