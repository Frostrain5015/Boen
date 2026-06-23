import db from './db.js';
import { grantMembershipDays } from './redeem.js';

// ── 星月积分（局内货币）经济参数 ─────────────────────────────
// 公式：sessionPoints = floor( rawGain × (1 + S/100) × λ )，再按日上限封顶。
//   rawGain      —— 本次会话/考试所有知识点的「正向 Elo 增量」之和（调用方计算）。
//   S            —— 学科总熟练度 0~100（调用方从 getProfileOutline 取并传入）。
//   λ            —— 全局换算常数，刻意小以维持珍贵感。
// 精算依据见 plans/modular-nibbling-swan.md：典型日活 ~5 分/天 → 32 天换皓月卡(160)。
export const CONVERT_RATE = 0.06;
export const DAILY_CAP = 8;
const MIN_GAIN_FOR_FLOOR1 = 5; // rawGain≥此值但 floor 为 0 时保底给 1 分

/** 积分可兑换的会员产品（年卡积分不打折：= 12×月卡，保护年卡现金收入） */
export const CURRENCY_PRODUCTS = {
  month: { key: 'month', name: '皓月卡', days: 30, cost: 160 },
  year: { key: 'year', name: '星耀卡', days: 365, cost: 1920 },
} as const;

export type CurrencyProductKey = keyof typeof CURRENCY_PRODUCTS;

