import { config } from 'dotenv';
import { WaffoPancake } from '@waffo/pancake-ts';
import { createRequire } from 'node:module';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
config({ path: resolve('.env'), quiet: true });
if (process.env.WAFFO_ENVIRONMENT !== 'test') throw new Error('This check only runs in the Waffo sandbox.');
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output = resolve('data/waffo-sandbox');
mkdirSync(output, { recursive: true });
const sessionFile = resolve(output, 'checkout.json');
const client = new WaffoPancake({ merchantId: process.env.WAFFO_MERCHANT_ID, privateKey: process.env.WAFFO_PRIVATE_KEY, environment: 'test' });
let session = existsSync(sessionFile) ? JSON.parse(readFileSync(sessionFile, 'utf8')) : null;
if (!session || Date.parse(session.expiresAt) < Date.now()) {
  session = await client.checkout.authenticated.create({ productId: process.env.WAFFO_PRODUCT_MONTHLY,
    buyerIdentity: 'boen_qa_20260923', currency: 'USD', language: 'zh-Hans', withTrial: true,
    orderMerchantExternalId: `boen-qa-${Date.now()}`, successUrl: 'http://127.0.0.1:5176/setup?paid=1',
  });
  writeFileSync(sessionFile, JSON.stringify(session), { mode: 0o600 });
}
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  await page.goto(session.checkoutUrl, { waitUntil: 'networkidle' });
  await page.screenshot({ path: resolve(output, 'checkout.png'), fullPage: true });
  console.log((await page.locator('body').innerText()).slice(0, 9000));
  console.log('Inputs:', JSON.stringify(await page.locator('input').evaluateAll(inputs => inputs.map(input => ({ type: input.type, name: input.name, placeholder: input.placeholder })))));
  console.log('Screenshot saved; no real payment submitted.');
} finally { await browser.close(); }
