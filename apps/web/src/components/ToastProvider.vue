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
        class="toast-card clay-sm"
        :style="{ '--toast-accent': colorMap[t.type] }"
        role="alert"
      >
        <span class="toast-bar" />
        <component :is="iconMap[t.type]" class="toast-icon" :size="18" :stroke-width="2" />
        <span class="toast-msg">{{ t.message }}</span>
        <button class="toast-close" @click="dismiss(t.id)" aria-label="关闭">
          <X :size="14" :stroke-width="2.5" />
        </button>
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
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

.toast-card {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.7rem 0.85rem 0.7rem 0;
  pointer-events: auto;
  position: relative;
  overflow: hidden;
}

.toast-bar {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 4px;
  border-radius: 4px 0 0 4px;
  background: var(--toast-accent);
}

.toast-icon {
  flex-shrink: 0;
  color: var(--toast-accent);
  margin-left: 0.75rem;
}

.toast-msg {
  flex: 1;
  font-family: var(--font-body);
  font-size: 0.875rem;
  font-weight: 500;
  color: var(--ink);
  line-height: 1.4;
  word-break: break-word;
}

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

/* ── TransitionGroup animations ── */
.toast-slide-enter-active {
  transition: transform 0.35s cubic-bezier(0.34, 1.56, 0.64, 1), opacity 0.25s ease;
}
.toast-slide-leave-active {
  transition: transform 0.25s ease, opacity 0.2s ease;
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
}
</style>
