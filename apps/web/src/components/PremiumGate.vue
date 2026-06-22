<script setup lang="ts">
import { computed, ref, type Component } from 'vue';
import { Crown, X, ClipboardPaste } from 'lucide-vue-next';
import { useAuthStore } from '@/stores/auth';
import { useToast } from '@/composables/useToast';

const authStore = useAuthStore();
const toast = useToast();

const redeemInput = ref('');
const redeeming = ref(false);

async function handlePaste() {
  try {
    const text = await navigator.clipboard.readText();
    if (text.trim()) redeemInput.value = text.trim();
  } catch {
    toast.error('无法读取剪贴板，请手动粘贴');
  }
}

async function handleRedeem() {
  const code = redeemInput.value.trim();
  if (!code || redeeming.value) return;
  redeeming.value = true;
  try {
    const r = await authStore.redeemCode(code);
    if (r.ok) {
      toast.success('🎉 兑换成功，会员已开通');
      redeemInput.value = '';
      emit('close'); // standalone 弹窗关闭；内嵌门禁会因 isPremium 翻转自动显示内容
    } else {
      toast.error(r.message ?? '兑换失败');
    }
  } finally {
    redeeming.value = false;
  }
}

const props = defineProps<{
  featureName: string;
  icon?: Component;
  extraBenefits?: string[];
  standalone?: boolean;
}>();

const emit = defineEmits<{ close: [] }>();

const defaultBenefits = [
  'DeepSeek V4 Pro 大模型 — 深度推理，难题也能讲到孩子听懂',
  '考试与全题型练习 — 紧扣教材章节智能出题，针对薄弱点强化',
  '错题本智能归因 — 拍照上传作业错题，自动定位知识漏洞',
  '学习诊断报告与知识画像 — 一眼看清孩子的强弱项与每一步进步',
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

        <!-- 兑换码开通 -->
        <div class="mb-3 flex w-full gap-2">
          <input
            v-model="redeemInput"
            @keydown.enter="handleRedeem"
            :disabled="redeeming"
            placeholder="输入兑换码"
            maxlength="48"
            class="min-w-0 flex-1 rounded-[16px] border bg-white px-3.5 py-2.5 text-sm tracking-wide outline-none transition-colors disabled:opacity-60"
            style="border-color: var(--line); color: var(--ink)"
            @focus="($event.target as HTMLElement).style.borderColor = 'var(--premium-gold)'"
            @blur="($event.target as HTMLElement).style.borderColor = 'var(--line)'"
          />
          <button @click="handlePaste" title="粘贴兑换码" aria-label="粘贴兑换码"
            class="grid shrink-0 place-items-center rounded-[16px] border px-3 transition-colors hover:bg-[var(--accent-soft)]"
            style="border-color: var(--line); color: var(--ink-soft)"
          ><ClipboardPaste class="h-4 w-4" /></button>
          <button @click="handleRedeem" :disabled="redeeming || !redeemInput.trim()"
            class="shrink-0 rounded-[16px] px-5 py-2.5 text-sm font-semibold text-white transition-all disabled:opacity-50"
            style="background: linear-gradient(180deg, var(--premium-gold) 0%, var(--premium-gold-strong) 100%);
              box-shadow: 0 10px 20px -10px var(--premium-gold-glow),
                          inset 0 -2px 0 rgba(0,0,0,0.12),
                          inset 0 1px 0 rgba(255,255,255,0.28);"
          >{{ redeeming ? '兑换中…' : '兑换' }}</button>
        </div>

        <button @click="handleContact" class="text-xs underline-offset-2 transition-colors hover:underline"
          style="color: var(--ink-soft); opacity: 0.7">没有兑换码？联系管理员</button>
      </div>
    </div>

    <div v-if="!standalone" class="invisible"><slot /></div>
  </div>
</template>