export interface CurrencyStatus {
  balance: number;
  totalEarned: number;
  totalSpent: number;
  todayEarned: number;
  dailyCap: number;
  dailyRemaining: number;
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

/** 读取用户积分状态（含当日已赚 / 剩余额度），无记录时返回零值。 */
export function getCurrencyStatus(userId: string): CurrencyStatus {
  const row = db.prepare(`SELECT balance, total_earned, total_spent FROM user_currency WHERE user_id=?`).get(userId) as
    | { balance: number; total_earned: number; total_spent: number }
    | undefined;
  const dayRow = db.prepare(`SELECT earned FROM currency_daily_earn WHERE user_id=? AND date=?`).get(userId, todayStr()) as
    | { earned: number }
    | undefined;
  const todayEarned = dayRow?.earned ?? 0;
  return {
    balance: row?.balance ?? 0,
    totalEarned: row?.total_earned ?? 0,
    totalSpent: row?.total_spent ?? 0,
    todayEarned,
    dailyCap: DAILY_CAP,
    dailyRemaining: Math.max(0, DAILY_CAP - todayEarned),
  };
}

/** 纯函数：把 rawGain + 学科熟练度换算成「理论应得积分」（未封顶、未取整前的下游 floor）。 */
export function computeSessionPoints(rawGain: number, subjectProf: number): number {
  if (!(rawGain > 0)) return 0;
  const S = Math.max(0, Math.min(100, subjectProf));
  const raw = Math.floor(rawGain * (1 + S / 100) * CONVERT_RATE);
  return Math.max(rawGain >= MIN_GAIN_FOR_FLOOR1 ? 1 : 0, raw);
}

export interface EarnResult {
  earned: number; // 实际入账（已按日上限封顶）
  capped: boolean; // 因日上限被截断
  balance: number;
}

/**
 * 结算入账：原子事务内算分、按当日剩余额度封顶、记账（user_currency + ledger + daily_earn）。
 * 仅结构化学习/考试调用；rawGain 应为正向 Elo 增量之和。
 */
export function earnPoints(
  userId: string,
  rawGain: number,
  subjectProf: number,
  reason: 'session' | 'exam',
  refId?: string,
): EarnResult {
  const want = computeSessionPoints(rawGain, subjectProf);
  try {
    return db.transaction((): EarnResult => {
      const today = todayStr();
      const dayRow = db.prepare(`SELECT earned FROM currency_daily_earn WHERE user_id=? AND date=?`).get(userId, today) as
        | { earned: number }
        | undefined;
      const todayEarned = dayRow?.earned ?? 0;
      const remaining = Math.max(0, DAILY_CAP - todayEarned);
      const earned = Math.min(want, remaining);

      const curRow = db.prepare(`SELECT balance FROM user_currency WHERE user_id=?`).get(userId) as
        | { balance: number }
        | undefined;
      const balanceBefore = curRow?.balance ?? 0;

      if (earned <= 0) {
        return { earned: 0, capped: want > 0, balance: balanceBefore };
      }

      const balanceAfter = balanceBefore + earned;
      db.prepare(`
        INSERT INTO user_currency (user_id, balance, total_earned, total_spent, updated_at)
        VALUES (?, ?, ?, 0, unixepoch())
        ON CONFLICT(user_id) DO UPDATE SET
          balance=balance+excluded.balance,
          total_earned=total_earned+excluded.total_earned,
          updated_at=unixepoch()
      `).run(userId, earned, earned);

      db.prepare(`
        INSERT INTO currency_ledger (user_id, type, amount, balance_after, reason, ref_id)
        VALUES (?, 'earn', ?, ?, ?, ?)
      `).run(userId, earned, balanceAfter, reason, refId ?? null);

      db.prepare(`
        INSERT INTO currency_daily_earn (user_id, date, earned)
        VALUES (?, ?, ?)
        ON CONFLICT(user_id, date) DO UPDATE SET earned=earned+excluded.earned
      `).run(userId, today, earned);

      return { earned, capped: want > earned, balance: balanceAfter };
    })();
  } catch {
    // 入账失败不应阻断主结算流程
    const cur = db.prepare(`SELECT balance FROM user_currency WHERE user_id=?`).get(userId) as { balance: number } | undefined;
    return { earned: 0, capped: false, balance: cur?.balance ?? 0 };
  }
}

export type RedeemMembershipError = 'invalid_product' | 'insufficient';

export type RedeemMembershipResult =
  | { ok: true; balance: number; until: number; days: number; tier: 'monthly' | 'yearly' }
  | { ok: false; error: RedeemMembershipError; balance: number; cost?: number };

/**
 * 用星月积分兑换会员（原子事务：余额检查 → 扣减 → 记账 → 发卡）。
 * 复用 grantMembershipDays 的叠加续期语义。
 */
export function redeemMembershipWithPoints(userId: string, productKey: string): RedeemMembershipResult {
  const product = (CURRENCY_PRODUCTS as Record<string, (typeof CURRENCY_PRODUCTS)[CurrencyProductKey]>)[productKey];
  if (!product) {
    const cur = getCurrencyStatus(userId);
    return { ok: false, error: 'invalid_product', balance: cur.balance };
  }
  try {
    return db.transaction((): RedeemMembershipResult => {
      const curRow = db.prepare(`SELECT balance FROM user_currency WHERE user_id=?`).get(userId) as
        | { balance: number }
        | undefined;
      const balance = curRow?.balance ?? 0;
      if (balance < product.cost) {
        return { ok: false, error: 'insufficient', balance, cost: product.cost };
      }
      const balanceAfter = balance - product.cost;
      db.prepare(`
        UPDATE user_currency SET balance=?, total_spent=total_spent+?, updated_at=unixepoch() WHERE user_id=?
      `).run(balanceAfter, product.cost, userId);

      db.prepare(`
        INSERT INTO currency_ledger (user_id, type, amount, balance_after, reason, ref_id)
        VALUES (?, 'spend', ?, ?, ?, ?)
      `).run(userId, -product.cost, balanceAfter, `redeem_${product.key}`, product.key);

      const { until, tier } = grantMembershipDays(userId, product.days);
      return { ok: true, balance: balanceAfter, until, days: product.days, tier };
    })();
  } catch {
    const cur = getCurrencyStatus(userId);
    return { ok: false, error: 'insufficient', balance: cur.balance };
  }
}

export interface LedgerEntry {
  id: number;
  type: string;
  amount: number;
  balanceAfter: number;
  reason: string | null;
  refId: string | null;
  createdAt: number;
}

/** 流水历史（倒序）。 */
export function listLedger(userId: string, limit = 20): LedgerEntry[] {
  const rows = db.prepare(`
    SELECT id, type, amount, balance_after, reason, ref_id, created_at
    FROM currency_ledger WHERE user_id=? ORDER BY created_at DESC, id DESC LIMIT ?
  `).all(userId, limit) as Array<{
    id: number; type: string; amount: number; balance_after: number; reason: string | null; ref_id: string | null; created_at: number;
  }>;
  return rows.map((r) => ({
    id: r.id, type: r.type, amount: r.amount, balanceAfter: r.balance_after,
    reason: r.reason, refId: r.ref_id, createdAt: r.created_at,
  }));
}
