import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { BillingPeriod, TaxCategory, WaffoPancake } from '@waffo/pancake-ts';
import { creditTopUpAmount, CREDIT_TOP_UP, MEMBERSHIP_PLANS } from '@boen/shared';

config({ path: fileURLToPath(new URL('../../../../.env', import.meta.url)), quiet: true });
const { WAFFO_MERCHANT_ID: merchantId, WAFFO_PRIVATE_KEY: privateKey, WAFFO_STORE_ID: storeId } = process.env;
if (!merchantId || !privateKey || !storeId) throw new Error('Waffo 商户未配置');
const environment = process.env.WAFFO_ENVIRONMENT === 'prod' ? 'prod' : 'test';
const publish = process.argv.includes('--publish');
if (publish && environment !== 'prod') throw new Error('发布需要生产商户配置');
const client = new WaffoPancake({ merchantId, privateKey, environment });

interface Product {
  id: string;
  name: string;
  billingPeriod?: string;
  status: string;
  hasProdVersion: boolean;
  prices: Array<{ currency: string; priceInfo: { amount: string } }>;
}
const catalog = await client.graphql.query<{
  subscriptionProducts: Product[];
  onetimeProducts: Product[];
}>({
  query: `query ($store: String!) {
    subscriptionProducts(storeId:$store,limit:100) { id name billingPeriod status hasProdVersion prices{currency priceInfo{amount}} }
    onetimeProducts(storeId:$store,limit:100) { id name status hasProdVersion prices{currency priceInfo{amount}} }
  }`,
  variables: { store: storeId },
});
if (catalog.errors?.length || !catalog.data) throw new Error('无法读取 Waffo 商品列表');

function existing(products: Product[], name: string, amount: string, recurring: boolean) {
  const found = products.filter(product => product.name === name);
  if (found.length > 1) throw new Error(`存在重复商品：${name}`);
  const product = found[0];
  if (product && (product.status !== 'active' || (recurring && product.billingPeriod !== 'monthly')
    || !product.prices.some(price => price.currency === 'USD' && Number(price.priceInfo.amount) === Number(amount)))) {
    throw new Error(`商品价格、周期或状态不符：${name}`);
  }
  return product;
}

const bindings: Record<string, string> = {};
for (const plan of MEMBERSHIP_PLANS) {
  const name = `博文 ${plan.name} · 连续月订阅`;
  const product = existing(catalog.data.subscriptionProducts, name, plan.amount, true);
  const id = product?.id ?? (await client.subscriptionProducts.create({
    storeId, name, billingPeriod: BillingPeriod.Monthly,
    description: `博文 AI 学习助手会员，每周发放 ${plan.weeklyPoints} 星月积分。`,
    prices: { USD: { amount: plan.amount, taxCategory: TaxCategory.SaaS } },
    metadata: { sku: `boen-compute-${plan.key}` },
  }, { idempotencyKey: `boen-compute-v2-${plan.key}` })).product.id;
  if (publish && !product?.hasProdVersion) await client.subscriptionProducts.publish({ id }, { idempotencyKey: `boen-compute-v2-publish-${plan.key}` });
  bindings[`WAFFO_PRODUCT_${plan.key.toUpperCase()}`] = id;
}

const topUpName = '博文 AI 算力包 · 一次性购买';
const topUpAmount = creditTopUpAmount(CREDIT_TOP_UP.minimum)!;
const topUp = existing(catalog.data.onetimeProducts, topUpName, topUpAmount, false);
const topUpId = topUp?.id ?? (await client.onetimeProducts.create({
  storeId, name: topUpName,
  description: '为购买账号增加博文 AI 功能用量，供对话、拍照问答及组卷使用。',
  prices: { USD: { amount: topUpAmount, taxCategory: TaxCategory.SaaS } },
  metadata: { sku: 'boen-compute-topup' },
}, { idempotencyKey: 'boen-compute-v2-topup' })).product.id;
if (publish && !topUp?.hasProdVersion) await client.onetimeProducts.publish({ id: topUpId }, { idempotencyKey: 'boen-compute-v2-publish-topup' });
bindings.WAFFO_PRODUCT_TOPUP = topUpId;
for (const [key, value] of Object.entries(bindings)) console.log(`${key}=${value}`);
