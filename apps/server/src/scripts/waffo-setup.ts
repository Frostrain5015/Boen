/**
 * waffo-setup.ts —— Waffo Pancake 接入自检与 Webhook 注册
 *
 * 用法:
 *   npx tsx src/scripts/waffo-setup.ts --check          # 只自检（凭据/店铺/商品/Webhook），不写任何东西
 *   npx tsx src/scripts/waffo-setup.ts --test           # 注册测试环境 Webhook（默认）
 *   npx tsx src/scripts/waffo-setup.ts --prod           # 注册生产环境 Webhook（需已过 KYB）
 *   npx tsx src/scripts/waffo-setup.ts --test --prod    # 两个环境都注册
 *   npx tsx src/scripts/waffo-setup.ts --url https://x/api/payment/webhook
 *
 * 幂等：同 URL + 同环境的 Webhook 已存在则跳过，可重复执行。
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { WaffoPancake, WaffoPancakeError } from '@waffo/pancake-ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(__dirname, '../../../../.env') });

const args = process.argv.slice(2);
const has = (name: string) => args.includes(`--${name}`);
function getArg(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

const MERCHANT_ID = process.env.WAFFO_MERCHANT_ID ?? '';
const PRIVATE_KEY = process.env.WAFFO_PRIVATE_KEY ?? '';
const STORE_ID = process.env.WAFFO_STORE_ID ?? '';
const WEB_ORIGIN = (process.env.WAFFO_WEB_ORIGIN ?? 'https://boen.frostrain.tech').replace(/\/$/, '');
const WEBHOOK_URL = getArg('url') ?? process.env.WAFFO_WEBHOOK_URL ?? `${WEB_ORIGIN}/api/payment/webhook`;

/** 全量订阅：发卡只用到其中 3 个，其余用于审计与后续退款/催缴能力 */
const EVENTS = [
  'order.completed',
  'subscription.activated',
  'subscription.payment_succeeded',
  'subscription.renewed',
  'subscription.recovered',
  'subscription.plan_changed',
  'subscription.plan_change_scheduled',
  'subscription.plan_change_failed',
  'subscription.canceling',
  'subscription.uncanceled',
  'subscription.canceled',
  'subscription.past_due',
  'refund.succeeded',
  'refund.failed',
] as const;

if (!MERCHANT_ID || !PRIVATE_KEY || !STORE_ID) {
  console.error('❌ .env 缺少 WAFFO_MERCHANT_ID / WAFFO_PRIVATE_KEY / WAFFO_STORE_ID');
  process.exit(1);
}

const client = new WaffoPancake({ merchantId: MERCHANT_ID, privateKey: PRIVATE_KEY });

function fail(err: unknown): never {
  if (err instanceof WaffoPancakeError) {
    console.error(`❌ WaffoPancakeError status=${err.status}`);
    for (const e of err.errors) console.error(`   [${e.layer}] ${e.message}`);
  } else {
    console.error('❌', err instanceof Error ? err.message : err);
  }
  process.exit(1);
}

