import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
import db from './db.js';

// ── 自描述签名兑换码 ─────────────────────────────────────────
// 码 = Crockford-Base32( payload(14B) ‖ HMAC-SHA256(payload)[:6B] )，共 20 字节 → 32 个 base32 字符。
// 条款全部编码进 payload 并由 HMAC 签名，服务端离线可验、无需查库。库中只保留逻辑上不属于码本身的
// 「消费状态」(code_redemptions) 与「撤销名单」(code_revocations)。
//
// payload 字节布局（大端）：
//   [0]    version        u8   —— 密钥/格式轮换预留
//   [1]    maxUses        u8   —— 0=无限(可复用)；1=一次性；N=限 N 次
//   [2-3]  durationDays   u16  —— 兑换得到的会员天数
//   [4-5]  codeExpiryDay  u16  —— 码失效日（距 EPOCH 的天数；0=永不过期）
//   [6-7]  batch          u16  —— 批次号，用于整批撤销/统计
//   [8-13] nonce          6B   —— 随机唯一码 id（hex 存库，作消费流水主键）

const VERSION = 1;
const EPOCH = Math.floor(Date.UTC(2024, 0, 1) / 1000); // 秒
const PAYLOAD_LEN = 14;
const SIG_LEN = 6;
const TOTAL_LEN = PAYLOAD_LEN + SIG_LEN; // 20
// Crockford Base32（去掉 I/L/O/U，避免人眼歧义）
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export interface CodePayload {
  version: number;
  maxUses: number;       // 0 = 无限
  durationDays: number;
  codeExpiryDay: number; // 0 = 永不过期
  batch: number;
  nonce: string;         // hex(6 字节)
}

export type RedeemError =
  | 'invalid_code'
  | 'code_expired'
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
  const b = Buffer.alloc(PAYLOAD_LEN);
  b.writeUInt8(p.version, 0);
  b.writeUInt8(p.maxUses, 1);
  b.writeUInt16BE(p.durationDays, 2);
  b.writeUInt16BE(p.codeExpiryDay, 4);
  b.writeUInt16BE(p.batch, 6);
  Buffer.from(p.nonce, 'hex').copy(b, 8, 0, 6);
  return b;
}

function unpackPayload(b: Buffer): CodePayload {
  return {
    version: b.readUInt8(0),
    maxUses: b.readUInt8(1),
    durationDays: b.readUInt16BE(2),
    codeExpiryDay: b.readUInt16BE(4),
    batch: b.readUInt16BE(6),
    nonce: b.subarray(8, 14).toString('hex'),
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

/** 把「距今天数」换算成 payload 的 codeExpiryDay 字段（0/缺省 = 永久） */
export function expiryDaysToField(days: number | undefined): number {
  if (!days || days <= 0) return 0;
  const expSec = Math.floor(Date.now() / 1000) + days * 86400;
  return Math.floor((expSec - EPOCH) / 86400);
}

export function generateCode(
  opts: { maxUses: number; durationDays: number; codeExpiryDay: number; batch: number },
  secret: string,
): { code: string; nonce: string } {
  const nonce = randomBytes(6).toString('hex');
  return { code: encodeCode({ version: VERSION, ...opts, nonce }, secret), nonce };
}

// ── 兑换 ─────────────────────────────────────────────────────

/**
 * 校验并为用户兑换会员（纯服务端、原子事务）。
 * better-sqlite3 同步串行 + 事务内 count 检查 + PK(nonce,user_id) 三重保证一次性码不双花。
 */
export function redeemForUser(userId: string, rawCode: string, secret: string): RedeemResult {
  const p = decodeCode(rawCode, secret);
  if (!p || p.version !== VERSION) return { ok: false, error: 'invalid_code' };

  const now = Math.floor(Date.now() / 1000);
  if (p.codeExpiryDay !== 0 && now > EPOCH + p.codeExpiryDay * 86400) {
    return { ok: false, error: 'code_expired' };
  }

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

      const subRow = db.prepare(`SELECT expires_at FROM subscriptions WHERE user_id=?`).get(userId) as
        | { expires_at: number | null }
        | undefined;
      // 已是有效会员则在原到期时间上叠加，避免临期兑换损失天数
      const base = subRow?.expires_at && subRow.expires_at > now ? subRow.expires_at : now;
      const until = base + p.durationDays * 86400;

      db.prepare(
        `INSERT INTO code_redemptions (nonce, user_id, duration_days, granted_until) VALUES (?, ?, ?, ?)`,
      ).run(p.nonce, userId, p.durationDays, until);

      db.prepare(`
        INSERT INTO subscriptions (user_id, tier, activated_at, expires_at, updated_at)
        VALUES (?, 'premium', ?, ?, unixepoch())
        ON CONFLICT(user_id) DO UPDATE SET
          tier='premium',
          expires_at=excluded.expires_at,
          activated_at=COALESCE(subscriptions.activated_at, excluded.activated_at),
          updated_at=unixepoch()
      `).run(userId, now, until);

      return { ok: true, until, durationDays: p.durationDays };
    })();
  } catch {
    // PK 冲突等并发兜底
    return { ok: false, error: 'already_redeemed' };
  }
}
