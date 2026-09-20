/**
 * Waffo Pancake 支付接入（merchant-of-record）
 *
 * 定位：星月卡的「现金购卡」通道，与既有两条发卡路径并列 ——
 *   1) redeem.ts    —— 签名兑换码（线下/活动发放）
 *   2) currency.ts  —— 星月积分兑换（站内积分）
 *   3) waffo.ts     —— Waffo 订阅支付（本文件）
 * 三条路径最终都收敛到 redeem.ts 的 grantMembershipDays()，叠加续期语义天然一致。
 *
 * 关键约定（踩坑点，勿改）：
 *   - 私钥只存服务端 .env，绝不下发浏览器；本模块只在 Node 侧 import。
 *   - Webhook 必须以**原始文本**读 body 再验签，先 JSON.parse 会让签名校验失败。
 *   - 商品默认创建在测试环境，需 publish() 才有生产版本；生产环境还需 KYB 通过。
 *   - 金额一律用「展示金额字符串」（USD 传 "3.00"），不用分。
 *
 * 幂等设计（三层，缺一不可）：
 *   - waffo_webhook_events —— 按投递 ID(event.id) 去重，Waffo 重投同一事件不会重复处理。
 *   - membership_grants    —— 按「订单 × 计费周期」去重，避免 activated 与
 *                            payment_succeeded 同时到达时重复发卡。
 *   - payment_orders       —— 收银台会话流水，用于把 Webhook 反查回站内 user_id。
 */
import {
  WaffoPancake,
  WaffoPancakeError,
  WebhookEventType,
  verifyWebhook,
  type WebhookEvent,
  type WebhookEventData,
} from '@waffo/pancake-ts';
import db from './db.js';
import { grantMembershipDays } from './redeem.js';

/** 星月卡档位。productId 未配置的档位自动从可购列表中剔除。 */
export interface WaffoPlan {
  key: string;
  name: string;
  productId: string;
  /** 发卡天数，与兑换码/积分兑换保持同一语义 */
  days: number;
}

interface WaffoConfig {
  merchantId: string;
  privateKey: string;
  storeId: string;
  currency: string;
  /** 收银台语言（Waffo 用 IETF BCP 47，简体中文是 zh-Hans） */
  language: 'zh-Hans';
  environment: 'test' | 'prod';
  plans: WaffoPlan[];
}

/**
 * 配置惰性求值 —— 不能用模块顶层常量。
 *
 * index.ts 里 `import ... from './waffo.js'` 会被 ESM 提升到 `loadEnv()` 之前执行，
 * 顶层读 process.env 只会拿到空值（表现为接口恒返回 503「支付功能未启用」）。
 * 因此全部延后到首次调用时读取。
 */
let cached: WaffoConfig | null = null;

function cfg(): WaffoConfig {
  if (!cached) {
    const all: WaffoPlan[] = [
      { key: 'monthly', name: '皓月卡', productId: process.env.WAFFO_PRODUCT_MONTHLY ?? '', days: 30 },
      { key: 'yearly', name: '星耀卡', productId: process.env.WAFFO_PRODUCT_YEARLY ?? '', days: 365 },
    ];
    cached = {
      merchantId: process.env.WAFFO_MERCHANT_ID ?? '',
      privateKey: process.env.WAFFO_PRIVATE_KEY ?? '',
      storeId: process.env.WAFFO_STORE_ID ?? '',
      currency: process.env.WAFFO_CURRENCY ?? 'USD',
      language: (process.env.WAFFO_LANGUAGE ?? 'zh-Hans') as 'zh-Hans',
      environment: (process.env.WAFFO_ENVIRONMENT ?? 'test') as 'test' | 'prod',
      plans: all.filter((p) => p.productId),
    };
  }
  return cached;
}

export function getPlan(key: string): WaffoPlan | undefined {
  return cfg().plans.find((p) => p.key === key);
}

/** 支付通道是否可用（任一必需配置缺失则视为未接入，接口返回 503） */
export function isWaffoEnabled(): boolean {
  const c = cfg();
  return Boolean(c.merchantId && c.privateKey && c.storeId && c.plans.length);
}

/** 前端可展示的档位（不含 productId 等内部信息） */
export function listPurchasablePlans() {
  return cfg().plans.map((p) => ({ key: p.key, name: p.name, days: p.days }));
}

// ── 客户端（懒加载单例）──────────────────────────────────────
let client: WaffoPancake | null = null;

function getClient(): WaffoPancake {
  if (!client) {
    const c = cfg();
    client = new WaffoPancake({ merchantId: c.merchantId, privateKey: c.privateKey });
  }
  return client;
}

