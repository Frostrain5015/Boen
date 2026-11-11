<script setup lang="ts">
import { computed, onMounted, watch } from 'vue';
import { useRouter } from 'vue-router';
import OAuthCallback from '@/components/OAuthCallback.vue';
import LoginView from '@/components/LoginView.vue';
import AppLoading from '@/components/AppLoading.vue';
import LearningGradeSetting from '@/components/LearningGradeSetting.vue';
import ToastProvider from '@/components/ToastProvider.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import NetworkStatusBanner from '@/components/NetworkStatusBanner.vue';
import SidebarLayout from '@/components/layout/SidebarLayout.vue';
import MascotWidget from '@/components/layout/MascotWidget.vue';
import OnboardingTour from '@/components/OnboardingTour.vue';
import { useAuthStore } from '@/stores/auth';
import { useUiStore } from '@/stores/ui';
import { useFavicon } from '@/composables/useFavicon';

const authStore = useAuthStore();
const uiStore = useUiStore();
const router = useRouter();
const isPublicLegalRoute = computed(() => ['terms', 'privacy', 'pricing'].includes(String(router.currentRoute.value.name)));
const requiresGrade = computed(() => authStore.grade === null && router.currentRoute.value.name !== 'setup');

// 类课堂模式：离开聊天页时自动退出
watch(() => router.currentRoute.value.name, (name) => {
  if (name !== 'chat' && uiStore.sessionActive) {
    uiStore.endSession();
  }
});

// Initialize favicon watcher
useFavicon();

onMounted(() => {
  // 字体大小初始化
  const fs = localStorage.getItem('boen_font_size') || 'md';
  document.documentElement.setAttribute('data-fontsize', fs);

  authStore.checkAuth();

  // Remove boot loader after Vue has rendered
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const loader = document.getElementById('boot-loader');
      if (loader) {
        loader.classList.add('hide');
        loader.addEventListener('transitionend', () => loader.remove(), { once: true });
        setTimeout(() => { if (loader.parentNode) loader.remove(); }, 400);
      }
    });
  });
});
</script>

<template>
  <div class="flex h-full flex-col">
  <div class="relative min-h-0 flex-1">
  <!-- 服务条款与隐私政策必须允许未登录访问，便于用户阅读及支付平台审核 -->
  <router-view v-if="isPublicLegalRoute" />

  <!-- OAuth 回调页面 -->
  <OAuthCallback
    v-else-if="authStore.isOAuthCallback"
    @success="authStore.handleOAuthSuccess"
    @error="authStore.handleOAuthError()"
  />

  <AppLoading v-else-if="!authStore.authChecked" loading message="正在确认登录状态…" />
  <LoginView v-else-if="!authStore.authenticated" />

  <AppLoading v-else-if="requiresGrade && authStore.gradeStatus === 'loading'" loading message="正在读取年级…" />
  <main v-else-if="requiresGrade"
    class="flex h-full items-center justify-center overflow-y-auto bg-[var(--paper)] p-5 text-[var(--ink)]">
    <section :aria-labelledby="authStore.gradeStatus === 'ready' ? 'choose-grade-title' : undefined"
      class="w-full max-w-sm rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-5 sm:p-7">
      <template v-if="authStore.gradeStatus === 'ready'">
        <h1 id="choose-grade-title" class="mb-2 font-display text-2xl font-bold">选择你的年级</h1>
        <p class="mb-5 text-sm text-[var(--ink-soft)]">博文会按你的年级查找教材和练习。</p>
      </template>
      <LearningGradeSetting onboarding />
    </section>
  </main>

  <!-- 主应用 -->
  <div v-else :class="{ 'boen-session': uiStore.sessionActive }" :data-subject="uiStore.subject" class="relative flex h-full flex-col">
    <div class="app-bg">
      <div class="app-bg-overlay" aria-hidden="true"></div>
    </div>
    <div class="app-grain"></div>

    <div class="relative z-10 flex h-full">
      <SidebarLayout />

      <!-- 主内容区 -->
      <div class="relative min-h-0 min-w-0 flex-1 overflow-hidden" :data-subject="uiStore.subject">
        <router-view v-slot="{ Component }">
          <Transition name="view-fade">
            <component :is="Component" class="absolute inset-0 flex flex-col" />
          </Transition>
        </router-view>
      </div>
    </div>

    <!-- 吉祥物 -->
    <MascotWidget />

    <!-- 新手引导（首次登录完成设置后在对话页触发） -->
    <OnboardingTour />
  </div>

  </div>
  </div>

  <!-- Toast 通知 & 确认弹窗（全局常驻） -->
  <ToastProvider />
  <ConfirmDialog />
  <NetworkStatusBanner />
</template>
