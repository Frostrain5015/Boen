import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addReward, applySubscription, initMembership, membershipDetails, type SubscriptionRow } from '../membership.js';

let db: Database.Database;
const now = 1_800_000_000;
const day = 86400;
function row(overrides: Partial<SubscriptionRow> = {}): SubscriptionRow {
  return { order_id: 'order', user_id: 'alice', environment: 'test', status: 'trialing',
    period_start: now, period_end: now + 7 * day, canceled_at: null,
    event_at: now * 1000, event_id: 'activated', trial_used: 1, ...overrides };
}
beforeEach(() => {
  process.env.WAFFO_ENVIRONMENT = 'test';
  db = new Database(':memory:');
  initMembership(db);
  db.exec(`CREATE TABLE subscriptions(user_id TEXT PRIMARY KEY,tier TEXT,expires_at INTEGER,activated_at INTEGER);
    CREATE TABLE payment_orders(user_id TEXT,order_id TEXT,status TEXT,environment TEXT DEFAULT 'test');`);
});
afterEach(() => db.close());
describe('membership lifecycle', () => {
  it('uses calendar period end, never adds a fixed thirty days on duplicate delivery', () => {
    applySubscription(db, row(), now);
    applySubscription(db, row({ event_id: 'duplicate' }), now);
    expect(membershipDetails(db, 'alice', now).membership.accessEndsAt).toBe(now + 7 * day);
    applySubscription(db, row({ status: 'active', period_start: now + 7 * day, period_end: now + 38 * day, event_at: (now + 7 * day) * 1000, event_id: 'renew' }), now + 7 * day);
    expect(membershipDetails(db, 'alice', now + 7 * day).membership.accessEndsAt).toBe(now + 38 * day);
  });
  it('preserves legacy yearly access and blocks duplicate purchase through expiry', () => {
    db.prepare('INSERT INTO subscriptions VALUES (?,?,?,?)').run('alice', 'yearly', now + day, now - day);
    expect(membershipDetails(db, 'alice', now).membership.legacyTier).toBe('yearly');
    expect(membershipDetails(db, 'alice', now).billing.checkoutAllowed).toBe(false);
    expect(membershipDetails(db, 'alice', now + day).billing.checkoutAllowed).toBe(true);
  });
  it('banks rewards during trial and resumes only on terminal cancellation', () => {
    applySubscription(db, row(), now);
    addReward(db, 'alice', 30 * day, 'points-1', now);
    applySubscription(db, row({ status: 'canceling', event_at: now * 1000 + 1, event_id: 'cancel' }), now);
    expect(membershipDetails(db, 'alice', now + 7 * day).rewards.bankedSeconds).toBe(30 * day);
    applySubscription(db, row({ status: 'canceled', event_at: (now + 7 * day) * 1000, event_id: 'ended' }), now + 7 * day);
    expect(membershipDetails(db, 'alice', now + 7 * day).membership).toMatchObject({ source: 'reward', accessEndsAt: now + 37 * day });
    expect(membershipDetails(db, 'alice', now + 7 * day).billing.trialEligible).toBe(false);
  });
  it('pauses remaining reward seconds without rounding loss', () => {
    addReward(db, 'alice', 30 * day, 'points', now);
    applySubscription(db, row({ period_start: now + 123 }), now + 123);
    expect(membershipDetails(db, 'alice', now + 123).rewards.bankedSeconds).toBe(30 * day - 123);
    applySubscription(db, row({ status: 'canceled', period_start: now + 123, event_at: (now + 7 * day) * 1000, event_id: 'ended' }), now + 7 * day);
    expect(membershipDetails(db, 'alice', now + 7 * day).membership.accessEndsAt).toBe(now + 37 * day - 123);
  });
  it('does not consume reward or extend access when payment is past due', () => {
    applySubscription(db, row({ status: 'past_due' }), now);
    addReward(db, 'alice', day, 'points', now);
    expect(membershipDetails(db, 'alice', now + 7 * day).membership.active).toBe(false);
    expect(membershipDetails(db, 'alice', now + 7 * day).rewards.bankedSeconds).toBe(day);
    applySubscription(db, row({ status: 'active', period_start: now + 7 * day, period_end: now + 37 * day, event_at: (now + 7 * day) * 1000, event_id: 'recover' }), now + 7 * day);
    expect(membershipDetails(db, 'alice', now + 7 * day).membership.source).toBe('waffo');
  });
  it('preserves seconds spent waiting for a delayed activation webhook', () => {
    addReward(db, 'alice', day, 'points', now);
    applySubscription(db, row({ period_start: now + 123 }), now + 600);
    expect(membershipDetails(db, 'alice', now + 600).rewards.bankedSeconds).toBe(day - 123);
  });
  it('rejects old cycles, older versions, ownership changes and resurrection', () => {
    applySubscription(db, row({ status: 'canceled', event_at: now * 1000 + 2 }), now);
    expect(applySubscription(db, row({ status: 'active', event_id: 'late', event_at: now * 1000 + 3 }), now)).toBe(false);
    expect(() => applySubscription(db, row({ user_id: 'bob', event_id: 'other' }), now)).toThrow('ownership');
  });
  it('deduplicates reward credits and keeps another user isolated', () => {
    addReward(db, 'alice', day, 'reward', now);
    addReward(db, 'alice', day, 'reward', now);
    expect(membershipDetails(db, 'alice', now).membership.accessEndsAt).toBe(now + day);
    expect(membershipDetails(db, 'bob', now).membership.active).toBe(false);
  });
  it('initialization is repeatable and does not reset existing data', () => {
    addReward(db, 'alice', day, 'reward', now);
    initMembership(db);
    expect(membershipDetails(db, 'alice', now).membership.accessEndsAt).toBe(now + day);
  });
  it('keeps sandbox trial/order history separate from first production trial', () => {
    applySubscription(db, row(), now);
    db.prepare('INSERT INTO payment_orders VALUES (?,?,?,?)').run('alice', 'order', 'active', 'test');
    process.env.WAFFO_ENVIRONMENT = 'prod';
    expect(membershipDetails(db, 'alice', now).billing.trialEligible).toBe(true);
    expect(membershipDetails(db, 'alice', now).membership.active).toBe(false);
    applySubscription(db, row({ order_id: 'production', environment: 'prod', plan_key: 'yearly', amount: '29.99', currency: 'USD' }), now);
    expect(membershipDetails(db, 'alice', now).billing).toMatchObject({ planKey: 'yearly', amount: '29.99', trialEligible: false });
  });
});
