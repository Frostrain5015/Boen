import type Database from 'better-sqlite3';
import type { MembershipDetails, BillingStatus } from '@boen/shared';

export function initMembership(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_model_preferences (user_id TEXT PRIMARY KEY, provider TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS payment_consents (
      external_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, terms_version TEXT NOT NULL,
      accepted_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS waffo_subscriptions (
      order_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, environment TEXT NOT NULL,
      status TEXT NOT NULL, period_start INTEGER NOT NULL, period_end INTEGER NOT NULL,
      canceled_at INTEGER, event_at INTEGER NOT NULL, event_id TEXT NOT NULL,
      trial_used INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_waffo_sub_user ON waffo_subscriptions(user_id, environment);
    CREATE TABLE IF NOT EXISTS membership_reward_accounts (
      user_id TEXT PRIMARY KEY, balance_seconds INTEGER NOT NULL DEFAULT 0 CHECK(balance_seconds >= 0),
      expires_at INTEGER, updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS membership_reward_ledger (
      id INTEGER PRIMARY KEY, user_id TEXT NOT NULL, delta_seconds INTEGER NOT NULL,
      balance_after INTEGER NOT NULL, reason TEXT NOT NULL, ref_id TEXT UNIQUE NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS payment_checkout_attempts (
      user_id TEXT PRIMARY KEY, external_id TEXT UNIQUE NOT NULL, environment TEXT NOT NULL,
      session_id TEXT, checkout_url TEXT, expires_at INTEGER NOT NULL, state TEXT NOT NULL,
      with_trial INTEGER NOT NULL, created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS membership_trial_history (
      user_id TEXT NOT NULL, environment TEXT NOT NULL, PRIMARY KEY(user_id, environment)
    );
    CREATE TABLE IF NOT EXISTS payment_actions (
      order_id TEXT PRIMARY KEY, action TEXT NOT NULL, request_key TEXT NOT NULL,
      state TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);
  const rewardColumns = db.prepare('PRAGMA table_info(membership_reward_accounts)').all() as Array<{ name: string }>;
  if (!rewardColumns.some(column => column.name === 'active_started_at')) {
    db.exec('ALTER TABLE membership_reward_accounts ADD COLUMN active_started_at INTEGER');
  }
}

export interface SubscriptionRow {
  order_id: string; user_id: string; environment: string; status: BillingStatus;
  period_start: number; period_end: number; canceled_at: number | null;
  event_at: number; event_id: string; trial_used: number;
}
interface RewardRow { balance_seconds: number; expires_at: number | null; active_started_at: number | null }
interface LegacyRow { tier: 'monthly' | 'yearly'; expires_at: number; activated_at: number }
export const nowSeconds = (): number => Math.floor(Date.now() / 1000);
export const billingEnvironment = (): string => process.env.WAFFO_ENVIRONMENT === 'prod' ? 'prod' : 'test';

export function currentSubscription(db: Database.Database, userId: string): SubscriptionRow | undefined {
  return db.prepare(`SELECT * FROM waffo_subscriptions WHERE user_id=? AND environment=?
    ORDER BY CASE WHEN status != 'canceled' THEN 0 ELSE 1 END, event_at DESC LIMIT 1`)
    .get(userId, billingEnvironment()) as SubscriptionRow | undefined;
}

function legacyMembership(db: Database.Database, userId: string, now: number): LegacyRow | undefined {
  return db.prepare(`SELECT tier, expires_at, activated_at FROM subscriptions
    WHERE user_id=? AND tier IN ('monthly','yearly') AND expires_at>?`)
    .get(userId, now) as LegacyRow | undefined;
}

/** Reconcile reward time inside the caller's transaction. Paid access always pauses it. */
export function syncRewards(db: Database.Database, userId: string, now = nowSeconds(), paidStartedAt?: number): RewardRow {
  db.prepare('INSERT OR IGNORE INTO membership_reward_accounts(user_id) VALUES (?)').run(userId);
  const reward = db.prepare('SELECT balance_seconds, expires_at, active_started_at FROM membership_reward_accounts WHERE user_id=?')
    .get(userId) as RewardRow;
  const sub = currentSubscription(db, userId);
  const blocked = Boolean(legacyMembership(db, userId, now)) || Boolean(sub && (sub.status !== 'canceled' || sub.period_end > now));
  if (blocked && reward.expires_at != null) {
    const pauseAt = paidStartedAt == null ? now : Math.min(now, Math.max(paidStartedAt, reward.active_started_at ?? now));
    const remaining = Math.max(0, reward.expires_at - pauseAt);
    reward.balance_seconds += remaining;
    reward.expires_at = null;
    reward.active_started_at = null;
    db.prepare(`INSERT INTO membership_reward_ledger(user_id,delta_seconds,balance_after,reason,ref_id)
      VALUES (?,?,?,'pause',?)`).run(userId, remaining, reward.balance_seconds, crypto.randomUUID());
  } else if (!blocked && reward.balance_seconds > 0) {
    const amount = reward.balance_seconds;
    if ((reward.expires_at ?? 0) <= now) reward.active_started_at = now;
    reward.expires_at = Math.max(now, reward.expires_at ?? now) + amount;
    reward.balance_seconds = 0;
    db.prepare(`INSERT INTO membership_reward_ledger(user_id,delta_seconds,balance_after,reason,ref_id)
      VALUES (?,? ,0,'resume',?)`).run(userId, -amount, crypto.randomUUID());
  }
  db.prepare(`UPDATE membership_reward_accounts SET balance_seconds=?,expires_at=?,active_started_at=?,updated_at=? WHERE user_id=?`)
    .run(reward.balance_seconds, reward.expires_at, reward.active_started_at, now, userId);
  return reward;
}

export function addReward(db: Database.Database, userId: string, seconds: number, refId: string, now = nowSeconds()): number | null {
  return db.transaction(() => {
    if (!Number.isSafeInteger(seconds) || seconds <= 0) throw new Error('Invalid reward duration');
    syncRewards(db, userId, now);
    const seen = db.prepare('SELECT id FROM membership_reward_ledger WHERE ref_id=?').get(refId);
    if (!seen) {
      db.prepare('UPDATE membership_reward_accounts SET balance_seconds=balance_seconds+? WHERE user_id=?').run(seconds, userId);
      db.prepare(`INSERT INTO membership_reward_ledger(user_id,delta_seconds,balance_after,reason,ref_id)
        SELECT user_id,?,balance_seconds,'points',? FROM membership_reward_accounts WHERE user_id=?`).run(seconds, refId, userId);
    }
    return syncRewards(db, userId, now).expires_at;
  })();
}

export function trialEligible(db: Database.Database, userId: string): boolean {
  return !db.prepare('SELECT 1 FROM membership_trial_history WHERE user_id=? AND environment=?').get(userId, billingEnvironment())
    && !currentSubscription(db, userId)
    && !db.prepare("SELECT 1 FROM payment_orders WHERE user_id=? AND order_id IS NOT NULL AND status NOT IN ('pending','failed')").get(userId);
}

export function membershipDetails(db: Database.Database, userId: string, now = nowSeconds()): MembershipDetails {
  return db.transaction(() => {
    const rewards = syncRewards(db, userId, now);
    const sub = currentSubscription(db, userId);
    const legacy = legacyMembership(db, userId, now);
    const paid = Boolean(sub && sub.period_end > now);
    const rewardActive = (rewards.expires_at ?? 0) > now;
    const source: MembershipDetails['membership']['source'] = paid ? 'waffo' : legacy ? 'legacy' : rewardActive ? 'reward' : 'none';
    const until = paid ? sub!.period_end : legacy?.expires_at ?? (rewardActive ? rewards.expires_at : null);
    return {
      membership: { active: source !== 'none', source, accessEndsAt: until,
        legacyTier: legacy?.tier ?? null },
      billing: { status: sub?.status ?? 'none', currentPeriodStart: sub?.period_start ?? null,
        currentPeriodEnd: sub?.period_end ?? null,
        renewsAt: sub && ['active','trialing'].includes(sub.status) ? sub.period_end : null,
        cancelAtPeriodEnd: sub?.status === 'canceling', amount: '3.00', currency: 'USD',
        trialEligible: trialEligible(db, userId),
        checkoutAllowed: !legacy && (!sub || (sub.status === 'canceled' && sub.period_end <= now)),
        portalUrl: process.env.WAFFO_PORTAL_URL || 'https://pancake.waffo.ai/consumer/portal/login' },
      rewards: { bankedSeconds: rewards.balance_seconds, activeUntil: rewards.expires_at },
    };
  })();
}

export function applySubscription(db: Database.Database, row: SubscriptionRow, now = nowSeconds()): boolean {
  return db.transaction(() => {
    const prior = db.prepare('SELECT * FROM waffo_subscriptions WHERE order_id=?').get(row.order_id) as SubscriptionRow | undefined;
    if (prior && (prior.user_id !== row.user_id || prior.environment !== row.environment)) throw new Error('Subscription ownership mismatch');
    if (prior && (row.event_at < prior.event_at || row.period_start < prior.period_start)) return false;
    if (prior?.event_id === row.event_id) return false;
    // A canceled order cannot be resurrected by a delayed lifecycle notification.
    if (prior?.status === 'canceled' && row.status !== 'canceled') return false;
    db.prepare(`INSERT INTO waffo_subscriptions(order_id,user_id,environment,status,period_start,period_end,canceled_at,event_at,event_id,trial_used)
      VALUES (@order_id,@user_id,@environment,@status,@period_start,@period_end,@canceled_at,@event_at,@event_id,@trial_used)
      ON CONFLICT(order_id) DO UPDATE SET status=excluded.status,period_start=excluded.period_start,
      period_end=excluded.period_end,canceled_at=excluded.canceled_at,event_at=excluded.event_at,
      event_id=excluded.event_id,trial_used=MAX(waffo_subscriptions.trial_used,excluded.trial_used),updated_at=unixepoch()`)
      .run(row);
    db.prepare('INSERT OR IGNORE INTO membership_trial_history(user_id,environment) VALUES (?,?)').run(row.user_id, row.environment);
    syncRewards(db, row.user_id, now, ['active','trialing','canceling'].includes(row.status) ? row.period_start : undefined);
    return true;
  })();
}
