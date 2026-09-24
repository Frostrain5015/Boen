// Creates empty checkout sessions only. Never enters a payment method or submits an order.
import { config } from 'dotenv';
import { WaffoPancake } from '@waffo/pancake-ts';
import { createRequire } from 'node:module';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
config({ path: resolve('.env'), quiet: true });
if (!process.argv.includes('--create-empty-production-checkouts')) throw new Error('Explicit empty-checkout probe flag required');
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output = resolve('data/waffo-production-readiness');
mkdirSync(output, { recursive: true });
const client = new WaffoPancake({ merchantId: process.env.WAFFO_MERCHANT_ID, privateKey: process.env.WAFFO_PRIVATE_KEY, environment: 'prod' });
const credentialFingerprint = createHash('sha256').update(process.env.WAFFO_PRIVATE_KEY).digest('hex');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  for (const plan of [{ key: 'monthly', id: process.env.WAFFO_PRODUCT_MONTHLY, amount: '2.99' }, { key: 'yearly', id: process.env.WAFFO_PRODUCT_YEARLY, amount: '29.99' }]) {
    if (!plan.id) throw new Error(`Missing ${plan.key} product`);
    const path = resolve(output, `${plan.key}.json`);
    let session = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
    if (!session || session.credentialFingerprint !== credentialFingerprint || Date.parse(session.expiresAt) < Date.now()) {
      session = await client.checkout.authenticated.create({ productId: plan.id, buyerIdentity: `boen-release-probe-1-2-${plan.key}`, currency: 'USD', language: 'zh-Hans', withTrial: true,
        orderMerchantExternalId: `boen-release-1-2-${plan.key}`, successUrl: 'https://boen.frostrain.tech/setup?paid=1' });
      session.credentialFingerprint = credentialFingerprint;
      writeFileSync(path, JSON.stringify(session), { mode: 0o600 });
    }
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    await page.goto(session.checkoutUrl, { waitUntil: 'networkidle' });
    const text = await page.locator('body').innerText();
    if (!text.includes(plan.amount) || !/7\s*天/.test(text) || text.includes('测试模式')) throw new Error(`${plan.key} production checkout did not match expected price/trial/mode`);
    console.log(JSON.stringify({ plan: plan.key, productionCheckout: true, displayedAmount: plan.amount, trialDays: 7, paymentSubmitted: false }));
    await page.screenshot({ path: resolve(output, `${plan.key}.png`), fullPage: true });
    await page.close();
  }
} finally { await browser.close(); }