async function check() {
  console.log(`\n  配置`);
  console.log(`  商户    ${MERCHANT_ID}`);
  console.log(`  店铺    ${STORE_ID}`);
  console.log(`  环境    ${process.env.WAFFO_ENVIRONMENT ?? 'test'}`);
  console.log(`  币种    ${process.env.WAFFO_CURRENCY ?? 'USD'}`);

  // 商品：确认配置的 productId 真实存在且未停用
  const configured = [
    { key: 'monthly', id: process.env.WAFFO_PRODUCT_MONTHLY ?? '' },
    { key: 'yearly', id: process.env.WAFFO_PRODUCT_YEARLY ?? '' },
  ].filter((p) => p.id);

  console.log(`\n  商品（已配置 ${configured.length} 档）`);
  for (const p of configured) {
    const r = await client.graphql.query<{
      subscriptionProduct: {
        id: string; name: string; billingPeriod: string; status: string;
        hasProdVersion: boolean; prices: Array<{ currency: string; priceInfo: { amount: string } }>;
      } | null;
    }>({
      query: `query ($id: String!) {
        subscriptionProduct(id: $id) {
          id name billingPeriod status hasProdVersion
          prices { currency priceInfo { amount } }
        }
      }`,
      variables: { id: p.id },
    });
    const prod = r.data?.subscriptionProduct;
    if (!prod) {
      console.log(`  ⚠️  ${p.key}  ${p.id}  查询不到（可能不属于该商户）`);
      continue;
    }
    const price = prod.prices.map((x) => `${x.currency} ${x.priceInfo.amount}`).join(' / ');
    console.log(`  ✓ ${p.key.padEnd(8)} ${prod.name}  ${prod.billingPeriod}  ${price}  status=${prod.status}  生产版本=${prod.hasProdVersion ? '有' : '无'}`);
    if (!prod.hasProdVersion) console.log(`      ↑ 尚无生产版本：线上收银台会失败，需先 publish()`);
  }

  // Webhook：列出已注册项
  const hookRes = await client.graphql.query<{
    // events 在 schema 里标成 String，实际返回的是字符串数组，两种都兜住
    storeWebhooks: Array<{ id: string; url: string; channel: string; events: string | string[]; testMode: boolean }>;
  }>({
    query: `query ($storeId: String!) { storeWebhooks(storeId: $storeId) { id url channel events testMode } }`,
    variables: { storeId: STORE_ID },
  });
  const hooks = hookRes.data?.storeWebhooks ?? [];
  console.log(`\n  Webhook（已注册 ${hooks.length} 条）`);
  if (!hooks.length) console.log('  （空）');
  for (const h of hooks) {
    const n = (() => {
      const e = h.events as unknown;
      if (Array.isArray(e)) return e.length;
      if (typeof e === 'string') {
        try { return (JSON.parse(e) as string[]).length; } catch { return e.split(',').filter(Boolean).length; }
      }
      return '?';
    })();
    console.log(`  ${h.testMode ? '[test]' : '[prod]'} ${h.channel}  ${h.url}  ${n} 个事件  id=${h.id}`);
  }

  console.log('\n  商户 KYB');
  const kyb = await client.graphql.query<{ kybTickets: Array<{ id: string; status: string }> }>({
    query: `query { kybTickets { id status } }`,
  });
  const tickets = kyb.data?.kybTickets ?? [];
  console.log(tickets.length ? `  ${tickets.map((t) => `${t.id}=${t.status}`).join(', ')}` : '  未提交 —— 生产环境不可用，仅能跑 test');
}

async function register(testMode: boolean) {
  const hookRes = await client.graphql.query<{
    storeWebhooks: Array<{ id: string; url: string; channel: string; testMode: boolean }>;
  }>({
    query: `query ($storeId: String!) { storeWebhooks(storeId: $storeId) { id url channel testMode } }`,
    variables: { storeId: STORE_ID },
  });
  const existing = (hookRes.data?.storeWebhooks ?? []).find(
    (h) => h.url === WEBHOOK_URL && h.channel === 'http' && h.testMode === testMode,
  );
  if (existing) {
    console.log(`  ⏭  ${testMode ? '[test]' : '[prod]'} 已存在，跳过  id=${existing.id}`);
    return;
  }
  const { webhook } = await client.webhooks.add({
    storeId: STORE_ID,
    channel: 'http',
    url: WEBHOOK_URL,
    events: [...EVENTS],
    testMode,
  });
  console.log(`  ✓  ${testMode ? '[test]' : '[prod]'} 已注册  id=${webhook.id}  → ${WEBHOOK_URL}`);
}

async function main() {
  try {
    await check();

    if (has('check')) {
      console.log('\n（--check 模式，未做任何写操作）');
      return;
    }

    const wantTest = has('test') || !has('prod'); // 默认注册测试环境
    const wantProd = has('prod');

    console.log(`\n  注册 Webhook → ${WEBHOOK_URL}`);
    if (wantTest) await register(true);
    if (wantProd) await register(false);

    console.log('\n✅ 完成。可在控制台 Products/Webhooks 核对，或用本脚本 --check 复查。');
  } catch (err) {
    fail(err);
  }
}

main();
