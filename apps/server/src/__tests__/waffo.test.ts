import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ query: vi.fn(), checkout: vi.fn(), cancel: vi.fn(), reactivate: vi.fn(), session: vi.fn() }));
vi.mock('../db.js', async () => {
  const { default: SQLite } = await import('better-sqlite3');
  return { default: new SQLite(':memory:') };
});
vi.mock('@waffo/pancake-ts', () => ({
  WaffoPancake: class {
    graphql = { query: mocks.query };
    checkout = { authenticated: { create: mocks.checkout } };
    auth = { issueSessionToken: mocks.session };
    customer() { return { cancelSubscription: mocks.cancel, reactivateSubscription: mocks.reactivate }; }
  },
  verifyWebhook: (raw: string, signature: string) => { if (signature !== 'valid') throw new Error('invalid'); return JSON.parse(raw) as unknown; },
}));
import db from '../db.js';
import { initMembership, membershipDetails } from '../membership.js';
import { MEMBERSHIP_PLANS } from '@boen/shared';
import { createMembershipCheckout, handleWaffoWebhook, manageSubscription } from '../waffo.js';
const now = Math.floor(Date.now() / 1000);
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
let remote: { id: string; status: string; isInTrial: boolean; testMode: boolean; merchantProvidedBuyerIdentity: string; currentPeriodStart: string; currentPeriodEnd: string; canceledAt: string | null; updatedAt: string; subscriptionProduct: { id: string }; billingPeriod: string; currency: string; priceSnapshot: { regularPhase: { subtotal: string } } };
const products = () => MEMBERSHIP_PLANS.map(plan => ({ id: plan.key === 'monthly' ? 'product' : 'year-product', status: 'active', billingPeriod: plan.key, hasProdVersion: true, metadata: '{"trialDays":7}', prices: [{ currency: 'USD', priceInfo: { amount: String(plan.amount), trialAmount: null } }] }));
function event(id = 'event-1', type = 'subscription.activated', extra: Record<string, unknown> = {}) {
  return JSON.stringify({ id, timestamp: iso(now), eventId: id, eventType: type, storeId: 'store', mode: 'test',
    data: { orderId: 'order', orderMerchantExternalId: 'external', merchantProvidedBuyerIdentity: 'alice', ...extra } });
}
const hooks = { invalidateSubscription: vi.fn() };
beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(process.env, { WAFFO_MERCHANT_ID: 'merchant', WAFFO_PRIVATE_KEY: 'key', WAFFO_STORE_ID: 'store', WAFFO_PRODUCT_MONTHLY: 'product', WAFFO_PRODUCT_YEARLY: 'year-product', WAFFO_ENVIRONMENT: 'test', WAFFO_ALLOW_TEST_CHECKOUT: 'true' });
  db.exec(`PRAGMA foreign_keys=OFF;`);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>;
  for (const { name } of tables) db.exec(`DROP TABLE "${name}"`);
  initMembership(db);
  db.exec(`CREATE TABLE subscriptions(user_id TEXT PRIMARY KEY,tier TEXT,expires_at INTEGER,activated_at INTEGER);
    CREATE TABLE payment_orders(session_id TEXT PRIMARY KEY,user_id TEXT,plan_key TEXT,product_id TEXT,currency TEXT,external_id TEXT UNIQUE,order_id TEXT,checkout_url TEXT,buyer_email TEXT,status TEXT,amount TEXT,created_at INTEGER DEFAULT(unixepoch()),updated_at INTEGER,environment TEXT DEFAULT 'test');
    CREATE TABLE waffo_webhook_events(id TEXT PRIMARY KEY,event_type TEXT,event_id TEXT,mode TEXT,order_id TEXT,raw TEXT,status TEXT DEFAULT 'received',note TEXT);
    INSERT INTO payment_orders(session_id,user_id,external_id,status) VALUES ('session','alice','external','pending');`);
  remote = { id: 'order', status: 'active', isInTrial: true, testMode: true, merchantProvidedBuyerIdentity: 'alice', currentPeriodStart: iso(now), currentPeriodEnd: iso(now + 7 * 86400), canceledAt: null, updatedAt: iso(now), subscriptionProduct: { id: 'product' }, billingPeriod: 'monthly', currency: 'USD', priceSnapshot: { regularPhase: { subtotal: '2.99' } } };
  mocks.query.mockImplementation(async () => ({ data: { subscriptionOrder: remote, subscriptionOrders: [], store: { prodEnabled: true, payinEnable: true }, subscriptionProducts: products() } }));
  mocks.session.mockResolvedValue({ token: 'scoped-token' });
});
describe('Waffo integration', () => {
  it('creates yearly checkout and rejects switching a pending checkout to another plan', async () => {
    mocks.checkout.mockResolvedValue({ sessionId: 'year-session', checkoutUrl: 'https://checkout.waffo.ai/example', expiresAt: iso(now + 3600) });
    const opts = { userId: 'bob', planKey: 'yearly', successUrl: 'https://boen.frostrain.tech/setup?paid=1' };
    expect((await createMembershipCheckout(opts)).ok).toBe(true);
    expect(mocks.checkout).toHaveBeenCalledWith(expect.objectContaining({ productId: 'year-product', withTrial: true, metadata: { userId: 'bob', planKey: 'yearly' } }), expect.any(Object));
    expect((await createMembershipCheckout({ ...opts, planKey: 'monthly' })).ok).toBe(false);
    expect(mocks.checkout).toHaveBeenCalledTimes(1);
  });
  it('uses the yearly period and authoritative recurring amount', async () => {
    remote = { ...remote, billingPeriod: 'yearly', subscriptionProduct: { id: 'year-product' }, isInTrial: false, currentPeriodEnd: iso(now + 366 * 86400), priceSnapshot: { regularPhase: { subtotal: '29.99' } } };
    expect((await handleWaffoWebhook(event(), 'valid', hooks)).ok).toBe(true);
    expect(membershipDetails(db, 'alice').billing).toMatchObject({ planKey: 'yearly', amount: '29.99', currentPeriodEnd: now + 366 * 86400 });
  });
  it('refuses checkout if dashboard price differs from the published website', async () => {
    const changed = products(); changed[0]!.prices[0]!.priceInfo.amount = '99.99';
    mocks.query.mockResolvedValueOnce({ data: { subscriptionProducts: changed, store: { prodEnabled: true, payinEnable: true } } });
    expect((await createMembershipCheckout({ userId: 'bob', planKey: 'monthly', successUrl: 'https://boen.frostrain.tech' })).ok).toBe(false);
    expect(mocks.checkout).not.toHaveBeenCalled();
  });
  it('verifies signature and store/environment before processing', async () => {
    expect((await handleWaffoWebhook(event(), 'invalid', hooks)).reason).toBe('invalid_signature');
    expect((await handleWaffoWebhook(event().replace('"mode":"test"', '"mode":"prod"'), 'valid', hooks)).ok).toBe(false);
    expect(mocks.query).not.toHaveBeenCalled();
  });
  it('recognizes Waffo active + isInTrial, and deduplicates a delivery', async () => {
    expect((await handleWaffoWebhook(event(), 'valid', hooks)).ok).toBe(true);
    expect(membershipDetails(db, 'alice').billing.status).toBe('trialing');
    expect((await handleWaffoWebhook(event(), 'valid', hooks)).reason).toBe('duplicate');
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });
  it('returns failure for retry and processes the same delivery after recovery', async () => {
    mocks.query.mockRejectedValueOnce(new Error('network'));
    expect((await handleWaffoWebhook(event(), 'valid', hooks)).reason).toBe('handler_error');
    expect((await handleWaffoWebhook(event(), 'valid', hooks)).ok).toBe(true);
    expect(membershipDetails(db, 'alice').membership.active).toBe(true);
  });
  it('rejects unmatched users and does not fall back to email or latest user order', async () => {
    expect((await handleWaffoWebhook(event('bad', 'subscription.activated', { merchantProvidedBuyerIdentity: 'bob' }), 'valid', hooks)).ok).toBe(false);
    expect(membershipDetails(db, 'bob').membership.active).toBe(false);
  });
  it('reads current status for an old notification, and reconciles refunds without guessing from amounts', async () => {
    await handleWaffoWebhook(event(), 'valid', hooks);
    remote = { ...remote, status: 'canceling', updatedAt: iso(now + 1) };
    await handleWaffoWebhook(event('late', 'subscription.activated'), 'valid', hooks);
    expect(membershipDetails(db, 'alice').billing.status).toBe('canceling');
    await handleWaffoWebhook(event('partial', 'refund.succeeded', { amount: '1.00' }), 'valid', hooks);
    expect(membershipDetails(db, 'alice').membership.active).toBe(true);
    remote = { ...remote, status: 'canceled', canceledAt: iso(now), updatedAt: iso(now + 2) };
    await handleWaffoWebhook(event('refund', 'refund.succeeded'), 'valid', hooks);
    expect(membershipDetails(db, 'alice').membership.active).toBe(false);
  });
  it('does not use pure payment events to grant membership', async () => {
    await handleWaffoWebhook(event('charge', 'subscription.payment_succeeded'), 'valid', hooks);
    expect(membershipDetails(db, 'alice').membership.active).toBe(false);
    expect(mocks.query).not.toHaveBeenCalled();
  });
  it('does not grant the attempted period when renewal payment fails', async () => {
    await handleWaffoWebhook(event(), 'valid', hooks);
    remote = { ...remote, status: 'past_due', isInTrial: false, currentPeriodStart: iso(now + 7 * 86400), currentPeriodEnd: iso(now + 37 * 86400), updatedAt: iso(now + 7 * 86400) };
    await handleWaffoWebhook(event('failed', 'subscription.payment_failed'), 'valid', hooks);
    expect(membershipDetails(db, 'alice', now + 7 * 86400).membership.active).toBe(false);
  });
  it('reconciles an ambiguous successful cancellation before reactivation', async () => {
    await handleWaffoWebhook(event(), 'valid', hooks);
    mocks.cancel.mockImplementationOnce(async () => {
      remote = { ...remote, status: 'canceling', updatedAt: iso(now + 1) };
      throw new Error('response lost');
    });
    expect((await manageSubscription('alice', 'cancel')).ok).toBe(false);
    mocks.reactivate.mockImplementationOnce(async () => { remote = { ...remote, status: 'active', updatedAt: iso(now + 2) }; });
    expect((await manageSubscription('alice', 'reactivate')).ok).toBe(true);
  });
  it('scopes cancel/reactivate to the signed-in owner and reuses uncertain operation keys', async () => {
    await handleWaffoWebhook(event(), 'valid', hooks);
    expect((await manageSubscription('bob', 'cancel')).ok).toBe(false);
    mocks.cancel.mockRejectedValueOnce(new Error('timeout')).mockImplementationOnce(async () => { remote = { ...remote, status: 'canceling', updatedAt: iso(now + 1) }; });
    expect((await manageSubscription('alice', 'cancel')).ok).toBe(false);
    expect((await manageSubscription('alice', 'cancel')).ok).toBe(true);
    expect(mocks.cancel.mock.calls[0]?.[1]).toEqual(mocks.cancel.mock.calls[1]?.[1]);
    expect(mocks.session).toHaveBeenCalledWith({ storeId: 'store', buyerIdentity: 'alice' });
    mocks.reactivate.mockImplementationOnce(async () => { remote = { ...remote, status: 'active', updatedAt: iso(now + 2) }; });
    expect((await manageSubscription('alice', 'reactivate')).ok).toBe(true);
    expect(membershipDetails(db, 'alice').billing.status).toBe('trialing');
  });
  it('coalesces concurrent checkout and persists idempotency across failed requests', async () => {
    mocks.checkout.mockRejectedValueOnce(new Error('timeout')).mockResolvedValue({ sessionId: 'new-session', checkoutUrl: 'https://checkout.waffo.ai/example', expiresAt: iso(now + 3600) });
    const opts = { userId: 'bob', planKey: 'monthly', successUrl: 'https://boen.frostrain.tech/setup?paid=1' };
    const first = await Promise.all([createMembershipCheckout(opts), createMembershipCheckout(opts)]);
    expect(first.every(result => !result.ok)).toBe(true);
    expect(mocks.checkout).toHaveBeenCalledTimes(1);
    expect((await createMembershipCheckout(opts)).ok).toBe(true);
    expect(mocks.checkout.mock.calls[0]?.[1]).toEqual(mocks.checkout.mock.calls[1]?.[1]);
    expect(mocks.checkout.mock.calls[1]?.[0]).toMatchObject({ withTrial: true });
    await createMembershipCheckout(opts);
    expect(mocks.checkout).toHaveBeenCalledTimes(2);
  });
});
