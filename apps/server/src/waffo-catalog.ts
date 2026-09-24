import type { WaffoPancake } from '@waffo/pancake-ts';
import { MEMBERSHIP_PLANS } from '@boen/shared';

export function configuredPlans() {
  return MEMBERSHIP_PLANS.map(plan => ({ ...plan, productId: process.env[plan.key === 'monthly' ? 'WAFFO_PRODUCT_MONTHLY' : 'WAFFO_PRODUCT_YEARLY'] ?? '' }))
    .filter(plan => plan.productId);
}

interface Product {
  id: string; status: string; billingPeriod: string; hasProdVersion: boolean;
  metadata: string | Record<string, unknown>;
  prices: Array<{ currency: string; priceInfo: { amount: string; trialAmount: string | null } }>;
}

/** Fail closed if dashboard changes would charge differently from the website's consent. */
export async function verifyCatalog(client: WaffoPancake, environment: 'test' | 'prod'): Promise<void> {
  const response = await client.graphql.query<{
    store: { prodEnabled: boolean; payinEnable: boolean } | null; subscriptionProducts: Product[];
    storeWebhooks: Array<{ testMode: boolean; url: string }>;
  }>({ query: `query($store:String!) {
    store(id:$store){prodEnabled payinEnable}
    storeWebhooks(storeId:$store){testMode url}
    subscriptionProducts(storeId:$store,limit:100){id status billingPeriod hasProdVersion metadata prices{currency priceInfo{amount trialAmount}}}
  }`, variables: { store: process.env.WAFFO_STORE_ID ?? '' } });
  if (environment === 'prod' && (!response.data?.store?.prodEnabled || !response.data.store.payinEnable)) throw new Error('Production payments are not approved');
  // Merchant API calls are routed by the private key, not SDK environment.
  // Waffo filters this list to that key's environment: a sandbox key cannot pass.
  if (environment === 'prod' && !response.data?.storeWebhooks.some(hook => !hook.testMode && hook.url === `${process.env.WAFFO_WEB_ORIGIN?.replace(/\/$/, '')}/api/payment/webhook`)) {
    throw new Error('Production credential/webhook not verified');
  }
  const plans = configuredPlans();
  if (!plans.length) throw new Error('No configured membership products');
  for (const plan of plans) {
    const product = response.data?.subscriptionProducts.find(product => product.id === plan.productId);
    if (!product || product.status !== 'active' || product.billingPeriod !== plan.key || (environment === 'prod' && !product.hasProdVersion)) throw new Error(`Unavailable ${plan.key} product`);
    const price = product.prices.find(price => price.currency === plan.currency)?.priceInfo;
    const metadata: unknown = typeof product.metadata === 'string' ? JSON.parse(product.metadata) : product.metadata;
    if (!price || Number(price.amount) !== Number(plan.amount) || (price.trialAmount != null && Number(price.trialAmount) !== 0)
      || !metadata || typeof metadata !== 'object' || !('trialDays' in metadata) || metadata.trialDays !== plan.trialDays) {
      throw new Error(`Website and Waffo ${plan.key} pricing/trial mismatch`);
    }
  }
}
