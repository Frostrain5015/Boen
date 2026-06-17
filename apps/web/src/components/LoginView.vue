<script setup lang="ts">
import { ref } from 'vue';
import Mascot from '@/components/Mascot.vue';
import { loginWithFrostId } from '@/services/auth';

const isLoading = ref(false);

async function handleLogin() {
  isLoading.value = true;
  try {
    await loginWithFrostId();
  } catch {
    isLoading.value = false;
  }
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
        <p class="mt-2 text-sm text-[var(--ink-soft)]">你的 AI 学习小伙伴</p>
      </div>

      <!-- 登录按钮 -->
      <button
        @click="handleLogin"
        :disabled="isLoading"
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

      <!-- 提示 -->
      <p class="text-center text-xs text-[var(--ink-soft)]/60">
        登录即表示你同意我们的服务条款
      </p>
    </div>

    <!-- 底部装饰 -->
    <div class="absolute bottom-8 left-0 right-0 z-10 text-center">
      <p class="text-xs text-[var(--ink-soft)]/40">Powered by Frost ID · 寒霜科技</p>
    </div>
  </div>
</template>
