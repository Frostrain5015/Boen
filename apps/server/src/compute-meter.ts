import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { CreditError, creditBalance, creditNow, finishCreditOperation, openCreditOperation, type CreditOperation } from './compute-credits.js';

const SCALE = 1_000_000;
const RATES = { flash: { hit: 40, miss: 2000, output: 8000 }, pro: { hit: 300, miss: 9000, output: 27000 } };

interface Usage { hit: number; miss: number; output: number }
interface Meter {
  db: Database.Database;
  userId: string;
  purpose: string;
  operation: CreditOperation;
  covered: boolean;
  spent: number;
  reserved: number;
  unknown: number;
  attempts: number;
  streaming: boolean;
  closed: boolean;
}

export const creditScope = new AsyncLocalStorage<Meter>();
export const newCreditMeter = (db: Database.Database, userId: string, purpose: string, limit = Infinity, covered = false): Meter =>
  ({ db, userId, purpose, covered, operation: openCreditOperation(db, userId, purpose, limit, creditNow(), covered), spent: 0, reserved: 0, unknown: 0, attempts: 0, streaming: false, closed: false });

export function settleCreditMeter(success: boolean, meter = creditScope.getStore()) {
  if (!meter || meter.closed) return;
  meter.closed = true;
  const charged = finishCreditOperation(meter.db, meter.userId, meter.operation, success && !meter.covered ? Math.ceil(meter.spent / SCALE) : 0);
  return { charged, balance: creditBalance(meter.db, meter.userId).balance };
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
const tokenCount = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

export function readDeepSeekUsage(value: unknown): Usage | null {
  const usage = record(record(value)?.usage);
  const prompt = tokenCount(usage?.prompt_tokens);
  const output = tokenCount(usage?.completion_tokens);
  const hit = tokenCount(usage?.prompt_cache_hit_tokens) ?? tokenCount(record(usage?.prompt_tokens_details)?.cached_tokens);
  const miss = tokenCount(usage?.prompt_cache_miss_tokens);
  if (output === null) return null;
  if (hit !== null && miss !== null && (prompt === null || prompt === hit + miss)) return { hit, miss, output };
  if (prompt === null || hit === null || hit > prompt) return null;
  return { hit, miss: prompt - hit, output };
}

// UTF-8 bytes give a conservative text estimate without shipping a tokenizer.
// Bound image requests separately so a base64 payload is never counted as prompt text.
function promptEstimate(body: Record<string, unknown>) {
  let images = 0;
  const prompt = JSON.stringify({ messages: body.messages, tools: body.tools }, (_key, value: unknown) => {
    const part = record(value);
    if (part?.type === 'image_url' || part?.type === 'file') {
      images++;
      return null;
    }
    return value;
  });
  const count = Array.isArray(body.messages) ? body.messages.length : 0;
  return Buffer.byteLength(prompt) + 256 + 16 * count + images * 32000;
}

function tryUsage(text: string): Usage | null {
  try { return readDeepSeekUsage(JSON.parse(text)); } catch { return null; }
}

function meteredStream(source: ReadableStream<Uint8Array>, complete: (usage: Usage | null) => void) {
  const reader = source.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let usage: Usage | null = null;
  const parse = (line: string) => {
    if (!line.startsWith('data:')) return;
    const parsed = tryUsage(line.slice(5).trim());
    if (parsed) { usage = parsed; complete(parsed); }
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          parse(buffer + decoder.decode());
          complete(usage);
          controller.close();
          return;
        }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) parse(line);
        controller.enqueue(value);
      } catch (error) {
        complete(usage);
        controller.error(error);
      }
    },
    async cancel(reason: unknown) {
      try { await reader.cancel(reason); } finally { complete(usage); }
    },
  });
}

export const meteredDeepSeekFetch: typeof fetch = async (input, init) => {
  const meter = creditScope.getStore();
  if (!meter) return fetch(input, init);
  if (meter.closed) throw new CreditError('credit_operation_busy');
  if (typeof init?.body !== 'string') throw new Error('Expected a JSON DeepSeek request');
  const body = record(JSON.parse(init.body));
  if (!body || typeof body.model !== 'string') throw new Error('Missing DeepSeek model');
  const rates = body.model === 'deepseek-v4-pro' ? RATES.pro : RATES.flash;
  const { operation } = meter;
  if (++meter.attempts > 40) throw new CreditError('credit_operation_busy');
  const requestedOutput = tokenCount(body.max_tokens) ?? 4096;
  const inputHold = promptEstimate(body) * rates.miss;
  const capacity = operation.budget * SCALE - meter.spent - meter.reserved - meter.unknown;
  const outputLimit = Math.min(requestedOutput, Math.floor((capacity - inputHold) / rates.output));
  if (outputLimit < Math.min(requestedOutput, 256)) throw new CreditError('insufficient_credits');
  const hold = inputHold + outputLimit * rates.output;
  const id = randomUUID();
  meter.db.prepare('INSERT INTO compute_provider_usage(id,operation_id,model,started_at) VALUES (?,?,?,?)')
    .run(id, operation.id, body.model, creditNow());
  meter.reserved += hold;
  body.max_tokens = outputLimit;
  if (body.stream === true) body.stream_options = { ...record(body.stream_options), include_usage: true };

  let completed = false;
  const complete = (usage: Usage | null, mightBeBilled = true) => {
    if (completed) return;
    completed = true;
    meter.reserved -= hold;
    if (!usage) {
      if (mightBeBilled) meter.unknown += hold;
      return;
    }
    meter.db.prepare('UPDATE compute_provider_usage SET hit=?,miss=?,output=? WHERE id=?')
      .run(usage.hit, usage.miss, usage.output, id);
    meter.spent += usage.hit * rates.hit + usage.miss * rates.miss + usage.output * rates.output;
  };
  try {
    const lifetime = AbortSignal.timeout(Math.max(1, (operation.startedAt + 840 - creditNow()) * 1000));
    const signal = init.signal ? AbortSignal.any([init.signal, lifetime]) : lifetime;
    const response = await fetch(input, { ...init, signal, body: JSON.stringify(body) });
    if (!response.ok) { complete(null, response.status >= 500); return response; }
    if (!response.body) { complete(null); return response; }
    if (body.stream === true) {
      return new Response(meteredStream(response.body, complete), { headers: response.headers, status: response.status, statusText: response.statusText });
    }
    const content = await response.text();
    complete(tryUsage(content));
    return new Response(content, { headers: response.headers, status: response.status, statusText: response.statusText });
  } catch (error) {
    complete(null);
    throw error;
  }
};
