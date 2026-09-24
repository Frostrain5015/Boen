import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const origin = process.env.BOEN_PREVIEW_ORIGIN || 'http://127.0.0.1:5176';
const output = resolve('data/membership-ui');
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const errors = [];
const now = Math.floor(Date.now() / 1000);
async function checkSupportFooter(page) {
  const link = page.locator('footer[aria-label="网站信息"] a[href="mailto:phy55015@hotmail.com"]');
  await link.waitFor({ state: 'visible' });
  if (!(await link.innerText()).includes('phy55015@hotmail.com')) throw new Error('Support email not visibly disclosed');
  const box = await link.boundingBox();
  const viewport = page.viewportSize();
  if (!box || box.x < 0 || box.y < 0 || box.x + box.width > viewport.width || box.y + box.height > viewport.height) {
    throw new Error('Support contact clipped or outside viewport');
  }
  await link.focus();
  if (!await link.evaluate(element => element === document.activeElement)) throw new Error('Support contact not keyboard accessible');
}
function status(state = 'active') {
  const legacy = state === 'legacy';
  const reward = state === 'reward';
  const none = state === 'none';
  const ends = now + 7 * 86400;
  return { tier: legacy ? 'yearly' : none ? 'free' : 'monthly', isPremium: !none && state !== 'canceled', expiresAt: none ? null : ends,
    activatedAt: now, dailyLimit: none ? 10 : null, dailyUsed: 0, dailyRemaining: 10, payEnabled: true,
    plans: [{ key: 'monthly', name: '星月卡', days: 30 }],
    membership: { active: !none, source: legacy ? 'legacy' : reward ? 'reward' : none ? 'none' : 'waffo', accessEndsAt: ends, legacyTier: legacy ? 'yearly' : null },
    billing: { status: legacy || reward ? 'none' : state, currentPeriodStart: now, currentPeriodEnd: ends, renewsAt: ends,
      cancelAtPeriodEnd: state === 'canceling', amount: '3.00', currency: 'USD', trialEligible: none,
      checkoutAllowed: none || reward || state === 'canceled', portalUrl: 'https://pancake.waffo.ai/consumer/portal/login' },
    rewards: { bankedSeconds: 30 * 86400, activeUntil: reward ? ends : null } };
}
try {
  const page = await browser.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', route => route.fulfill({ json: {} }));
  for (const width of [360, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(`${origin}/pricing`);
    await page.getByRole('heading', { name: /让学习/ }).waitFor();
    await page.locator('#boot-loader').waitFor({ state: 'detached' });
    await checkSupportFooter(page);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    if (overflow) throw new Error(`Pricing overflows at ${width}`);
    const pricingCard = await page.locator('.membership-card-container').boundingBox();
    if (!pricingCard || pricingCard.x + pricingCard.width > width) throw new Error(`Clipped pricing card at ${width}`);
    await page.screenshot({ path: `${output}/pricing-${width}.png`, fullPage: true });
  }
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    for (const path of ['/', '/terms', '/privacy']) {
      await page.goto(`${origin}${path}`);
      if (path !== '/') {
        await page.locator('.legal-copy h1').waitFor();
        if ((await page.locator('body').innerText()).includes('使用 Frost ID 登录')) throw new Error(`Login wall on ${path}`);
      }
      await checkSupportFooter(page);
      for (const href of ['/pricing', '/terms', '/privacy']) {
        const link = page.locator(`footer[aria-label="网站信息"] a[href="${href}"]`);
        if (!await link.isVisible()) throw new Error(`Missing global footer link ${path} -> ${href}`);
      }
    }
  }
  await page.close();
  for (const width of [360, 390, 768, 1280]) {
    for (const state of ['none', 'trialing', 'active', 'canceling', 'past_due', 'canceled', 'legacy', 'reward']) {
      const context = await browser.newContext({ viewport: { width, height: 1050 }, reducedMotion: 'reduce' });
      await context.addInitScript(() => {
        sessionStorage.setItem('boen_access_token', 'ui-fixture');
        localStorage.setItem('boen_user_profile_alice', JSON.stringify({ name: '涵宇', grade: '8' }));
        localStorage.setItem('boen_user_profile', JSON.stringify({ name: '涵宇', grade: '8' }));
        localStorage.setItem('boen_onboarding_completed', 'true');
      });
      const ui = await context.newPage();
      ui.on('pageerror', error => errors.push(error.message));
      await ui.route('**/api/**', async route => {
        const path = new URL(route.request().url()).pathname;
        let json = {};
        if (path === '/api/auth/userinfo') json = { sub: 'alice', username: '涵宇', email: 'member@example.test' };
        if (path === '/api/subscription/status') json = status(state);
        if (path === '/api/currency/status') json = { balance: 2400, claimedToday: false, dailyEarned: 0, dailyCap: 100, products: [] };
        if (path.includes('conversations')) json = { conversations: [] };
        if (path.includes('/exam')) json = { exams: [] };
        await route.fulfill({ json });
      });
      await ui.goto(`${origin}/setup`);
      await ui.getByRole('heading', { name: '会员与订阅', exact: true }).waitFor();
      await ui.locator('#boot-loader').waitFor({ state: 'detached' });
      await checkSupportFooter(ui);
      if (!await ui.locator('footer[aria-label="网站信息"] a[href="/terms"]').isVisible()) throw new Error('Missing authenticated legal footer');
      if (await ui.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error(`Setup overflows at ${width}/${state}`);
      const card = ui.locator('.membership-card-container');
      const box = await card.boundingBox();
      if (!box || box.width < 200 || box.height < 120) throw new Error(`Collapsed card ${width}/${state}: ${JSON.stringify(box)}`);
      if (box.x + box.width > width) throw new Error(`Clipped card at ${width}/${state}`);
      await card.focus();
      await ui.keyboard.press('Enter');
      if (await card.getAttribute('aria-pressed') !== 'true') throw new Error('Keyboard flip failed');
      await ui.keyboard.press('Space');
      if (state === 'active') {
        await ui.getByRole('button', { name: '取消自动续费', exact: true }).click();
        await ui.getByRole('dialog').waitFor();
        await ui.getByRole('button', { name: '暂不操作', exact: true }).click();
      }
      if (['none', 'active', 'legacy'].includes(state)) await ui.screenshot({ path: `${output}/setup-${width}-${state}.png`, fullPage: true });
      await ui.getByText('字体大小', { exact: true }).scrollIntoViewIfNeeded();
      if (!await ui.getByText('字体大小', { exact: true }).isVisible()) throw new Error('Settings unreachable');
      await context.close();
    }
  }
  if (errors.length) throw new Error(JSON.stringify(errors));
  console.log('Public pages and 32 responsive membership states passed. Screenshots:', output);
} finally { await browser.close(); }
