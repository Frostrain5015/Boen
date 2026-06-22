<script setup lang="ts">
import { ref, type Component } from 'vue';
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
      redeemedTier.value = authStore.subscription?.tier === 'yearly' ? 'yearly' : 'monthly';
      redeemInput.value = '';
      showSuccessAnimation.value = true;
    } else {
      toast.error(r.message ?? '兑换失败');
    }
  } finally {
    redeeming.value = false;
  }
}

function handleSuccessDismiss() {
  showSuccessAnimation.value = false;
  emit('close');
}

const props = defineProps<{
  featureName: string;
  icon?: Component;
  standalone?: boolean;
}>();

const emit = defineEmits<{ close: [] }>();

function handleContact() {
  toast.info('请联系管理员激活星月卡');
}

const cardMotion = {
  initial: { opacity: 0, scale: 0.92, y: 16 },
  enter: { opacity: 1, scale: 1, y: 0, transition: { duration: 500, ease: [0.34, 1.56, 0.64, 1] } },
};
</script>

<template>
  <slot v-if="authStore.isPremium" />

  <div v-else :class="standalone ? '' : 'relative h-full w-full'">
    <div :class="standalone ? '' : 'premium-overlay'">
      <div class="flex flex-col items-center gap-6" v-motion="cardMotion">
        <button v-if="standalone" @click="emit('close')"
          class="absolute right-4 top-4 grid h-7 w-7 place-items-center rounded-full text-[var(--ink-soft)] transition-colors hover:bg-[var(--accent-soft)] hover:text-[var(--ink)]"
        ><X :size="16" /></button>

        <!-- 两张卡片展示 -->
        <div class="flex items-center gap-4 justify-center">
          <MembershipCard type="monthly" size="sm" />
          <MembershipCard type="yearly" size="sm" />
        </div>
        <p class="text-xs" style="color: var(--ink-soft)">
          <Sparkles class="inline h-3 w-3 mr-1" style="color: var(--premium-gold)" />
          悬停卡片查看权益，点击翻转
        </p>

        <!-- 兑换码激活 -->
        <div class="flex gap-2 w-[360px]">
          <input
            v-model="redeemInput"
            @keydown.enter="handleRedeem"
            :disabled="redeeming"
            placeholder="输入兑换码激活星月卡"
            maxlength="48"
            class="min-w-0 flex-1 rounded-[16px] border bg-white/80 px-3.5 py-2.5 text-sm tracking-wide outline-none transition-colors disabled:opacity-60 backdrop-blur-sm"
            style="border-color: var(--line); color: var(--ink)"
            @focus="($event.target as HTMLElement).style.borderColor = 'var(--premium-gold)'"
            @blur="($event.target as HTMLElement).style.borderColor = 'var(--line)'"
          />
          <button @click="handlePaste" title="粘贴兑换码" aria-label="粘贴兑换码"
            class="grid shrink-0 place-items-center rounded-[16px] border bg-white/60 px-3 backdrop-blur-sm transition-colors hover:bg-[var(--accent-soft)]"
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
    <Transition name="success-fade">
      <div v-if="showSuccessAnimation" class="success-animation-overlay">
        <div class="success-card-wrapper">
          <MembershipCard :type="redeemedTier" size="lg" />
        </div>
        <div class="success-text">
          <Sparkles class="success-icon" />
          <span>激活成功！{{ redeemedTier === 'yearly' ? '星耀卡' : '皓月卡' }}已到账</span>
        </div>
        <button @click="handleSuccessDismiss" class="success-dismiss-btn">
          我知道了
        </button>
      </div>
    </Transition>
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
  background: rgba(251, 246, 238, 0.92);
  backdrop-filter: blur(12px);
}

.success-fade-enter-active { transition: opacity 0.3s ease; }
.success-fade-leave-active { transition: opacity 0.5s ease; }
.success-fade-enter-from,
.success-fade-leave-to { opacity: 0; }

.success-card-wrapper {
  animation: cardAppear 0.6s cubic-bezier(0.34, 1.56, 0.64, 1) forwards,
             cardShine 0.8s ease-in-out 0.4s forwards;
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

.success-dismiss-btn {
  margin-top: 32px;
  padding: 10px 40px;
  border-radius: 99px;
  font-family: var(--font-display);
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--ink-soft);
  background: var(--surface);
  border: 1px solid var(--line);
  cursor: pointer;
  transition: all 0.2s ease;
  animation: textFadeIn 0.4s ease 0.9s both;
}

.success-dismiss-btn:hover {
  color: var(--ink);
  border-color: var(--premium-gold);
  box-shadow: 0 4px 12px -4px var(--premium-gold-glow);
}
</style>