// ── 内部订单号 ───────────────────────────────────────────────
// 用 orderMerchantExternalId 作为站内订单与 Waffo 订单的关联键：它会被
// 订单/支付/退款三类事件原样带回，比 metadata 更可靠。
function newExternalId(): string {
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `BOEN-${Date.now().toString(36).toUpperCase()}-${rand}`;
}

// ── 收银台会话 ───────────────────────────────────────────────

export type CheckoutResult =
  | { ok: true; sessionId: string; checkoutUrl: string; expiresAt: string }
  | { ok: false; error: string; message: string };

/**
 * 为已登录用户创建订阅收银台会话。
 * 用 authenticated 模式：buyerIdentity 传站内 user_id，Waffo 会把它编进会话令牌，
 * 并在 Webhook 的 merchantProvidedBuyerIdentity 字段原样回传 —— 这是最可靠的
 * 「这笔钱属于谁」的凭据，metadata 与站内订单表只是冗余兜底。
 */
export async function createMembershipCheckout(opts: {
  userId: string;
  planKey: string;
  buyerEmail?: string;
  successUrl: string;
}): Promise<CheckoutResult> {
  if (!isWaffoEnabled()) {
    return { ok: false, error: 'unavailable', message: '支付功能未启用' };
  }
  const plan = getPlan(opts.planKey);
  if (!plan) return { ok: false, error: 'invalid_plan', message: '该会员档位不可购买' };

  const c = cfg();
  const externalId = newExternalId();
  try {
    const result = await getClient().checkout.authenticated.create({
      productId: plan.productId,
      currency: c.currency,
      buyerIdentity: opts.userId,
      buyerEmail: opts.buyerEmail,
      successUrl: opts.successUrl,
      language: c.language,
      // 业务侧订单号：会在 order/payment/refund 事件里原样回传
      orderMerchantExternalId: externalId,
      metadata: { userId: opts.userId, planKey: plan.key, externalId },
    });

    db.prepare(`
      INSERT INTO payment_orders
        (session_id, user_id, plan_key, product_id, currency, external_id, checkout_url, buyer_email, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')
    `).run(
      result.sessionId, opts.userId, plan.key, plan.productId,
      c.currency, externalId, result.checkoutUrl, opts.buyerEmail ?? null,
    );

    return {
      ok: true,
      sessionId: result.sessionId,
      checkoutUrl: result.checkoutUrl,
      expiresAt: result.expiresAt,
    };
  } catch (err) {
    const { error, message } = describeError(err);
    console.error('[waffo] createCheckout failed:', error, message);
    return { ok: false, error, message };
  }
}

function describeError(err: unknown): { error: string; message: string } {
  if (err instanceof WaffoPancakeError) {
    const root = err.errors?.[0];
    if (err.status === 401) return { error: 'auth_failed', message: '支付通道鉴权失败，请联系管理员' };
    if (err.status === 403) return { error: 'forbidden', message: '支付通道未完成开通（KYB 审核中）' };
    if (err.status === 429) return { error: 'rate_limited', message: '请求过于频繁，请稍后再试' };
    return { error: `upstream_${err.status}`, message: root?.message ?? '支付通道返回错误' };
  }
  return { error: 'network', message: '无法连接支付通道，请稍后再试' };
}

// ── 发卡 ─────────────────────────────────────────────────────

/**
 * 幂等发卡：同一 (订单 × 计费周期) 只发一次。
 * Waffo 对首期支付会同时投 activated 与 payment_succeeded，续费投 renewed，
 * 扣款失败重试成功投 recovered —— 用 periodNumber 归并，可天然去重。
 */
function applyGrant(opts: {
  grantKey: string;
  userId: string;
  days: number;
  orderId: string;
}): { granted: boolean; until: number } {
  return db.transaction((): { granted: boolean; until: number } => {
    const existing = db.prepare(`SELECT until FROM membership_grants WHERE grant_key=?`).get(opts.grantKey) as
      | { until: number }
      | undefined;
    if (existing) return { granted: false, until: existing.until };

    const { until } = grantMembershipDays(opts.userId, opts.days);
    db.prepare(`
      INSERT INTO membership_grants (grant_key, user_id, days, source, order_id, until)
      VALUES (?, ?, ?, 'waffo', ?, ?)
    `).run(opts.grantKey, opts.userId, opts.days, opts.orderId, until);
    return { granted: true, until };
  })();
}

