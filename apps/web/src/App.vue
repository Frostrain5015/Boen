<script setup lang="ts">
import { computed, onMounted, watch } from 'vue';
import { useRouter } from 'vue-router';
import OAuthCallback from '@/components/OAuthCallback.vue';
import LoginView from '@/components/LoginView.vue';
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
    @success="authStore.handleOAuthSuccess()"
    @error="authStore.handleOAuthError()"
  />

  <!-- 登录页面（authChecked 为 false 时也拦截，防止闪未登录对话界面） -->
  <LoginView v-else-if="!authStore.authChecked || !authStore.authenticated" />

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
  <footer aria-label="网站信息" class="relative z-20 flex shrink-0 flex-wrap items-center justify-center gap-x-5 gap-y-2 border-t border-[var(--line)] bg-[var(--paper)] px-3 py-2 text-xs text-[var(--ink-soft)]">
    <nav aria-label="产品与法律" class="flex items-center gap-5">
      <router-link to="/pricing" class="hover:text-[var(--accent-strong)] focus-visible:underline">功能与定价</router-link>
      <router-link to="/terms" class="hover:text-[var(--accent-strong)] focus-visible:underline">服务条款</router-link>
      <router-link to="/privacy" class="hover:text-[var(--accent-strong)] focus-visible:underline">隐私政策</router-link>
    </nav>
    <a href="mailto:phy55015@hotmail.com" class="whitespace-nowrap hover:text-[var(--accent-strong)] focus-visible:underline">客服：phy55015@hotmail.com</a>
  </footer>
  </div>

  <!-- Toast 通知 & 确认弹窗（全局常驻） -->
  <ToastProvider />
  <ConfirmDialog />
  <NetworkStatusBanner />
</template>
