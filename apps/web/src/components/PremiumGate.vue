<script setup lang="ts">
import { computed, type Component } from 'vue';
import { Crown, X } from 'lucide-vue-next';
import { useAuthStore } from '@/stores/auth';
import { useToast } from '@/composables/useToast';

const authStore = useAuthStore();
const toast = useToast();

const props = defineProps<{
  featureName: string;
  icon?: Component;
  extraBenefits?: string[];
  standalone?: boolean;
}>();

const emit = defineEmits<{ close: [] }>();

const defaultBenefits = [
  'DeepSeek V4 Flash — 极速响应，日常学习首选',
  'DeepSeek V4 Pro — 深度推理，复杂题目攻克',
  '全题型练习（考试/测验/错题本）',
  '学习报告与知识画像分析',
];
const premiumBenefits = computed(() =>
  props.extraBenefits?.length
    ? [...new Set([...defaultBenefits, ...props.extraBenefits])]
    : defaultBenefits,
);

function handleContact() {
  toast.info('请联系管理员开通会员');
}

const cardMotion = {
  initial: { opacity: 0, scale: 0.92, y: 16 },
  enter: { opacity: 1, scale: 1, y: 0, transition: { duration: 500, ease: [0.34, 1.56, 0.64, 1] } },
};

const pricingMotion = {
  initial: { opacity: 0, y: 12 },
  enter: { opacity: 1, y: 0, transition: { duration: 400, delay: 200 } },
};
</script>

<template>
  <slot v-if="authStore.isPremium" />

  <div v-else :class="standalone ? '' : 'relative h-full w-full'">
    <div :class="standalone ? '' : 'premium-overlay'">
      <div class="relative clay clay-glass flex w-full max-w-[380px] flex-col items-center px-8 py-10"
        v-motion="cardMotion"
      >
        <button v-if="standalone" @click="emit('close')"
          class="absolute right-4 top-4 grid h-7 w-7 place-items-center rounded-full text-[var(--ink-soft)] transition-colors hover:bg-[var(--accent-soft)] hover:text-[var(--ink)]"
        ><X :size="16" /></button>

        <div class="mb-5 flex h-16 w-16 items-center justify-center rounded-2xl"
          style="background: var(--locked-surface); border: 1.5px solid var(--locked-line)">
          <component v-if="icon" :is="icon" class="h-8 w-8" style="color: var(--locked-ink)" />
          <Crown v-else class="h-8 w-8" style="color: var(--locked-ink)" />
        </div>

        <h2 class="mb-1.5 text-center font-display text-xl font-bold" style="color: var(--ink)">会员专属功能</h2>
        <p class="mb-2 text-center text-sm" style="color: var(--ink-soft)">{{ featureName }}</p>

        <div class="mb-5 flex flex-col gap-1.5 self-start px-2 text-sm" style="color: var(--ink-soft)">
          <div v-for="item in premiumBenefits" :key="item" class="flex items-center gap-2">
            <span class="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs"
              style="background: var(--accent-soft); color: var(--accent-strong)">✦</span>
            {{ item }}
          </div>
        </div>

        <div class="mb-6 w-full px-12"><div class="h-px w-full" style="background: var(--line)"></div></div>

        <div class="mb-6 flex flex-col items-center gap-2" v-motion="pricingMotion">
          <div class="flex items-center gap-2">
            <span class="font-display text-2xl font-bold" style="color: var(--premium-gold-strong)">¥9.9</span>
            <span class="rounded-full px-2 py-0.5 text-xs font-semibold"
              style="background: var(--premium-gold-soft); color: var(--premium-gold-strong)">首月</span>
          </div>
          <p class="text-sm" style="color: var(--ink-soft)">次月起 ¥19.9/月</p>
        </div>

        <button @click="handleContact"
          class="mb-3 w-full rounded-[18px] px-6 py-3 text-sm font-semibold text-white transition-all"
          style="background: linear-gradient(180deg, var(--premium-gold) 0%, var(--premium-gold-strong) 100%);
            box-shadow: 0 12px 24px -10px var(--premium-gold-glow),
                        inset 0 -3px 0 rgba(0,0,0,0.14),
                        inset 0 2px 0 rgba(255,255,255,0.28);"
          @mouseenter="($event.currentTarget as HTMLElement).style.transform = 'translateY(-2px)'"
          @mouseleave="($event.currentTarget as HTMLElement).style.transform = ''"
        >联系管理员开通</button>

        <p class="text-xs" style="color: var(--ink-soft); opacity: 0.7">开通后即刻解锁全部高级功能</p>
      </div>
    </div>

    <div v-if="!standalone" class="invisible"><slot /></div>
  </div>
</template>
