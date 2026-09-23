import { randomUUID } from 'node:crypto';
import { WaffoPancake, verifyWebhook, type WebhookEvent, type WebhookEventData } from '@waffo/pancake-ts';
import type { BillingStatus } from '@boen/shared';
import db from './db.js';
import { applySubscription, billingEnvironment, currentSubscription, membershipDetails, nowSeconds, trialEligible } from './membership.js';

// Lazy reads: ESM imports run before dotenv initialization.
function cfg() {
  return { merchantId: process.env.WAFFO_MERCHANT_ID ?? '', privateKey: process.env.WAFFO_PRIVATE_KEY ?? '',
    storeId: process.env.WAFFO_STORE_ID ?? '', productId: process.env.WAFFO_PRODUCT_MONTHLY ?? '',
    environment: billingEnvironment() as 'test' | 'prod' };
}
export function getClient(): WaffoPancake { return new WaffoPancake(cfg()); }
export function isWaffoEnabled(): boolean {
  const c = cfg();
  return Boolean(c.merchantId && c.privateKey && c.storeId && c.productId)
    && (c.environment === 'prod' || process.env.WAFFO_ALLOW_TEST_CHECKOUT === 'true');
}
export function listPurchasablePlans() { return cfg().productId ? [{ key: 'monthly', name: '星月卡', days: 30 }] : []; }
type Failure = { ok: false; error: string; message: string };
export type CheckoutResult = { ok: true; sessionId: string; checkoutUrl: string; expiresAt: string } | Failure;
interface Attempt { external_id: string; environment: string; session_id: string | null; checkout_url: string | null; expires_at: number; state: string; with_trial: number; created_at: number }
const checkoutInflight = new Map<string, Promise<CheckoutResult>>();

