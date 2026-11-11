<script setup lang="ts">
import { ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Mascot from '@/components/Mascot.vue';
import TermsOfService from '@/components/TermsOfService.vue';
import SiteLinks from '@/components/layout/SiteLinks.vue';
import { loginWithFrostId, loginAsTestUser } from '@/services/auth';
import { useAuthStore, type UserProfile } from '@/stores/auth';

const router = useRouter();
const route = useRoute();
const authStore = useAuthStore();

const isLoading = ref(false);
const agreedToTerms = ref(false);
const showTos = ref(false);
const consentInput = ref<HTMLInputElement | null>(null);
const loginError = ref('');
/** 测试登录仅限本地开发构建，生产不可见 */
const isDev = import.meta.env.DEV;

async function handleLogin() {
  if (isLoading.value) return;
  if (!agreedToTerms.value) {
    loginError.value = '请先阅读并同意服务条款与隐私政策';
    consentInput.value?.focus();
    return;
  }
  loginError.value = '';
  isLoading.value = true;
  try {
    const plan = route.name === 'setup' ? route.query.plan : undefined;
    await loginWithFrostId(plan === 'monthly' || plan === 'yearly' ? plan : undefined);
  } catch {
    loginError.value = '无法打开登录页面，请重试';
    isLoading.value = false;
  }
}

function handleTestLogin() {
  if (!isDev || !agreedToTerms.value) return;
  const { user, profile } = loginAsTestUser({ name: '本地测试用户', grade: '8' });
  // 直接设置 auth store 状态，跳过 API 调用链条（仅本地开发）
  authStore.authenticated = true;
  authStore.authChecked = true;
  authStore.currentUser = user;
  authStore.userProfile = profile as unknown as UserProfile;
  authStore.subscription = {
    tier: 'monthly',
    isPremium: true,
    expiresAt: null,
    activatedAt: null,
    dailyLimit: null,
    dailyUsed: 0,
    dailyRemaining: 99,
    membership: { active: true, source: 'legacy', accessEndsAt: null, legacyTier: 'monthly' },
    billing: {
      status: 'active',
      currentPeriodStart: null,
      currentPeriodEnd: null,
      renewsAt: null,
      cancelAtPeriodEnd: false,
      amount: '0',
      currency: 'USD',
      planKey: 'monthly',
      trialEligible: false,
      checkoutAllowed: false,
      portalUrl: 'https://pancake.waffo.ai/consumer/portal/login',
    },
    rewards: { bankedSeconds: 0, activeUntil: null },
  };
  authStore.currency = {
    balance: 9999,
    totalEarned: 9999,
    totalSpent: 0,
    todayEarned: 0,
    dailyCap: 100,
    dailyRemaining: 100,
    products: [],
    claimedToday: true,
    loginReward: 50,
  };
  router.push('/');
}
</script>

<template>
  <div class="login-page">
    <main class="login-main">
      <section class="login-content" aria-labelledby="login-heading">
        <header class="login-brand">
          <div aria-hidden="true"><Mascot :size="64" :float="false" state="idle" /></div>
          <div>
            <h1 id="login-heading">博文 <span>Boen</span></h1>
            <p>AI 学习助手</p>
          </div>
        </header>

        <form class="login-form" :aria-busy="isLoading" @submit.prevent="handleLogin">
          <div class="login-consent">
            <input
              id="login-consent"
              ref="consentInput"
              v-model="agreedToTerms"
              type="checkbox"
              :disabled="isLoading"
              aria-labelledby="login-consent-label"
              :aria-invalid="loginError && !agreedToTerms ? 'true' : undefined"
              :aria-describedby="loginError ? 'login-error login-age-notice' : 'login-age-notice'"
              @change="loginError = ''"
            />
            <div>
              <span id="login-consent-label">
                <label for="login-consent">我已阅读并同意</label>
                <button type="button" @click="showTos = true">服务条款</button>
                和<router-link to="/privacy" target="_blank" rel="noopener noreferrer">隐私政策</router-link>
              </span>
              <p id="login-age-notice">未满 14 岁须由监护人同意并指导使用。</p>
            </div>
          </div>
          <p v-if="loginError" id="login-error" class="login-error" role="alert">{{ loginError }}</p>
          <button type="submit" class="login-primary" :disabled="isLoading">
            <span v-if="isLoading" class="login-spinner" aria-hidden="true"></span>
            <span>{{ isLoading ? '正在跳转…' : '使用 Frost ID 登录' }}</span>
            <svg v-if="!isLoading" aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14m-6-6 6 6-6 6" /></svg>
          </button>
          <button v-if="isDev" type="button" class="login-test" :disabled="isLoading || !agreedToTerms" @click="handleTestLogin">本地测试登录</button>
        </form>
      </section>
    </main>
    <SiteLinks />
  </div>
  <TermsOfService :show="showTos" @close="showTos = false" />
</template>

<style scoped>
.login-page { display: flex; flex-direction: column; height: 100%; overflow-y: auto; background: #faf9f5; color: #2c342f; }
.login-main { display: flex; flex: 1; align-items: center; justify-content: center; padding: 48px 24px; }
.login-content { width: 100%; max-width: 360px; }
.login-brand { display: flex; align-items: center; gap: 16px; margin-bottom: 44px; }
.login-brand h1 { margin: 0; font-size: 30px; font-weight: 700; line-height: 1.25; letter-spacing: -.04em; }
.login-brand h1 span { margin-left: 4px; font-family: var(--font-display); font-size: 26px; font-weight: 500; letter-spacing: -.02em; }
.login-brand p { margin: 7px 0 0; font-size: 14px; color: #696f67; }
.login-form { display: flex; flex-direction: column; gap: 24px; }
.login-consent { display: flex; align-items: flex-start; gap: 10px; font-size: 12px; line-height: 1.9; color: #555f55; }
.login-consent input { flex-shrink: 0; width: 16px; height: 16px; margin: 4px 0 0; accent-color: #176448; cursor: pointer; }
.login-consent label { cursor: pointer; }
.login-consent button, .login-consent a { color: #176448; text-decoration: underline; text-underline-offset: 3px; }
.login-consent p { margin: 5px 0 0; color: #696f67; }
.login-primary { display: flex; width: 100%; min-height: 52px; align-items: center; justify-content: center; gap: 12px; padding: 13px 18px; border-radius: 12px; background: #176448; color: #fff; font-size: 15px; font-weight: 600; cursor: pointer; transition: background .15s, transform .15s; }
.login-primary:hover:not(:disabled) { background: #105137; }
.login-primary:active:not(:disabled) { transform: translateY(1px); }
.login-primary:disabled { opacity: .65; cursor: wait; }
.login-test { color: #696f67; font-size: 12px; text-decoration: underline; text-underline-offset: 3px; }
.login-test:disabled { opacity: .5; }
.login-error { margin: -12px 0; font-size: 12px; line-height: 1.7; color: #a32c32; }
.login-spinner { width: 16px; height: 16px; border: 2px solid #ffffff60; border-top-color: #fff; border-radius: 50%; animation: login-spin .8s linear infinite; }
.login-page :is(button, a, input):focus-visible { outline: 2px solid #176448; outline-offset: 4px; }
@keyframes login-spin { to { transform: rotate(360deg); } }
@media (max-height: 500px) { .login-main { padding-block: 28px; } .login-brand { margin-bottom: 28px; } }
@media (prefers-reduced-motion: reduce) { .login-primary { transition: none; } .login-spinner { animation-duration: 1.6s; } }
</style>