/** 会触发发卡的事件。payment_succeeded 刻意不在列：它是纯支付事件，
 *  与 activated/renewed 描述同一笔钱，靠 grantKey 归并反而更绕，直接不订阅更清晰。 */
const GRANTING_EVENTS = new Set<string>([
  WebhookEventType.SubscriptionActivated,
  WebhookEventType.SubscriptionRenewed,
  WebhookEventType.SubscriptionRecovered,
]);

// ── Webhook ──────────────────────────────────────────────────

export interface WebhookHooks {
  /** 发卡后失效订阅缓存，让下一次 /api/subscription/status 立刻读到新状态 */
  invalidateSubscription: (userId: string) => void;
}

export interface WebhookOutcome {
  /** 是否已被成功接收（true 即回 200，让 Waffo 停止重投） */
  ok: boolean;
  /** 校验失败等情况下的原因，仅用于日志 */
  reason?: string;
  detail?: Record<string, unknown>;
}

/**
 * 校验并处理 Waffo Webhook。**必须传入未解析的原始请求体**。
 * 恒返回 200（除验签失败）：发卡失败由 Waffo 重投兜底，业务异常不应触发重投风暴。
 */
export function handleWaffoWebhook(
  rawBody: string,
  signature: string | null,
  hooks: WebhookHooks,
): WebhookOutcome {
  let event: WebhookEvent<WebhookEventData>;
  try {
    event = verifyWebhook<WebhookEventData>(rawBody, signature, { environment: cfg().environment });
  } catch (err) {
    console.warn('[waffo] webhook 验签失败:', err instanceof Error ? err.message : err);
    return { ok: false, reason: 'invalid_signature' };
  }

  // 第一层幂等：同一投递 ID 只处理一次
  const seen = db.prepare(`SELECT status FROM waffo_webhook_events WHERE id=?`).get(event.id) as
    | { status: string }
    | undefined;
  if (seen?.status === 'processed') {
    return { ok: true, reason: 'duplicate', detail: { eventId: event.id } };
  }
  if (!seen) {
    db.prepare(`
      INSERT INTO waffo_webhook_events (id, event_type, event_id, mode, order_id, raw)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(event.id, event.eventType, event.eventId ?? null, event.mode ?? null, event.data?.orderId ?? null, rawBody);
  }

  try {
    const detail = processEvent(event, hooks);
    db.prepare(`UPDATE waffo_webhook_events SET status='processed', note=? WHERE id=?`)
      .run(JSON.stringify(detail), event.id);
    return { ok: true, detail };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    db.prepare(`UPDATE waffo_webhook_events SET status='failed', note=? WHERE id=?`).run(msg, event.id);
    console.error('[waffo] webhook 处理失败:', event.eventType, msg);
    // 仍回 200：重投也修不好，靠人工排查
    return { ok: true, reason: 'handler_error' };
  }
}

function processEvent(event: WebhookEvent<WebhookEventData>, hooks: WebhookHooks): Record<string, unknown> {
  const data = event.data ?? ({} as WebhookEventData);
  const orderId = data.orderId ?? '';

  // 反查站内用户：身份字段 > 站内订单表（按业务订单号 / Waffo 订单号 / 邮箱）
  const resolved = resolveUser(data, orderId);

  // 会话流水回填终态
  if (orderId && resolved?.sessionId) {
    db.prepare(`UPDATE payment_orders SET order_id=?, status=?, amount=?, updated_at=unixepoch() WHERE session_id=?`)
      .run(orderId, orderStatusFor(event.eventType), data.amount ?? null, resolved.sessionId);
  }

  if (!resolved?.userId) {
    // 退款/取消等非发卡事件可能对不上人，记下来即可
    return { matched: false, eventType: event.eventType, orderId };
  }

  const out: Record<string, unknown> = { matched: true, userId: resolved.userId, eventType: event.eventType };

  if (GRANTING_EVENTS.has(event.eventType)) {
    const plan = planForOrder(resolved.sessionId) ?? cfg().plans[0];
    if (!plan) {
      // 档位配置被清空（商品 ID 从 .env 移除）时不能瞎猜天数
      out.granted = false;
      out.skipped = 'no_plan_configured';
    } else {
      // 计费周期归并：同一订单同一周期只发一次卡
      const cycle = typeof data.periodNumber === 'number' ? String(data.periodNumber) : '1';
      const grantKey = `${orderId}:${cycle}`;
      const { granted, until } = applyGrant({
        grantKey,
        userId: resolved.userId,
        days: plan.days,
        orderId,
      });
      out.granted = granted;
      out.until = until;
      out.cycle = cycle;
      if (granted) hooks.invalidateSubscription(resolved.userId);
    }
  }

  // 订阅终止：不动 expires_at —— 用户已付的周期自然走完，到期即失效
  if (event.eventType === WebhookEventType.SubscriptionCanceled && resolved.sessionId) {
    db.prepare(`UPDATE payment_orders SET status='canceled', updated_at=unixepoch() WHERE session_id=?`)
      .run(resolved.sessionId);
  }

  return out;
}

interface ResolvedUser {
  userId: string | null;
  sessionId: string | null;
}

type OrderRow = { session_id: string; user_id: string };

/**
 * 反查「这笔钱属于站内哪个用户、哪次下单」。
 *
 * 匹配优先级刻意让**订单号类标识排在身份类之前**：首期回调到达时，
 * payment_orders.order_id 还是空的（要等这次回调才回填），但 external_id 在下单时
 * 就已落库，所以 external_id 是首次回调唯一能精确命中的键；若先按身份匹配，
 * 只会拿到「该用户最近一单」，续费叠加到错误订单上。
 */
function resolveUser(data: WebhookEventData, orderId: string): ResolvedUser {
  const externalId = data.orderMerchantExternalId;
  const identity = data.merchantProvidedBuyerIdentity ?? data.orderMetadata?.userId;

  // 1) 业务订单号（下单时落库，最精确）
  if (externalId) {
    const row = db.prepare(`SELECT session_id, user_id FROM payment_orders WHERE external_id=?`).get(externalId) as OrderRow | undefined;
    if (row) return { userId: row.user_id, sessionId: row.session_id };
  }
  // 2) Waffo 订单号（首次回调后已回填，续费/退款事件走这里）
  if (orderId) {
    const row = db.prepare(`SELECT session_id, user_id FROM payment_orders WHERE order_id=?`).get(orderId) as OrderRow | undefined;
    if (row) return { userId: row.user_id, sessionId: row.session_id };
  }
  // 3) 买家身份（认证收银台写入）—— 兜底，取该用户最近一单
  if (identity) {
    const row = db.prepare(`SELECT session_id, user_id FROM payment_orders WHERE user_id=? ORDER BY created_at DESC LIMIT 1`).get(identity) as OrderRow | undefined;
    return { userId: identity, sessionId: row?.session_id ?? null };
  }
  // 4) 邮箱 —— 最后的兜底（用户可能在收银台改过邮箱，命中率不高但聊胜于无）
  if (data.buyerEmail) {
    const row = db.prepare(`SELECT session_id, user_id FROM payment_orders WHERE buyer_email=? ORDER BY created_at DESC LIMIT 1`).get(data.buyerEmail) as OrderRow | undefined;
    if (row) return { userId: row.user_id, sessionId: row.session_id };
  }
  return { userId: null, sessionId: null };
}

function planForOrder(sessionId: string | null): WaffoPlan | undefined {
  if (!sessionId) return undefined;
  const row = db.prepare(`SELECT plan_key FROM payment_orders WHERE session_id=?`).get(sessionId) as
    | { plan_key: string }
    | undefined;
  return row ? getPlan(row.plan_key) : undefined;
}

function orderStatusFor(eventType: string): string {
  switch (eventType) {
    case WebhookEventType.SubscriptionActivated:
    case WebhookEventType.SubscriptionRenewed:
    case WebhookEventType.SubscriptionRecovered:
      return 'active';
    case WebhookEventType.SubscriptionCanceled:
      return 'canceled';
    case WebhookEventType.SubscriptionPastDue:
      return 'past_due';
    default:
      return 'active';
  }
}

// ── 订单查询（前端轮询用）───────────────────────────────────

export interface PaymentOrderRow {
  sessionId: string;
  planKey: string;
  status: string;
  amount: string | null;
  currency: string;
  createdAt: number;
}

export function listPaymentOrders(userId: string, limit = 20): PaymentOrderRow[] {
  const rows = db.prepare(`
    SELECT session_id, plan_key, status, amount, currency, created_at
    FROM payment_orders WHERE user_id=? ORDER BY created_at DESC LIMIT ?
  `).all(userId, limit) as Array<{
    session_id: string; plan_key: string; status: string;
    amount: string | null; currency: string; created_at: number;
  }>;
  return rows.map((r) => ({
    sessionId: r.session_id,
    planKey: r.plan_key,
    status: r.status,
    amount: r.amount,
    currency: r.currency,
    createdAt: r.created_at,
  }));
}