export async function createMembershipCheckout(opts: { userId: string; planKey: string; buyerEmail?: string; successUrl: string }): Promise<CheckoutResult> {
  const existing = checkoutInflight.get(opts.userId);
  if (existing) return existing;
  const promise = createCheckout(opts);
  checkoutInflight.set(opts.userId, promise);
  try { return await promise; } finally { checkoutInflight.delete(opts.userId); }
}
async function createCheckout(opts: { userId: string; planKey: string; buyerEmail?: string; successUrl: string }): Promise<CheckoutResult> {
  if (!isWaffoEnabled()) return { ok: false, error: 'unavailable', message: '订阅暂未开放，请稍后再来' };
  if (opts.planKey !== 'monthly') return { ok: false, error: 'invalid_plan', message: '该会员档位不可购买' };
  try { await reconcileMembership(opts.userId, true); }
  catch { return { ok: false, error: 'reconciliation_required', message: '暂时无法核实原有订单，请稍后重试，避免重复订阅' }; }
  if (!membershipDetails(db, opts.userId).billing.checkoutAllowed) return { ok: false, error: 'conflict', message: '你已有会员或订阅，请先管理现有权益' };
  const c = cfg();
  const now = nowSeconds();
  const attempt = db.transaction(() => {
    let row = db.prepare('SELECT * FROM payment_checkout_attempts WHERE user_id=?').get(opts.userId) as Attempt | undefined;
    if (row && (row.environment !== c.environment || (row.state === 'ready' && row.expires_at <= now))) {
      db.prepare('DELETE FROM payment_checkout_attempts WHERE user_id=?').run(opts.userId);
      row = undefined;
    }
    if (!row) {
      db.prepare(`INSERT INTO payment_checkout_attempts(user_id,external_id,environment,expires_at,state,with_trial)
        VALUES (?,?,?,?,'creating',?)`).run(opts.userId, randomUUID(), c.environment, now + 86400, trialEligible(db, opts.userId) ? 1 : 0);
      row = db.prepare('SELECT * FROM payment_checkout_attempts WHERE user_id=?').get(opts.userId) as Attempt;
    }
    db.prepare("INSERT OR IGNORE INTO payment_consents(external_id,user_id,terms_version) VALUES (?,?,'1.1')").run(row.external_id, opts.userId);
    return row;
  })();
  if (attempt.state === 'ready' && attempt.session_id && attempt.checkout_url) {
    return { ok: true, sessionId: attempt.session_id, checkoutUrl: attempt.checkout_url, expiresAt: new Date(attempt.expires_at * 1000).toISOString() };
  }
  if (attempt.created_at < now - 23 * 3600) return { ok: false, error: 'reconciliation_required', message: '上一笔支付尚待核实，请联系支持，避免重复订阅' };
  try {
    const result = await getClient().checkout.authenticated.create({
      productId: c.productId, currency: 'USD', buyerIdentity: opts.userId, buyerEmail: opts.buyerEmail,
      successUrl: opts.successUrl, language: 'zh-Hans', withTrial: Boolean(attempt.with_trial),
      orderMerchantExternalId: attempt.external_id, metadata: { userId: opts.userId, planKey: 'monthly' },
    }, { idempotencyKey: `boen-checkout-${attempt.external_id}` });
    db.transaction(() => {
      db.prepare(`INSERT OR IGNORE INTO payment_orders(session_id,user_id,plan_key,product_id,currency,external_id,checkout_url,buyer_email,status)
        VALUES (?,?,'monthly',?,'USD',?,?,?,'pending')`).run(result.sessionId, opts.userId, c.productId, attempt.external_id, result.checkoutUrl, opts.buyerEmail ?? null);
      db.prepare(`UPDATE payment_checkout_attempts SET session_id=?,checkout_url=?,expires_at=?,state='ready' WHERE user_id=? AND external_id=?`)
        .run(result.sessionId, result.checkoutUrl, dateSeconds(result.expiresAt), opts.userId, attempt.external_id);
    })();
    return { ok: true, sessionId: result.sessionId, checkoutUrl: result.checkoutUrl, expiresAt: result.expiresAt };
  } catch {
    // Retain the key on uncertain outcomes, including process restarts.
    return { ok: false, error: 'upstream', message: '支付服务暂时无法连接，请稍后重试同一笔申请' };
  }
}
function dateSeconds(value: string): number {
  const n = Date.parse(value);
  if (!Number.isFinite(n)) throw new Error('Missing or invalid subscription date');
  return Math.floor(n / 1000);
}
function statusValue(value: string): BillingStatus {
  if (value === 'closed' || value === 'expired') return 'canceled';
  if (['pending','trialing','active','canceling','past_due','canceled'].includes(value)) return value as BillingStatus;
  throw new Error('Unknown subscription status');
}
interface RemoteSubscription {
  id: string; status: string; currentPeriodStart: string | null; currentPeriodEnd: string | null;
  canceledAt: string | null; updatedAt: string; isInTrial: boolean; testMode: boolean; merchantProvidedBuyerIdentity: string; subscriptionProduct: { id: string };
}
async function remoteSubscription(orderId: string): Promise<RemoteSubscription> {
  const result = await getClient().graphql.query<{ subscriptionOrder: RemoteSubscription | null }>({
    query: `query ($id: ID!) { subscriptionOrder(id: $id) { id status isInTrial testMode merchantProvidedBuyerIdentity currentPeriodStart currentPeriodEnd canceledAt updatedAt subscriptionProduct { id } } }`,
    variables: { id: orderId },
  });
  const row = result.data?.subscriptionOrder;
  if (!row || row.id !== orderId || row.testMode !== (cfg().environment === 'test') || row.subscriptionProduct.id !== cfg().productId) throw new Error('Subscription unavailable or product/environment mismatch');
  return row;
}
const orderInflight = new Map<string, Promise<unknown>>();
async function serializeOrder<T>(orderId: string, action: () => Promise<T>): Promise<T> {
  const current = (orderInflight.get(orderId) ?? Promise.resolve()).catch(() => undefined).then(action);
  orderInflight.set(orderId, current);
  try { return await current; } finally { if (orderInflight.get(orderId) === current) orderInflight.delete(orderId); }
}
async function refreshOrder(userId: string, orderId: string, eventId: string): Promise<void> {
  const remote = await remoteSubscription(orderId);
  if (remote.merchantProvidedBuyerIdentity !== userId) throw new Error('Subscription owner mismatch');
  const prior = db.prepare('SELECT period_start,period_end FROM waffo_subscriptions WHERE order_id=? AND user_id=?').get(orderId, userId) as { period_start: number; period_end: number } | undefined;
  const status = remote.status === 'active' && remote.isInTrial ? 'trialing' : statusValue(remote.status);
  if (status === 'pending') return;
  const start = remote.currentPeriodStart ? dateSeconds(remote.currentPeriodStart) : prior?.period_start;
  let end = remote.currentPeriodEnd ? dateSeconds(remote.currentPeriodEnd) : prior?.period_end;
  // A failed renewal must never grant the newly attempted (unpaid) period.
  if (status === 'past_due') end = Math.min(end ?? nowSeconds(), prior?.period_end ?? start ?? nowSeconds());
  if (status === 'canceled' && remote.canceledAt) end = Math.min(end ?? nowSeconds(), dateSeconds(remote.canceledAt));
  if ((start == null || end == null) && status === 'canceled' && !prior) {
    db.prepare("UPDATE payment_orders SET status='canceled',updated_at=unixepoch() WHERE order_id=? AND user_id=?").run(orderId, userId);
    return;
  }
  if (start == null || end == null) throw new Error('Subscription has no authoritative billing period');
  const eventAt = Date.parse(remote.updatedAt);
  if (!Number.isFinite(eventAt)) throw new Error('Missing order version');
  const changed = applySubscription(db, { order_id: orderId, user_id: userId, environment: cfg().environment,
    status, period_start: start, period_end: end, canceled_at: remote.canceledAt ? dateSeconds(remote.canceledAt) : null,
    event_at: eventAt, event_id: eventId, trial_used: status === 'trialing' ? 1 : 0 });
  if (changed) {
    db.prepare('UPDATE payment_orders SET status=?,updated_at=unixepoch() WHERE order_id=? AND user_id=?').run(status, orderId, userId);
    db.prepare('DELETE FROM payment_checkout_attempts WHERE user_id=? AND session_id IN (SELECT session_id FROM payment_orders WHERE order_id=?)').run(userId, orderId);
  }
}
const lastReconciled = new Map<string, number>();
/** Repair missed webhooks and check old checkout outcomes before issuing another session. */
export async function reconcileMembership(userId: string, force = false): Promise<void> {
  if (!force && (lastReconciled.get(userId) ?? 0) > Date.now() - 60_000) return;
  if (!force && !db.prepare('SELECT 1 FROM payment_orders WHERE user_id=? LIMIT 1').get(userId)) return;
  if (!cfg().privateKey || !cfg().storeId) return;
  interface OrderIdentity { id: string; orderMerchantExternalId: string | null; merchantProvidedBuyerIdentity: string; status: string; testMode: boolean }
  for (let offset = 0; ; offset += 100) {
    const response = await getClient().graphql.query<{ subscriptionOrders: OrderIdentity[] }>({
      query: `query ($store: String!, $buyer: String!, $offset: Int!) { subscriptionOrders(storeId:$store,limit:100,offset:$offset,filter:{merchantProvidedBuyerIdentity:{eq:$buyer}}) { id orderMerchantExternalId merchantProvidedBuyerIdentity status testMode } }`,
      variables: { store: cfg().storeId, buyer: userId, offset },
    });
    const orders = response.data?.subscriptionOrders;
    if (!orders) throw new Error('Order reconciliation unavailable');
    for (const order of orders) {
      if (order.testMode !== (cfg().environment === 'test') || order.merchantProvidedBuyerIdentity !== userId) continue;
      const local = db.prepare('SELECT session_id FROM payment_orders WHERE user_id=? AND (order_id=? OR external_id=?)')
        .get(userId, order.id, order.orderMerchantExternalId ?? '') as { session_id: string } | undefined;
      if (!local) {
        if (!['canceled','closed','expired'].includes(order.status)) throw new Error('Unmatched existing subscription');
        continue;
      }
      db.prepare('UPDATE payment_orders SET order_id=? WHERE session_id=?').run(order.id, local.session_id);
      if (order.status !== 'pending') await serializeOrder(order.id, () => refreshOrder(userId, order.id, randomUUID()));
      else if (force && !db.prepare("SELECT 1 FROM payment_checkout_attempts WHERE user_id=? AND session_id=? AND state='ready' AND expires_at>?").get(userId, local.session_id, nowSeconds())) {
        throw new Error('An existing order is still pending');
      }
    }
    if (orders.length < 100) break;
  }
  if (lastReconciled.size > 1000) lastReconciled.clear();
  lastReconciled.set(userId, Date.now());
}
export interface WebhookHooks { invalidateSubscription: (userId: string) => void }
export interface WebhookOutcome { ok: boolean; reason?: string; detail?: Record<string, unknown> }
export async function handleWaffoWebhook(rawBody: string, signature: string | null, hooks: WebhookHooks): Promise<WebhookOutcome> {
  let event: WebhookEvent<WebhookEventData>;
  try { event = verifyWebhook<WebhookEventData>(rawBody, signature, { environment: cfg().environment }); }
  catch { return { ok: false, reason: 'invalid_signature' }; }
  if (event.storeId !== cfg().storeId || event.mode !== cfg().environment) return { ok: false, reason: 'invalid_signature' };
  return serializeOrder(event.data.orderId, async () => {
    try {
      const seen = db.prepare('SELECT status FROM waffo_webhook_events WHERE id=?').get(event.id) as { status: string } | undefined;
      if (seen?.status === 'processed') return { ok: true, reason: 'duplicate' };
      db.prepare(`INSERT OR IGNORE INTO waffo_webhook_events(id,event_type,event_id,mode,order_id,raw) VALUES (?,?,?,?,?,?)`)
        .run(event.id, event.eventType, event.eventId, event.mode, event.data.orderId, rawBody);
      if ((event.eventType.startsWith('subscription.') && event.eventType !== 'subscription.payment_succeeded') || event.eventType === 'refund.succeeded') {
        const data = event.data;
        const order = db.prepare(`SELECT user_id,session_id FROM payment_orders WHERE external_id=? OR order_id=? ORDER BY CASE WHEN external_id=? THEN 0 ELSE 1 END LIMIT 1`)
          .get(data.orderMerchantExternalId ?? '', data.orderId, data.orderMerchantExternalId ?? '') as { user_id: string; session_id: string } | undefined;
        if (!order) throw new Error('Unmatched order; retry after checkout persistence');
        if (data.merchantProvidedBuyerIdentity && data.merchantProvidedBuyerIdentity !== order.user_id) throw new Error('Buyer identity mismatch');
        db.prepare('UPDATE payment_orders SET order_id=? WHERE session_id=?').run(data.orderId, order.session_id);
        await refreshOrder(order.user_id, data.orderId, event.id);
        hooks.invalidateSubscription(order.user_id);
      }
      db.prepare("UPDATE waffo_webhook_events SET status='processed',note=NULL WHERE id=?").run(event.id);
      return { ok: true };
    } catch {
      db.prepare("UPDATE waffo_webhook_events SET status='failed',note='reconciliation_failed' WHERE id=?").run(event.id);
      return { ok: false, reason: 'handler_error' };
    }
  });
}
export async function manageSubscription(userId: string, action: 'cancel' | 'reactivate'): Promise<{ ok: true } | Failure> {
  const sub = currentSubscription(db, userId);
  if (!sub) return { ok: false, error: 'not_found', message: '没有可管理的订阅' };
  return serializeOrder(sub.order_id, async () => {
    try {
      await refreshOrder(userId, sub.order_id, randomUUID());
      const current = currentSubscription(db, userId)!;
      // An upstream timeout can hide a successful action. Resolve it from the
      // authoritative state before allowing the opposite operation.
      if (['canceling','canceled'].includes(current.status)) {
        db.prepare("UPDATE payment_actions SET state='complete' WHERE order_id=? AND action='cancel'").run(sub.order_id);
      } else if (['active','trialing'].includes(current.status)) {
        db.prepare("UPDATE payment_actions SET state='complete' WHERE order_id=? AND action='reactivate'").run(sub.order_id);
      }
      if (action === 'cancel' && ['canceling','canceled'].includes(current.status)) return { ok: true };
      if (action === 'reactivate' && ['active','trialing'].includes(current.status)) return { ok: true };
      if (!(action === 'cancel' ? ['active','trialing','past_due'].includes(current.status) : current.status === 'canceling')) {
        return { ok: false, error: 'conflict', message: '订阅状态已变化，请刷新后再试' };
      }
      const previous = db.prepare('SELECT action,request_key,state,updated_at FROM payment_actions WHERE order_id=?')
        .get(sub.order_id) as { action: string; request_key: string; state: string; updated_at: number } | undefined;
      if (previous?.state === 'pending' && previous.action !== action) return { ok: false, error: 'conflict', message: '上一项操作仍在确认中，请稍后刷新' };
      if (previous?.state === 'pending' && previous.updated_at < nowSeconds() - 23 * 3600) return { ok: false, error: 'reconciliation_required', message: '操作结果待核实，请联系支持' };
      const key = previous?.state === 'pending' ? previous.request_key : randomUUID();
      db.prepare(`INSERT INTO payment_actions(order_id,action,request_key,state) VALUES (?,?,?,'pending')
        ON CONFLICT(order_id) DO UPDATE SET action=excluded.action,request_key=excluded.request_key,state='pending',updated_at=unixepoch()`)
        .run(sub.order_id, action, key);
      const client = getClient();
      const { token } = await client.auth.issueSessionToken({ storeId: cfg().storeId, buyerIdentity: userId });
      const customer = client.customer(token);
      if (action === 'cancel') await customer.cancelSubscription({ orderId: sub.order_id }, { idempotencyKey: key });
      else await customer.reactivateSubscription({ orderId: sub.order_id }, { idempotencyKey: key });
      await refreshOrder(userId, sub.order_id, randomUUID());
      db.prepare("UPDATE payment_actions SET state='complete',updated_at=unixepoch() WHERE order_id=?").run(sub.order_id);
      return { ok: true };
    } catch { return { ok: false, error: 'upstream', message: '订阅操作尚未确认，请稍后重试或前往账单管理查看' }; }
  });
}
export function listPaymentOrders(userId: string, limit = 20) {
  return db.prepare(`SELECT session_id AS sessionId,plan_key AS planKey,status,amount,currency,created_at AS createdAt
    FROM payment_orders WHERE user_id=? ORDER BY created_at DESC LIMIT ?`).all(userId, limit);
}
