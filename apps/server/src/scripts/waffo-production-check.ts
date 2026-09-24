import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { WaffoPancake } from '@waffo/pancake-ts';
import { configuredPlans, verifyCatalog } from '../waffo-catalog.js';
config({ path: fileURLToPath(new URL('../../../../.env', import.meta.url)), quiet: true });
const client = new WaffoPancake({ merchantId: process.env.WAFFO_MERCHANT_ID ?? '', privateKey: process.env.WAFFO_PRIVATE_KEY ?? '', environment: 'prod' });
await verifyCatalog(client, 'prod');
if (configuredPlans().length !== 2) throw new Error('Both monthly and yearly product IDs are required for this release');
const response = await client.graphql.query<{
  storeWebhooks: Array<{ url: string; testMode: boolean; events: string | string[] }>;
  kybTickets: Array<{ status: string }>;
}>({ query: 'query($store:String!){storeWebhooks(storeId:$store){url testMode events} kybTickets{status}}', variables: { store: process.env.WAFFO_STORE_ID } });
const expectedUrl = `${process.env.WAFFO_WEB_ORIGIN?.replace(/\/$/, '')}/api/payment/webhook`;
const hook = response.data?.storeWebhooks.find(hook => !hook.testMode && hook.url === expectedUrl);
const events: unknown = hook && (typeof hook.events === 'string' ? JSON.parse(hook.events) : hook.events);
const required = ['subscription.activated','subscription.renewed','subscription.recovered','subscription.canceling','subscription.uncanceled','subscription.canceled','subscription.past_due','refund.succeeded'];
if (!Array.isArray(events) || required.some(event => !events.includes(event))) throw new Error('Production webhook is missing required lifecycle events');
console.log(JSON.stringify({ environment: 'prod', products: configuredPlans().map(plan => ({ name: plan.name, amount: plan.amount, currency: plan.currency, interval: plan.key, trialDays: plan.trialDays })), productionWebhookReady: true, kybStatuses: response.data?.kybTickets.map(ticket => ticket.status) }, null, 2));
