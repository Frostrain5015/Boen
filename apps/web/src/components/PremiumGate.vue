<script setup lang="ts">
import { computed, ref, type Component, nextTick } from 'vue';
import { Crown, X, ClipboardPaste, Sparkles } from 'lucide-vue-next';
import { useAuthStore } from '@/stores/auth';
import { useToast } from '@/composables/useToast';
import MembershipCard from './MembershipCard.vue';

const authStore = useAuthStore();
const toast = useToast();

const redeemInput = ref('');
const redeeming = ref(false);
const showSuccessAnimation = ref(false);
const redeemedTier = ref<'monthly' | 'yearly'>('monthly');
const flyingCardRef = ref<HTMLDivElement | null>(null);

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
      // 判断兑换的是月卡还是年卡
      redeemedTier.value = authStore.subscription?.tier === 'yearly' ? 'yearly' : 'monthly';
      redeemInput.value = '';

      // 播放成功动画
      showSuccessAnimation.value = true;

      // 3秒后关闭动画并触发关闭事件
      setTimeout(() => {
        showSuccessAnimation.value = false;
        emit('close');
      }, 3500);
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
  toast.info('请联系管理员激活星月卡');
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
      <div class="relative clay clay-glass flex w-full max-w-[420px] flex-col items-center px-6 py-8"
        v-motion="cardMotion"
      >
        <button v-if="standalone" @click="emit('close')"
          class="absolute right-4 top-4 grid h-7 w-7 place-items-center rounded-full text-[var(--ink-soft)] transition-colors hover:bg-[var(--accent-soft)] hover:text-[var(--ink)]"
        ><X :size="16" /></button>

        <!-- 顶部标题 -->
        <div class="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl"
          style="background: var(--locked-surface); border: 1.5px solid var(--locked-line)">
          <component v-if="icon" :is="icon" class="h-7 w-7" style="color: var(--locked-ink)" />
          <Crown v-else class="h-7 w-7" style="color: var(--locked-ink)" />
        </div>

        <h2 class="mb-1 text-center font-display text-xl font-bold" style="color: var(--ink)">星月卡专属功能</h2>
        <p class="mb-3 text-center text-sm" style="color: var(--ink-soft)">{{ featureName }}</p>

        <!-- 两张卡片展示 -->
        <div class="mb-4 flex flex-col items-center gap-3 w-full">
          <div class="flex items-center gap-3 justify-center">
            <MembershipCard type="monthly" size="sm" />
            <MembershipCard type="yearly" size="sm" />
          </div>
          <p class="text-xs" style="color: var(--ink-soft)">
            <Sparkles class="inline h-3 w-3 mr-1" style="color: var(--premium-gold)" />
            悬停卡片查看权益，点击翻转
          </p>
        </div>

        <div class="mb-4 w-full px-8"><div class="h-px w-full" style="background: var(--line)"></div></div>

        <!-- 权益列表 -->
        <div class="mb-4 flex flex-col gap-1.5 self-start px-2 text-sm" style="color: var(--ink-soft)">
          <div v-for="item in premiumBenefits" :key="item" class="flex items-center gap-2">
            <span class="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs"
              style="background: var(--accent-soft); color: var(--accent-strong)">✦</span>
            {{ item }}
          </div>
        </div>

        <div class="mb-4 w-full px-8"><div class="h-px w-full" style="background: var(--line)"></div></div>

        <!-- 定价信息 -->
        <div class="mb-5 flex flex-col items-center gap-2" v-motion="pricingMotion">
          <div class="flex items-center gap-3">
            <div class="flex flex-col items-center">
              <span class="font-display text-lg font-bold" style="color: #7a756e">¥18</span>
              <span class="text-[10px]" style="color: var(--ink-soft)">皓月卡/月</span>
            </div>
            <div class="h-8 w-px" style="background: var(--line)"></div>
            <div class="flex flex-col items-center">
              <span class="font-display text-lg font-bold" style="color: var(--premium-gold-strong)">¥188</span>
              <span class="text-[10px]" style="color: var(--ink-soft)">星耀卡/年</span>
            </div>
          </div>
          <p class="text-xs" style="color: var(--premium-gold-strong)">
            年卡立省 ¥50.8，更划算
          </p>
        </div>

        <!-- 兑换码开通 -->
        <div class="mb-3 flex w-full gap-2">
          <input
            v-model="redeemInput"
            @keydown.enter="handleRedeem"
            :disabled="redeeming"
            placeholder="输入兑换码激活星月卡"
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
          >{{ redeeming ? '激活中…' : '激活' }}</button>
        </div>

        <button @click="handleContact" class="text-xs underline-offset-2 transition-colors hover:underline"
          style="color: var(--ink-soft); opacity: 0.7">没有兑换码？联系管理员</button>
      </div>
    </div>

    <div v-if="!standalone" class="invisible"><slot /></div>
  </div>

  <!-- 兑换成功动画 -->
  <Teleport to="body">
    <div v-if="showSuccessAnimation" class="success-animation-overlay">
      <div ref="flyingCardRef" class="flying-card" :class="redeemedTier">
        <MembershipCard :type="redeemedTier" size="lg" />
      </div>
      <div class="success-text">
        <Sparkles class="success-icon" />
        <span>激活成功！{{ redeemedTier === 'yearly' ? '星耀卡' : '皓月卡' }}已到账</span>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/* 成功动画覆盖层 */
.success-animation-overlay {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  background: rgba(251, 246, 238, 0.9);
  backdrop-filter: blur(8px);
  animation: fadeIn 0.3s ease;
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

.flying-card {
  animation: cardAppear 0.6s cubic-bezier(0.34, 1.56, 0.64, 1) forwards,
             cardShine 0.8s ease-in-out 0.4s forwards,
             cardFlyAway 0.8s cubic-bezier(0.4, 0, 0.2, 1) 1.8s forwards;
}

@keyframes cardAppear {
  from {
    opacity: 0;
    transform: scale(0.5) translateY(40px);
  }
  to {
    opacity: 1;
    transform: scale(1) translateY(0);
  }
}

@keyframes cardShine {
  0% { filter: brightness(1); }
  50% { filter: brightness(1.3); }
  100% { filter: brightness(1); }
}

@keyframes cardFlyAway {
  from {
    opacity: 1;
    transform: scale(1);
  }
  to {
    opacity: 0;
    transform: scale(0.3) translate(-200px, 200px);
  }
}

.success-text {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 24px;
  font-family: var(--font-display);
  font-size: 1.125rem;
  font-weight: 700;
  color: var(--premium-gold-strong);
  animation: textFadeIn 0.4s ease 0.6s both;
}

@keyframes textFadeIn {
  from { opacity: 0; transform: translateY(10px); }
  to { opacity: 1; transform: translateY(0); }
}

.success-icon {
  width: 20px;
  height: 20px;
  animation: iconSpin 0.6s ease 0.8s both;
}

@keyframes iconSpin {
  from { transform: rotate(-180deg) scale(0); }
  to { transform: rotate(0) scale(1); }
}
</style>
