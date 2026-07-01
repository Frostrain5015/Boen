<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import Mascot from '@/components/Mascot.vue';
import TermsOfService from '@/components/TermsOfService.vue';
import { loginWithFrostId, loginAsTestUser } from '@/services/auth';
import { useAuthStore } from '@/stores/auth';

const router = useRouter();
const authStore = useAuthStore();

const isLoading = ref(false);
const agreedToTerms = ref(false);
const showTos = ref(false);

async function handleLogin() {
  if (!agreedToTerms.value) return;
  isLoading.value = true;
  try {
    await loginWithFrostId();
  } catch {
    isLoading.value = false;
  }
}

function handleTestLogin() {
  if (!agreedToTerms.value) return;
  const { user, profile } = loginAsTestUser({ name: '本地测试用户', grade: '8' });
  // 直接设置 auth store 状态，跳过 API 调用链条
  authStore.$patch({
    authenticated: true,
    authChecked: true,
    currentUser: user,
    userProfile: profile,
    subscription: { isPremium: true, plan: 'local-dev', dailyRemaining: 99, dailyUsed: 0 },
    currency: { balance: 9999, totalEarned: 9999, totalSpent: 0, dailyEarned: 0, dailyCap: 100, claimedToday: true },
  });
  router.push('/');
}
</script>

<template>
  <div class="relative flex h-full flex-col items-center justify-center">
    <!-- 背景 -->
    <div class="app-bg"></div>
    <div class="app-grain"></div>

    <!-- 登录卡片 -->
    <div
      class="relative z-10 flex w-full max-w-sm flex-col items-center gap-6 px-6"
      v-motion
      :initial="{ opacity: 0, y: 30, scale: 0.95 }"
      :enter="{ opacity: 1, y: 0, scale: 1, transition: { duration: 600, ease: 'easeOut' } }"
    >
      <!-- 吉祥物 -->
      <div class="relative">
        <Mascot :size="100" :float="true" state="idle" />
        <!-- 装饰光环 -->
        <div class="absolute inset-0 -z-10 rounded-full bg-[var(--accent-soft)] opacity-50 blur-2xl"></div>
      </div>

      <!-- 标题 -->
      <div class="text-center">
        <h1 class="brand-text text-3xl font-bold">博文 Boen</h1>
        <p class="mt-2 text-sm text-[var(--ink-soft)]">AI 原生时代的教育智能体</p>
      </div>

      <!-- 登录按钮 -->
      <button
        @click="handleLogin"
        :disabled="isLoading || !agreedToTerms"
        class="btn-accent group flex w-full items-center justify-center gap-2 rounded-[18px] px-6 py-3.5 text-base font-semibold transition-all duration-300 disabled:opacity-60"
      >
        <span v-if="isLoading" class="h-5 w-5 animate-spin rounded-full border-2 border-white/30 border-t-white"></span>
        <svg
          v-else
          class="h-5 w-5 transition-transform duration-300 group-hover:scale-110"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
          <polyline points="10 17 15 12 10 7" />
          <line x1="15" y1="12" x2="3" y2="12" />
        </svg>
        <span>{{ isLoading ? '正在跳转…' : '使用 Frost ID 登录' }}</span>
      </button>

      <button
        @click="handleTestLogin"
        :disabled="!agreedToTerms"
        class="flex w-full items-center justify-center gap-2 rounded-[18px] border border-slate-600 bg-slate-800/60 px-6 py-2.5 text-sm font-medium text-slate-300 transition-all hover:bg-slate-800 disabled:opacity-60"
      >
        🧪 本地测试登录（免 OAuth）
      </button>

      <!-- 同意条款 -->
      <label class="flex cursor-pointer items-start gap-2 text-left">
        <input
          type="checkbox"
          v-model="agreedToTerms"
          class="mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-[var(--accent)]"
        />
        <span class="text-xs leading-relaxed text-[var(--ink-soft)]/80">
          我已阅读并同意
          <button type="button" @click.stop="showTos = true" class="text-[var(--accent-strong)] underline hover:opacity-80">服务条款</button>
        </span>
      </label>
    </div>

    <!-- 底部装饰 -->
    <div class="absolute bottom-8 left-0 right-0 z-10 text-center">
      <p class="text-xs text-[var(--ink-soft)]/40">Powered by Frost ID · 寒霜科技</p>
    </div>
  </div>

  <TermsOfService :show="showTos" @close="showTos = false" />
</template>
