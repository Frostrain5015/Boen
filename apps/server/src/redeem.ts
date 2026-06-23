import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
import db from './db.js';

// ── 自描述签名兑换码 ─────────────────────────────────────────
// 码 = Crockford-Base32( payload(6B) ‖ HMAC-SHA256(payload)[:4B] )，共 10 字节 → 16 个 base32 字符。
// 条款编码进 payload 并由 HMAC 签名，服务端离线可验、无需查库。库中只保留逻辑上不属于码本身的
// 「消费状态」(code_redemptions) 与「撤销名单」(code_revocations)。
// 不含码自身有效期：作废靠 code_revocations（单码 nonce 或整批 batch）。
//
// payload 48 bit：
//   terms 16 bit（高→低）：version(3) maxUses(3,0=无限) durationBit(1,0=30天/1=365天) batch(9)
//   nonce 32 bit：随机唯一码 id（hex 存库，作消费流水主键）

const VERSION = 1;
const PAYLOAD_LEN = 6;
const SIG_LEN = 4;
const TOTAL_LEN = PAYLOAD_LEN + SIG_LEN; // 10
const NONCE_BYTES = 4;
const MAX_USES = 0x7;    // 3 bit
const MAX_BATCH = 0x1ff; // 9 bit
const MAX_VERSION = 0x7; // 3 bit
// 星月卡面值仅两档（月卡/年卡）
const DURATION_30 = 30;
const DURATION_365 = 365;
// Crockford Base32（去掉 I/L/O/U，避免人眼歧义）
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export interface CodePayload {
  version: number;
  maxUses: number;      // 0 = 无限
  durationDays: number; // 30 或 365
  batch: number;
  nonce: string;        // hex(4 字节)
}

export type RedeemError =
  | 'invalid_code'
  | 'code_disabled'
  | 'code_used'
  | 'already_redeemed';

export type RedeemResult =
  | { ok: true; until: number; durationDays: number }
  | { ok: false; error: RedeemError };

// ── 编解码 ───────────────────────────────────────────────────

function sign(payload: Buffer, secret: string): Buffer {
  return createHmac('sha256', secret).update(payload).digest().subarray(0, SIG_LEN);
}

function packPayload(p: CodePayload): Buffer {
  const durationBit = p.durationDays === DURATION_365 ? 1 : 0;
  const term =
    ((p.version & MAX_VERSION) << 13) |
    ((p.maxUses & MAX_USES) << 10) |
    (durationBit << 9) |
    (p.batch & MAX_BATCH);
  const b = Buffer.alloc(PAYLOAD_LEN);
  b.writeUInt16BE(term, 0);
  Buffer.from(p.nonce, 'hex').copy(b, 2, 0, NONCE_BYTES);
  return b;
}

function unpackPayload(b: Buffer): CodePayload {
  const term = b.readUInt16BE(0);
  return {
    version: (term >> 13) & MAX_VERSION,
    maxUses: (term >> 10) & MAX_USES,
    durationDays: (term >> 9) & 1 ? DURATION_365 : DURATION_30,
    batch: term & MAX_BATCH,
    nonce: b.subarray(2, 6).toString('hex'),
  };
}

function toCrockford(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function fromCrockford(input: string, outLen: number): Buffer | null {
  // 归一化：大写、去连字符/空格、I/L→1、O→0（Crockford 容错）
  const norm = input.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  const out = Buffer.alloc(outLen);
  let bits = 0;
  let value = 0;
  let idx = 0;
  for (const ch of norm) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) return null;
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      if (idx >= outLen) return null;
      out[idx++] = (value >>> (bits - 8)) & 0xff;
      bits -= 8;
    }
  }
  return idx === outLen ? out : null;
}

/** 把人类可读码（XXXX-XXXX-…）格式化输出 */
function groupHyphens(raw: string): string {
  return raw.replace(/(.{4})/g, '$1-').replace(/-$/, '');
}

export function encodeCode(p: CodePayload, secret: string): string {
  const payload = packPayload(p);
  const full = Buffer.concat([payload, sign(payload, secret)]);
  return groupHyphens(toCrockford(full));
}

/** 解码 + 验签；任何不合法（格式/签名/长度）一律返回 null */
export function decodeCode(code: string, secret: string): CodePayload | null {
  const buf = fromCrockford(code, TOTAL_LEN);
  if (!buf) return null;
  const payload = buf.subarray(0, PAYLOAD_LEN);
  const sig = buf.subarray(PAYLOAD_LEN);
  const expected = sign(payload, secret);
  if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) return null;
  return unpackPayload(payload);
}

