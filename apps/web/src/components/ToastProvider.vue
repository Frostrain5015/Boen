<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue';
import { CheckCircle, XCircle, Info, AlertTriangle, X } from 'lucide-vue-next';
import { useToast, type ToastType } from '@/composables/useToast';

const { toasts, dismiss, error } = useToast();

const iconMap: Record<ToastType, any> = {
  success: CheckCircle,
  error: XCircle,
  info: Info,
  warning: AlertTriangle,
};

const colorMap: Record<ToastType, string> = {
  success: 'var(--success)',
  error: 'var(--error)',
  info: 'var(--accent)',
  warning: '#f59e42',
};

const bgMap: Record<ToastType, string> = {
  success: '#e7f7ee',
  error: '#fdeaef',
  info: 'var(--accent-soft)',
  warning: '#fef7e6',
};

// 监听全局错误事件（来自 main.ts 中的 app.config.errorHandler）
function onGlobalError(e: Event) {
  const detail = (e as CustomEvent).detail;
  if (detail) error(detail);
}
onMounted(() => {
  window.addEventListener('boen:global-error', onGlobalError);
});
onUnmounted(() => {
  window.removeEventListener('boen:global-error', onGlobalError);
});
</script>

<template>
  <div class="toast-stack" data-toast-container aria-live="polite" aria-atomic="false">
    <TransitionGroup name="toast-slide">
      <div
        v-for="t in toasts"
        :key="t.id"
        class="toast-card"
        :style="{
          '--toast-accent': colorMap[t.type],
          '--toast-bg': bgMap[t.type],
        }"
        role="alert"
      >
        <!-- 左侧彩色装饰条 -->
        <span class="toast-bar" />

        <!-- 图标（带底色圆形容器） -->
        <span class="toast-icon-wrap">
          <component :is="iconMap[t.type]" class="toast-icon" :size="16" :stroke-width="2.5" />
        </span>

        <!-- 消息正文 -->
        <span class="toast-msg">{{ t.message }}</span>

        <!-- 关闭按钮 -->
        <button class="toast-close" @click="dismiss(t.id)" aria-label="关闭">
          <X :size="13" :stroke-width="2.5" />
        </button>

        <!-- 自动消失进度条 -->
        <span
          v-if="t.duration > 0"
          class="toast-timer"
          :style="{
            animationDuration: t.duration + 'ms',
            background: 'var(--toast-accent)',
          }"
        />
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
/* ── 容器：右下角堆叠 ── */
.toast-stack {
  position: fixed;
  bottom: 1.25rem;
  right: 1.25rem;
  z-index: 99999;
  display: flex;
  flex-direction: column-reverse;
  gap: 0.6rem;
  pointer-events: none;
  max-width: min(400px, calc(100vw - 2.5rem));
}

/* ── 单条 Toast 卡片 ── */
.toast-card {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.7rem 0.75rem 0.7rem 0;
  pointer-events: auto;
  position: relative;
  overflow: hidden;
  background: var(--surface);
  border: 1.5px solid rgba(255, 255, 255, 0.7);
  border-radius: 18px;
  box-shadow:
    0 6px 20px -10px rgba(86, 64, 40, 0.28),
    0 12px 32px -16px rgba(86, 64, 40, 0.18),
    inset 0 2px 0 rgba(255, 255, 255, 0.9);
}

/* ── 左侧彩色装饰条 ── */
.toast-bar {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 4px;
  border-radius: 4px 0 0 4px;
  background: var(--toast-accent);
  transition: background 0.3s ease;
}

/* ── 图标容器（圆形底色） ── */
.toast-icon-wrap {
  display: grid;
  place-items: center;
  width: 2rem;
  height: 2rem;
  border-radius: 50%;
  flex-shrink: 0;
  margin-left: 0.75rem;
  background: var(--toast-bg);
  transition: background 0.3s ease;
}

.toast-icon {
  color: var(--toast-accent);
  transition: color 0.3s ease;
}

/* ── 消息正文 ── */
.toast-msg {
  flex: 1;
  font-family: var(--font-body);
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--ink);
  line-height: 1.4;
  word-break: break-word;
}

/* ── 关闭按钮 ── */
.toast-close {
  flex-shrink: 0;
  display: grid;
  place-items: center;
  width: 1.5rem;
  height: 1.5rem;
  border: none;
  background: transparent;
  color: var(--ink-soft);
  border-radius: 50%;
  cursor: pointer;
  transition: background 0.2s, color 0.2s;
}
.toast-close:hover {
  background: var(--accent-soft);
  color: var(--ink);
}

/* ── 自动消失进度条 ── */
.toast-timer {
  position: absolute;
  bottom: 0;
  left: 0;
  height: 2px;
  opacity: 0.25;
  animation: toastShrink linear forwards;
  border-radius: 0 2px 2px 0;
}

@keyframes toastShrink {
  from { width: 100%; }
  to { width: 0%; }
}

/* ── 入场/出场动画 ── */
.toast-slide-enter-active {
  transition: transform 0.35s cubic-bezier(0.34, 1.56, 0.64, 1), opacity 0.25s ease;
}
.toast-slide-leave-active {
  transition: transform 0.2s ease, opacity 0.2s ease;
}
.toast-slide-enter-from {
  transform: translateX(100%);
  opacity: 0;
}
.toast-slide-leave-to {
  transform: translateX(40%);
  opacity: 0;
}
.toast-slide-move {
  transition: transform 0.3s ease;
}

@media (prefers-reduced-motion: reduce) {
  .toast-slide-enter-active,
  .toast-slide-leave-active {
    transition: opacity 0.2s ease;
  }
  .toast-slide-enter-from,
  .toast-slide-leave-to {
    transform: none;
  }
  .toast-timer {
    animation: none !important;
  }
}
</style>
