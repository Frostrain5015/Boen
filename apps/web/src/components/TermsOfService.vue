<script setup lang="ts">
import { X } from 'lucide-vue-next';
import LegalDocument from '@/components/legal/LegalDocument.vue';

defineProps<{ show: boolean }>();
const emit = defineEmits<{ close: [] }>();

function close() { emit('close'); }

function onClickOutside(e: MouseEvent) {
  if ((e.target as HTMLElement).classList.contains('tos-overlay')) close();
}
</script>

<template>
  <Teleport to="body">
    <Transition name="tos-fade">
      <div
        v-if="show"
        class="tos-overlay fixed inset-0 z-[999] flex items-center justify-center bg-black/30 backdrop-blur-sm px-4"
        @click="onClickOutside"
      >
        <div
          class="relative flex max-h-[80vh] w-full max-w-xl flex-col rounded-2xl bg-white shadow-2xl"
          v-motion
          :initial="{ opacity: 0, y: 30, scale: 0.95 }"
          :enter="{ opacity: 1, y: 0, scale: 1, transition: { type: 'spring', stiffness: 300, damping: 25 } }"
        >
          <!-- 头部 -->
          <div class="flex items-center justify-between border-b border-[var(--line)] px-6 py-4">
            <h2 class="font-display text-lg font-bold text-[var(--ink)]">服务条款</h2>
            <button @click="close" class="grid h-8 w-8 place-items-center rounded-xl text-[var(--ink-soft)] transition-colors hover:bg-[var(--accent-soft)] hover:text-[var(--ink)]" aria-label="关闭">
              <X class="h-5 w-5" />
            </button>
          </div>

          <!-- 内容 -->
          <div class="overflow-y-auto px-6 py-5">
            <LegalDocument kind="terms" />
          </div>

          <!-- 底部按钮 -->
          <div class="flex items-center justify-between gap-4 border-t border-[var(--line)] px-6 py-4">
            <router-link to="/privacy" target="_blank" class="text-xs text-[var(--accent-strong)] underline">
              查看隐私政策
            </router-link>
            <button
              @click="close"
              class="btn-accent rounded-xl px-6 py-2 text-sm font-semibold"
            >
              我已阅读
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.tos-fade-enter-active,
.tos-fade-leave-active {
  transition: opacity 0.25s ease;
}
.tos-fade-enter-from,
.tos-fade-leave-to {
  opacity: 0;
}
</style>
