<script setup lang="ts">
import { onMounted, watch, ref } from 'vue';
import OAuthCallback from '@/components/OAuthCallback.vue';
import LoginView from '@/components/LoginView.vue';
import ToastProvider from '@/components/ToastProvider.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import SidebarLayout from '@/components/layout/SidebarLayout.vue';
import MascotWidget from '@/components/layout/MascotWidget.vue';
import { useAuthStore } from '@/stores/auth';
import { useUiStore } from '@/stores/ui';
import { useFavicon } from '@/composables/useFavicon';

const authStore = useAuthStore();
const uiStore = useUiStore();
const appRoot = ref<HTMLElement | null>(null);

// Initialize favicon watcher
useFavicon();

onMounted(() => {
  // 字体大小初始化
  const fs = localStorage.getItem('boen_font_size') || 'md';
  document.documentElement.setAttribute('data-fontsize', fs);

  authStore.checkAuth();

  // 类课堂模式：同步 sessionActive → data-session 属性（驱动 CSS 变量冷色覆盖）
  const applySession = (active: boolean) => {
    const el = appRoot.value;
    console.log(`[Boen 类课堂] 🎨 applySession(${active}) — el:`, el?.tagName, el?.className);
    if (el) el.dataset.session = active ? 'active' : '';
  };
  // 首次检查（可能 auth 已完成且 session 已激活）
  applySession(uiStore.sessionActive);
  watch(() => uiStore.sessionActive, (val) => {
    console.log(`[Boen 类课堂] 🔍 sessionActive watcher fired: ${val}`);
    applySession(val);
  });

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
  <!-- OAuth 回调页面 -->
  <OAuthCallback
    v-if="authStore.isOAuthCallback"
    @success="authStore.handleOAuthSuccess()"
    @error="authStore.handleOAuthError()"
  />

  <!-- 登录页面（authChecked 为 false 时也拦截，防止闪未登录对话界面） -->
  <LoginView v-else-if="!authStore.authChecked || !authStore.authenticated" />

  <!-- 主应用 -->
  <div v-else ref="appRoot" :data-subject="uiStore.subject" class="relative flex h-full flex-col">
    <div class="app-bg"></div>
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
  </div>

  <!-- Toast 通知 & 确认弹窗（全局常驻） -->
  <ToastProvider />
  <ConfirmDialog />
</template>
