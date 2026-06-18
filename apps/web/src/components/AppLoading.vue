<script setup lang="ts">
/**
 * AppLoading.vue — 通用全屏加载界面
 *
 * 用法：
 *  - 初始加载：<AppLoading :loading="true" />
 *  - OAuth 回调处理中：<AppLoading status="processing" message="正在登录…" />
 *  - OAuth 成功：<AppLoading status="success" message="登录成功！" />
 *  - OAuth 失败：<AppLoading status="error" :message="errorMsg" />
 *
 * 如果 loading 为 false 且没有 status，则自动隐藏。
 */
import Mascot from '@/components/Mascot.vue';
import type { MascotState } from '@/components/Mascot.vue';

const props = withDefaults(defineProps<{
  /** 通用加载态（仅显示加载动画，不显示具体状态文本） */
  loading?: boolean;
  /** 精确状态：处理中 / 成功 / 失败 */
  status?: 'processing' | 'success' | 'error';
  /** 状态描述文字 */
  message?: string;
  /** 子状态提示 */
  hint?: string;
}>(), {
  loading: false,
});

const mascotState: MascotState =
  props.status === 'processing' ? 'thinking' :
  props.status === 'success' ? 'happy' :
  props.status === 'error' ? 'surprise' :
  'thinking';

const show = () => props.loading || props.status !== undefined;
</script>

<template>
  <Transition name="fade-slow">
    <div v-if="show()" class="fixed inset-0 z-[9999] flex flex-col items-center justify-center bg-[var(--bg)]">
      <div class="app-bg"></div>
      <div class="app-grain"></div>

      <div
        class="relative z-10 flex flex-col items-center gap-4"
        v-motion
        :initial="{ opacity: 0, scale: 0.85 }"
        :enter="{ opacity: 1, scale: 1, transition: { delay: 80, duration: 500 } }"
      >
        <!-- 吉祥物 -->
        <div class="loading-mascot">
          <Mascot :size="status === 'success' ? 110 : 96" :float="true" :state="mascotState" />
        </div>

        <!-- 标题 / 消息 -->
        <div class="text-center">
          <h1 v-if="loading && !message" class="brand-text text-3xl font-bold tracking-tight">博文 Boen</h1>
          <h2 v-else-if="message" class="text-xl font-bold" :class="status === 'error' ? 'text-[var(--error)]' : 'text-[var(--ink)]'">
            {{ message }}
          </h2>
          <p v-if="hint" class="mt-1.5 text-sm text-[var(--ink-soft)]">{{ hint }}</p>
        </div>

        <!-- 加载进度条（仅 loading / processing 态） -->
        <div v-if="loading || status === 'processing'" class="mt-1 flex flex-col items-center gap-2">
          <div class="loading-bar"><div class="loading-bar-inner"></div></div>
          <p class="text-xs font-medium text-[var(--ink-soft)]/60">正在唤醒学习助手…</p>
        </div>

        <!-- 成功勾选（success 态） -->
        <div v-else-if="status === 'success'" class="mt-1">
          <div class="loading-check">✓</div>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.loading-check {
  display: grid;
  place-items: center;
  width: 3rem;
  height: 3rem;
  border-radius: 50%;
  background: var(--success);
  color: white;
  font-size: 1.5rem;
  font-weight: 700;
  animation: checkPop 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) both;
}
</style>
