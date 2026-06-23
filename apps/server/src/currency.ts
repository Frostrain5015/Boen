import db from './db.js';
import { grantMembershipDays } from './redeem.js';

// ── 星月积分（局内货币）经济参数 ─────────────────────────────
// 积分 = LLM评分产出(主) + 星级跨越奖励(额外)
//   SCORE_RATE      —— LLM评分 0~100 × 系数 × 学科熟练度倍率
//   STAR_BONUS_RATE —— 知识点每跨越一个 10-rating 档位(≈半星)的奖励
// 精算：一个 75 分的新知识点会话 ≈39 分(评分) + 24 分(星级跨越)
export const DAILY_CAP = 100;

/** LLM/考试评分换算系数：scorePoints = round(score × SCORE_RATE × (1+S/100))。
 *  0.35 × 75 分 × 1.5(S=50) ≈ 39 分 — 占总分 ~60%，为主。 */
export const SCORE_RATE = 0.35;

/** 知识点的 rating 每跨越 10 分阈值 ≈ 半星级 的额外奖励。
 *  新知识点从 0→85 跨越 8 个阈值 → round(8 × 2 × 1.5) ≈ 24 分 */
export const STAR_BONUS_RATE = 2;

/** 积分可兑换的会员产品。仅保留皓月卡（月卡），星耀卡为现金专属。 */
export const CURRENCY_PRODUCTS = {
  month: { key: 'month', name: '皓月卡', days: 30, cost: 2000 },
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

/** 评分产出：round(score × SCORE_RATE × (1+S/100))。score=0~100。 */
export function computeScorePoints(score: number, subjectProf: number): number {
  const S = Math.max(0, Math.min(100, subjectProf));
  return Math.round(score * SCORE_RATE * (1 + S / 100));
}

/** 星级跨越奖励：Σ_kp max(0, floor(after/10) − floor(before/10)) × STAR_BONUS_RATE × (1+S/100)。
 *  每个 10-rating 阈值 ≈ 半星。知识点首次跨越多档时一次性放送。 */
export function computeStarBonus(
  changes: Array<{ before: number; after: number }>,
  subjectProf: number,
): number {
  const S = Math.max(0, Math.min(100, subjectProf));
  const tiers = changes.reduce((sum, c) => {
    const b = Math.floor(Math.max(0, c.before ?? 0) / 10);
    const a = Math.floor(Math.max(0, c.after ?? 0) / 10);
    return sum + Math.max(0, a - b);
  }, 0);
  return Math.round(tiers * STAR_BONUS_RATE * (1 + S / 100));
}

export interface EarnResult {
  earned: number; // 实际入账（已按日上限封顶）
  capped: boolean; // 因日上限被截断
  balance: number;
}

/**
 * 结算入账：原子事务内按日上限封顶、记账（user_currency + ledger + daily_earn）。
 * 调用方应先通过 computeScorePoints / computeStarBonus 算好总分传入。
 */
export function earnPoints(
  userId: string,
  amount: number,
  reason: 'session' | 'exam',
  refId?: string,
): EarnResult {
  if (amount <= 0) {
    const cur = db.prepare(`SELECT balance FROM user_currency WHERE user_id=?`).get(userId) as { balance: number } | undefined;
    return { earned: 0, capped: false, balance: cur?.balance ?? 0 };
  }
  try {
    return db.transaction((): EarnResult => {
      const today = todayStr();
      const dayRow = db.prepare(`SELECT earned FROM currency_daily_earn WHERE user_id=? AND date=?`).get(userId, today) as
        | { earned: number }
        | undefined;
      const todayEarned = dayRow?.earned ?? 0;
      const remaining = Math.max(0, DAILY_CAP - todayEarned);
      const earned = Math.min(amount, remaining);

      const curRow = db.prepare(`SELECT balance FROM user_currency WHERE user_id=?`).get(userId) as
        | { balance: number }
        | undefined;
      const balanceBefore = curRow?.balance ?? 0;

      if (earned <= 0) {
        return { earned: 0, capped: amount > 0, balance: balanceBefore };
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

      return { earned, capped: amount > earned, balance: balanceAfter };
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
