import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { WELCOME_POINTS, type ComputeCredits } from '@boen/shared';
import { billingEnvironment } from './membership.js';

const DAY = 86400;
const WEEK = 7 * DAY;
const MONDAY = 4 * DAY - 8 * 3600;

export function initComputeCredits(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS compute_credit_grants (
      user_id TEXT NOT NULL, ref TEXT NOT NULL, kind TEXT NOT NULL,
      issued INTEGER NOT NULL, remaining INTEGER NOT NULL CHECK(remaining >= 0),
      expires_at INTEGER, created_at INTEGER NOT NULL,
      PRIMARY KEY(user_id, ref)
    );
    CREATE INDEX IF NOT EXISTS compute_credit_wallet ON compute_credit_grants(user_id, expires_at);
    CREATE TABLE IF NOT EXISTS compute_credit_operations (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, purpose TEXT NOT NULL,
      budget INTEGER NOT NULL, charged INTEGER, started_at INTEGER NOT NULL, ended_at INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS compute_one_active_operation
      ON compute_credit_operations(user_id) WHERE ended_at IS NULL;
    CREATE INDEX IF NOT EXISTS compute_operations_recent ON compute_credit_operations(user_id, started_at);
    CREATE TABLE IF NOT EXISTS compute_provider_usage (
      id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, model TEXT NOT NULL,
      started_at INTEGER NOT NULL, hit INTEGER, miss INTEGER, output INTEGER,
      FOREIGN KEY(operation_id) REFERENCES compute_credit_operations(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS compute_topups (
      external_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, request_id TEXT NOT NULL,
      environment TEXT NOT NULL, product_id TEXT NOT NULL, points INTEGER NOT NULL,
      amount TEXT NOT NULL, session_id TEXT, checkout_url TEXT, expires_at TEXT, order_id TEXT,
      state TEXT NOT NULL DEFAULT 'pending', refunded_cents INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(user_id, environment, request_id), UNIQUE(environment, order_id)
    );
  `);
}

export const creditNow = () => Math.floor(Date.now() / 1000);
export const weekStart = (now: number) => Math.floor((now - MONDAY) / WEEK) * WEEK + MONDAY;

export function grantCredit(db: Database.Database, userId: string, ref: string, kind: 'welcome' | 'weekly' | 'purchase', points: number, expiresAt: number | null, now = creditNow()) {
  db.prepare(`INSERT OR IGNORE INTO compute_credit_grants(user_id,ref,kind,issued,remaining,expires_at,created_at)
    VALUES (?,?,?,?,?,?,?)`).run(userId, ref, kind, points, points, expiresAt, now);
}

export function syncCreditGrants(db: Database.Database, userId: string, weekly: number, activeUntil: number | null, now = creditNow()) {
  db.transaction(() => {
    grantCredit(db, userId, 'welcome', 'welcome', WELCOME_POINTS, now + 14 * DAY, now);
    const start = weekStart(now);
    const ref = `week:${start}`;
    if (!weekly || !activeUntil || activeUntil <= now) {
      db.prepare('UPDATE compute_credit_grants SET remaining=0,expires_at=? WHERE user_id=? AND ref=? AND expires_at>?')
        .run(now, userId, ref, now);
      return;
    }
    grantCredit(db, userId, ref, 'weekly', weekly, Math.min(start + WEEK, activeUntil), now);
    // A same-week renewal extends the bucket; a tier upgrade adds just the difference.
    db.prepare(`UPDATE compute_credit_grants
      SET remaining=MIN(?,CASE WHEN expires_at>? THEN remaining ELSE 0 END+MAX(0,?-issued)),
          issued=MAX(issued,?), expires_at=?
      WHERE user_id=? AND ref=?`).run(weekly, now, weekly, weekly, Math.min(start + WEEK, activeUntil), userId, ref);
  }).immediate();
}

interface Grant { ref: string; kind: string; remaining: number; expires_at: number | null }
function activeGrants(db: Database.Database, userId: string, now: number): Grant[] {
  return db.prepare(`SELECT ref,kind,remaining,expires_at FROM compute_credit_grants
    WHERE user_id=? AND created_at<=? AND (expires_at IS NULL OR expires_at>?) AND (kind!='purchase' OR ref LIKE ?)
    ORDER BY expires_at IS NULL,expires_at,created_at,ref`).all(userId, now, now, `purchase:${billingEnvironment()}:%`) as Grant[];
}

export function creditBalance(db: Database.Database, userId: string, now = creditNow()): ComputeCredits {
  const credits: ComputeCredits = { balance: 0, welcome: 0, welcomeExpiresAt: null, weekly: 0, weeklyResetsAt: null, purchased: 0 };
  for (const grant of activeGrants(db, userId, now)) {
    credits.balance += grant.remaining;
    if (grant.kind === 'welcome') { credits.welcome = grant.remaining; credits.welcomeExpiresAt = grant.expires_at; }
    if (grant.kind === 'weekly') { credits.weekly = grant.remaining; credits.weeklyResetsAt = grant.expires_at; }
    if (grant.kind === 'purchase') credits.purchased += grant.remaining;
  }
  return credits;
}

export class CreditError extends Error {
  constructor(readonly code: 'insufficient_credits' | 'credit_operation_busy') {
    super(code === 'insufficient_credits' ? '星月积分不足，请充值后重试。' : '上一项 AI 任务仍在进行，请稍后重试。');
    this.name = 'CreditError';
  }
}

export interface CreditOperation { id: string; budget: number; startedAt: number }
export function openCreditOperation(db: Database.Database, userId: string, purpose: string, limit = Infinity, now = creditNow(), covered = false): CreditOperation {
  return db.transaction(() => {
    db.prepare('UPDATE compute_credit_operations SET ended_at=?,charged=0 WHERE user_id=? AND ended_at IS NULL AND started_at<?')
      .run(now, userId, now - 3600);
    if (db.prepare('SELECT 1 FROM compute_credit_operations WHERE user_id=? AND ended_at IS NULL').get(userId)) {
      throw new CreditError('credit_operation_busy');
    }
    const recent = db.prepare('SELECT COUNT(*) AS n FROM compute_credit_operations WHERE user_id=? AND started_at>=?').get(userId, now - 60) as { n: number };
    if (recent.n >= 12) throw new CreditError('credit_operation_busy');
    const budget = covered ? Math.min(limit, 5000) : Math.min(limit, creditBalance(db, userId, now).balance);
    if (!budget) throw new CreditError('insufficient_credits');
    const id = randomUUID();
    db.prepare('INSERT INTO compute_credit_operations(id,user_id,purpose,budget,started_at) VALUES (?,?,?,?,?)')
      .run(id, userId, purpose, budget, now);
    return { id, budget, startedAt: now };
  }).immediate();
}

export function finishCreditOperation(db: Database.Database, userId: string, operation: CreditOperation, points: number, now = creditNow()) {
  return db.transaction(() => {
    const { id, budget, startedAt } = operation;
    let left = Math.min(points, budget);
    const target = left;
    const current = db.prepare('SELECT 1 FROM compute_credit_operations WHERE id=? AND user_id=? AND ended_at IS NULL').get(id, userId);
    if (!current) return 0;
    for (const { remaining, ref } of activeGrants(db, userId, startedAt)) {
      if (!left) break;
      const charge = Math.min(left, remaining);
      db.prepare('UPDATE compute_credit_grants SET remaining=remaining-? WHERE user_id=? AND ref=?').run(charge, userId, ref);
      left -= charge;
    }
    const charged = target - left;
    db.prepare('UPDATE compute_credit_operations SET charged=?,ended_at=? WHERE id=?').run(charged, now, id);
    return charged;
  }).immediate();
}
