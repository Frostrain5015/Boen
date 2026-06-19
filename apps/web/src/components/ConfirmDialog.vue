<script setup lang="ts">
import { AlertTriangle, X } from 'lucide-vue-next';
import { useConfirm } from '@/composables/useConfirm';

const { isOpen, options, handleConfirm, handleCancel } = useConfirm();
</script>

<template>
    <Transition name="confirm-fade">
      <div v-if="isOpen" class="confirm-overlay" @click.self="handleCancel">
        <div class="confirm-card clay" role="dialog" aria-modal="true" :aria-label="options.title">
          <!-- 顶部装饰线 -->
          <span class="confirm-accent-line" :class="{ danger: options.danger }" />

          <button class="confirm-x" @click="handleCancel" aria-label="关闭">
            <X :size="16" :stroke-width="2.5" />
          </button>

          <div class="confirm-body">
            <div class="confirm-icon-wrap" :class="{ danger: options.danger }">
              <AlertTriangle :size="22" :stroke-width="2" />
            </div>
            <h3 class="confirm-title">{{ options.title }}</h3>
            <p class="confirm-message">{{ options.message }}</p>
          </div>

          <div class="confirm-actions">
            <button class="confirm-btn cancel" @click="handleCancel">
              {{ options.cancelText || '取消' }}
            </button>
            <button
              class="confirm-btn ok"
              :class="{ danger: options.danger }"
              @click="handleConfirm"
            >
              {{ options.confirmText || '确定' }}
            </button>
          </div>
        </div>
      </div>
    </Transition>
</template>

<style scoped>
.confirm-overlay {
  position: fixed;
  inset: 0;
  z-index: 99998;
  display: grid;
  place-items: center;
  background: rgba(44, 39, 34, 0.35);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  padding: 1.5rem;
}

.confirm-card {
  position: relative;
  width: 100%;
  max-width: 360px;
  padding: 0;
  overflow: hidden;
}

.confirm-accent-line {
  display: block;
  height: 4px;
  background: var(--accent);
  border-radius: 26px 26px 0 0;
}
.confirm-accent-line.danger {
  background: var(--error);
}

.confirm-x {
  position: absolute;
  top: 0.85rem;
  right: 0.85rem;
  display: grid;
  place-items: center;
  width: 1.75rem;
  height: 1.75rem;
  border: none;
  background: transparent;
  color: var(--ink-soft);
  border-radius: 50%;
  cursor: pointer;
  transition: background 0.2s, color 0.2s;
}
.confirm-x:hover {
  background: var(--accent-soft);
  color: var(--ink);
}

.confirm-body {
  padding: 1.5rem 1.75rem 0.5rem;
  text-align: center;
}

.confirm-icon-wrap {
  display: inline-grid;
  place-items: center;
  width: 3rem;
  height: 3rem;
  border-radius: 50%;
  background: var(--accent-soft);
  color: var(--accent);
  margin-bottom: 0.85rem;
}
.confirm-icon-wrap.danger {
  background: #fde8ed;
  color: var(--error);
}

.confirm-title {
  font-family: var(--font-display);
  font-size: 1.1rem;
  font-weight: 700;
  color: var(--ink);
  margin: 0 0 0.5rem;
}

.confirm-message {
  font-family: var(--font-body);
  font-size: 0.9rem;
  color: var(--ink-soft);
  line-height: 1.55;
  margin: 0;
}

.confirm-actions {
  display: flex;
  gap: 0.65rem;
  padding: 1.25rem 1.75rem 1.5rem;
  justify-content: center;
}

.confirm-btn {
  flex: 1;
  padding: 0.6rem 1rem;
  border-radius: 14px;
  font-family: var(--font-body);
  font-size: 0.9rem;
  font-weight: 600;
  cursor: pointer;
  transition: transform 0.15s, box-shadow 0.2s, background 0.2s;
  border: 1.5px solid transparent;
}
.confirm-btn:active {
  transform: scale(0.97);
}

.confirm-btn.cancel {
  background: var(--paper);
  color: var(--ink-soft);
  border-color: var(--line);
}
.confirm-btn.cancel:hover {
  background: var(--accent-soft);
  color: var(--ink);
}

.confirm-btn.ok {
  background: var(--accent);
  color: #fff;
  box-shadow: 0 2px 8px -2px color-mix(in srgb, var(--accent) 40%, transparent);
}
.confirm-btn.ok:hover {
  filter: brightness(1.05);
}
.confirm-btn.ok.danger {
  background: var(--error);
  box-shadow: 0 2px 8px -2px color-mix(in srgb, var(--error) 40%, transparent);
}

/* ── Transition ── */
.confirm-fade-enter-active {
  transition: opacity 0.2s ease;
}
.confirm-fade-leave-active {
  transition: opacity 0.18s ease;
}
.confirm-fade-enter-from,
.confirm-fade-leave-to {
  opacity: 0;
}
.confirm-fade-enter-active .confirm-card {
  animation: confirmPopIn 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
}

@keyframes confirmPopIn {
  from {
    transform: scale(0.92);
    opacity: 0;
  }
  to {
    transform: scale(1);
    opacity: 1;
  }
}

@media (prefers-reduced-motion: reduce) {
  .confirm-fade-enter-active .confirm-card {
    animation: none;
  }
}
</style>
