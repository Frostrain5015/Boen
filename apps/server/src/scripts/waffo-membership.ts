import { config } from 'dotenv';
import { WaffoPancake } from '@waffo/pancake-ts';
import { fileURLToPath } from 'node:url';
config({ path: fileURLToPath(new URL('../../../../.env', import.meta.url)), quiet: true });
const client = new WaffoPancake({ merchantId: process.env.WAFFO_MERCHANT_ID ?? '', privateKey: process.env.WAFFO_PRIVATE_KEY ?? '', environment: process.env.WAFFO_ENVIRONMENT === 'prod' ? 'prod' : 'test' });
interface Product { id: string; metadata: string | Record<string, unknown>; description: string; hasProdVersion: boolean; prices: Array<{ currency: string; priceInfo: { amount: string; taxCategory: string; trialAmount: string | null } }> }
async function main() {
  const productId = process.env.WAFFO_PRODUCT_MONTHLY ?? '';
  const query = { query: `query ($id: String!) { subscriptionProduct(id:$id) { id metadata description hasProdVersion prices { currency priceInfo { amount taxCategory trialAmount } } } }`, variables: { id: productId } };
  const before = await client.graphql.query<{ subscriptionProduct: Product }>(query);
  const product = before.data?.subscriptionProduct;
  if (!product) throw new Error('Product not available');
  if (process.argv.includes('--configure-test')) {
    if (process.env.WAFFO_ENVIRONMENT !== 'test') throw new Error('Test-only configuration command');
    const metadata: Record<string, unknown> = typeof product.metadata === 'string' ? JSON.parse(product.metadata) as Record<string, unknown> : product.metadata;
    await client.subscriptionProducts.update({ id: productId, name: '博文 星月卡',
      description: 'DeepSeek V4 Pro 大模型 · 全题型考试 · 错题智能归因 · 学习诊断报告。首次 7 天免费试用，之后 USD 3/月自动续费，可在线取消。',
      metadata: { ...metadata, trialDays: 7 },
    }, { idempotencyKey: 'boen-membership-trial-20260923-v1' });
  }
  const after = await client.graphql.query<{ subscriptionProduct: Product }>(query);
  console.log(JSON.stringify({ product: after.data?.subscriptionProduct }, null, 2));
  const schema = await client.graphql.query<{ __type: { fields: Array<{ name: string }> } | null }>({
    query: '{ __type(name:"SubscriptionOrder") { fields { name } } }',
  });
  console.log('Order fields:', schema.data?.__type?.fields.map(field => field.name).join(', '));
  const querySchema = await client.graphql.query<{ __type: { fields: Array<{ name: string; args: Array<{ name: string; type: { name: string | null; kind: string; ofType: { name: string | null } | null } }> }> } }>({ query: '{ __type(name:"Query") { fields { name args { name type { name kind ofType { name } } } } } }' });
  console.log('Order lookup:', JSON.stringify(querySchema.data?.__type.fields.filter(field => field.name === 'subscriptionOrders')));
  const filterSchema = await client.graphql.query<{ __type: { inputFields: Array<{ name: string; type: { name: string | null; kind: string } }> } }>({ query: '{ __type(name:"SubscriptionOrderFilter") { inputFields { name type { name kind } } } }' });
  console.log('Order filters:', JSON.stringify(filterSchema.data?.__type.inputFields));
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : 'Waffo configuration failed'); process.exitCode = 1; });