// ── 生成（CLI 用）─────────────────────────────────────────────

export function generateCode(
  opts: { maxUses: number; durationDays: number; batch: number },
  secret: string,
): { code: string; nonce: string } {
  const nonce = randomBytes(NONCE_BYTES).toString('hex');
  return { code: encodeCode({ version: VERSION, ...opts, nonce }, secret), nonce };
}

// ── 会员发放（兑换码 / 星月积分共用）─────────────────────────

/**
 * 为用户发放/续期会员若干天（叠加续期语义）。
 * 已是有效会员则在原到期时间上叠加，避免临期兑换损失天数；否则从 now 起算。
 * 供 redeemForUser（兑换码）与 currency.ts（星月积分兑换）共用。
 * ⚠️ 仅做 subscriptions upsert，调用方负责放进自己的事务并记录各自的流水。
 */
export function grantMembershipDays(userId: string, days: number): { until: number; tier: 'monthly' | 'yearly' } {
  const now = Math.floor(Date.now() / 1000);
  const subRow = db.prepare(`SELECT expires_at FROM subscriptions WHERE user_id=?`).get(userId) as
    | { expires_at: number | null }
    | undefined;
  const base = subRow?.expires_at && subRow.expires_at > now ? subRow.expires_at : now;
  const until = base + days * 86400;
  const tier: 'monthly' | 'yearly' = days >= 365 ? 'yearly' : 'monthly';
  db.prepare(`
    INSERT INTO subscriptions (user_id, tier, activated_at, expires_at, updated_at)
    VALUES (?, ?, ?, ?, unixepoch())
    ON CONFLICT(user_id) DO UPDATE SET
      /* 仅当新 tier 更高时才升级（yearly > monthly），不因续期月卡降级年卡用户 */
      tier=CASE
        WHEN excluded.tier='yearly' OR subscriptions.tier='yearly' THEN 'yearly'
        ELSE excluded.tier
      END,
      expires_at=excluded.expires_at,
      activated_at=COALESCE(subscriptions.activated_at, excluded.activated_at),
      updated_at=unixepoch()
  `).run(userId, tier, now, until);
  return { until, tier };
}

// ── 兑换 ─────────────────────────────────────────────────────

/**
 * 校验并为用户兑换星月卡（纯服务端、原子事务）。
 * better-sqlite3 同步串行 + 事务内 count 检查 + PK(nonce,user_id) 三重保证一次性码不双花。
 */
export function redeemForUser(userId: string, rawCode: string, secret: string): RedeemResult {
  const p = decodeCode(rawCode, secret);
  if (!p || p.version !== VERSION) return { ok: false, error: 'invalid_code' };

  // 撤销名单：单码 nonce 或整批 batch
  const revoked = db
    .prepare(
      `SELECT 1 FROM code_revocations WHERE (scope='nonce' AND value=?) OR (scope='batch' AND value=?) LIMIT 1`,
    )
    .get(p.nonce, String(p.batch));
  if (revoked) return { ok: false, error: 'code_disabled' };

  try {
    return db.transaction((): RedeemResult => {
      // 先判同人重复（即便一次性码已被领完，也优先告诉本人"你已兑换过"，体验更准确）
      const dup = db.prepare(`SELECT 1 FROM code_redemptions WHERE nonce=? AND user_id=?`).get(p.nonce, userId);
      if (dup) return { ok: false, error: 'already_redeemed' };

      const used = (db.prepare(`SELECT COUNT(*) AS c FROM code_redemptions WHERE nonce=?`).get(p.nonce) as { c: number }).c;
      if (p.maxUses > 0 && used >= p.maxUses) return { ok: false, error: 'code_used' };

      const { until } = grantMembershipDays(userId, p.durationDays);

      db.prepare(
        `INSERT INTO code_redemptions (nonce, user_id, duration_days, granted_until) VALUES (?, ?, ?, ?)`,
      ).run(p.nonce, userId, p.durationDays, until);

      return { ok: true, until, durationDays: p.durationDays };
    })();
  } catch {
    // PK 冲突等并发兜底
    return { ok: false, error: 'already_redeemed' };
  }
}
