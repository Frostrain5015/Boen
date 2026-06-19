<script setup lang="ts">
import type { Component } from 'vue';
import { Crown } from 'lucide-vue-next';
import { useAuthStore } from '@/stores/auth';
import { useToast } from '@/composables/useToast';

const authStore = useAuthStore();
const toast = useToast();

defineProps<{
  featureName: string;
  icon?: Component;
}>();

function handleContact() {
  toast.info('请联系管理员开通会员');
}
</script>

<template>
  <!-- Premium 用户：正常渲染内容 -->
  <slot v-if="authStore.isPremium" />

  <!-- 免费用户：付费墙覆盖 -->
  <div v-else class="relative h-full w-full">
    <!-- 毛玻璃遮罩 -->
    <div class="premium-overlay">
      <div
        class="clay flex w-full max-w-[380px] flex-col items-center px-8 py-10"
        v-motion
        :initial="{ opacity: 0, scale: 0.92, y: 16 }"
        :enter="{ opacity: 1, scale: 1, y: 0, transition: { duration: 500, ease: [0.34, 1.56, 0.64, 1] } }"
      >
        <!-- 功能图标 -->
        <div
          class="mb-5 flex h-16 w-16 items-center justify-center rounded-2xl"
          style="background: var(--locked-surface); border: 1.5px solid var(--locked-line)"
        >
          <component
            v-if="icon"
            :is="icon"
            class="h-8 w-8"
            style="color: var(--locked-ink)"
          />
          <Crown v-else class="h-8 w-8" style="color: var(--locked-ink)" />
        </div>

        <!-- 标题 -->
        <h2
          class="mb-1.5 text-center"
          style="font-family: var(--font-display); font-size: 1.25rem; font-weight: 700; color: var(--ink)"
        >
          会员专属功能
        </h2>
        <p
          class="mb-6 text-center"
          style="font-family: var(--font-body); font-size: 0.9rem; color: var(--ink-soft)"
        >
          {{ featureName }}
        </p>

        <!-- 分隔线 -->
        <div class="mb-6 w-full px-12">
          <div class="h-px w-full" style="background: var(--line)"></div>
        </div>

        <!-- 定价区 -->
        <div
          class="mb-6 flex flex-col items-center gap-2"
          v-motion
          :initial="{ opacity: 0, y: 12 }"
          :enter="{ opacity: 1, y: 0, transition: { duration: 400, delay: 200 } }"
        >
          <!-- 首月促销 -->
          <div class="flex items-center gap-2">
            <span
              style="font-family: var(--font-display); font-size: 1.5rem; font-weight: 700; color: var(--premium-gold-strong)"
            >
              ¥9.9
            </span>
            <span class="subject-tag" style="background: var(--premium-gold-soft); color: var(--premium-gold-strong)">
              首月
            </span>
          </div>
          <!-- 后续续费价 -->
          <p style="font-family: var(--font-body); font-size: 0.85rem; color: var(--ink-soft)">
            次月起 ¥19.9/月
          </p>
        </div>

        <!-- CTA 按钮 -->
        <button
          @click="handleContact"
          class="mb-3 w-full rounded-[18px] px-6 py-3 text-sm font-semibold text-white transition-all"
          style="
            background: linear-gradient(180deg, var(--premium-gold) 0%, var(--premium-gold-strong) 100%);
            box-shadow: 0 12px 24px -10px var(--premium-gold-glow),
                        inset 0 -3px 0 rgba(0, 0, 0, 0.14),
                        inset 0 2px 0 rgba(255, 255, 255, 0.28);
          "
          @mouseenter="($event.currentTarget as HTMLElement).style.transform = 'translateY(-2px)'"
          @mouseleave="($event.currentTarget as HTMLElement).style.transform = ''"
        >
          联系管理员开通
        </button>

        <!-- 辅助文字 -->
        <p style="font-size: 0.75rem; color: var(--ink-soft); opacity: 0.7">
          开通后即刻解锁全部高级功能
        </p>
      </div>
    </div>

    <!-- 底层内容（被遮罩覆盖，仅占位保持布局） -->
    <div class="invisible">
      <slot />
    </div>
  </div>
</template>
