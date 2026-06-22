<script setup lang="ts">
import { ref, computed } from 'vue';
import { Moon, Star, Sparkles, Ticket, ArrowRight, LoaderCircle } from 'lucide-vue-next';

interface Props {
  type: 'monthly' | 'yearly';
  expiresAt?: number | null;
  holderName?: string;
  showBack?: boolean;
  size?: 'sm' | 'md' | 'lg';
  /** 是否在卡面上显示价格（广告页显示，已有卡不显示） */
  showPrice?: boolean;
  /** 背面是否内嵌兑换码输入框 */
  redeemable?: boolean;
  /** 兑换码（v-model:redeemCode） */
  redeemCode?: string;
  /** 兑换请求进行中 */
  redeeming?: boolean;
  /** 输入框提示文案 */
  redeemPlaceholder?: string;
}

const props = withDefaults(defineProps<Props>(), {
  expiresAt: null,
  holderName: '',
  showBack: false,
  size: 'md',
  showPrice: true,
  redeemable: false,
  redeemCode: '',
  redeeming: false,
  redeemPlaceholder: '输入兑换码',
});

const emit = defineEmits<{
  (e: 'update:redeemCode', value: string): void;
  (e: 'redeem'): void;
}>();

function onRedeemInput(e: Event) {
  emit('update:redeemCode', (e.target as HTMLInputElement).value);
}

const isFlipped = ref(props.showBack);
const cardRef = ref<HTMLDivElement | null>(null);
const rootEl = ref<HTMLDivElement | null>(null);

const isMonthly = computed(() => props.type === 'monthly');
const cardName = computed(() => (isMonthly.value ? '皓月卡' : '星耀卡'));
const cardPrice = computed(() => (isMonthly.value ? '¥18/月' : '¥188/年'));
const cardOriginalPrice = computed(() => (isMonthly.value ? '' : '原价¥238.8'));

// 持卡人名字
const holderDisplay = computed(() => {
  if (!props.holderName) return '';
  return props.holderName.length > 8 ? props.holderName.substring(0, 8) + '…' : props.holderName;
});

// 到期日格式化
const expiresDate = computed(() => {
  if (!props.expiresAt) return '';
  return new Date(props.expiresAt * 1000).toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/\//g, '/');
});

const sizeClasses = {
  sm: 'w-[280px] h-[177px]',
  md: 'w-[340px] h-[214px]',
  lg: 'w-[400px] h-[252px]',
};

const fontSizes = {
  sm: { title: 'text-base', subtitle: 'text-[11px]', icon: 36, desc: 'text-[10px]' },
  md: { title: 'text-lg', subtitle: 'text-xs', icon: 48, desc: 'text-[11px]' },
  lg: { title: 'text-xl', subtitle: 'text-sm', icon: 56, desc: 'text-xs' },
};

function handleMouseMove(e: MouseEvent) {
  if (!cardRef.value || isFlipped.value) return;
  const rect = cardRef.value.getBoundingClientRect();
  const x = (e.clientX - rect.left) / rect.width - 0.5;
  const y = (e.clientY - rect.top) / rect.height - 0.5;
  cardRef.value.style.transform = `perspective(1000px) rotateY(${x * 12}deg) rotateX(${-y * 12}deg) translateY(-4px)`;
}

function handleMouseLeave() {
  if (!cardRef.value) return;
  cardRef.value.style.transform = 'perspective(1000px) rotateY(0deg) rotateX(0deg) translateY(0)';
}

function flip() {
  isFlipped.value = !isFlipped.value;
}

// 镜面闪光：递增 key 强制重建 shimmer 元素以重放 CSS 动画（卡片本体 DOM 不变）
const shimmerKey = ref(0);
function playShimmer() {
  shimmerKey.value += 1;
}

defineExpose({ flip, isFlipped, playShimmer, rootEl });
</script>

<template>
  <div ref="rootEl" class="membership-card-outer">
    <div
      class="membership-card-container"
      :class="sizeClasses[size]"
      @mousemove="handleMouseMove"
      @mouseleave="handleMouseLeave"
      @click="flip"
    >
    <div
      ref="cardRef"
      class="membership-card"
      :class="{ 'is-flipped': isFlipped }"
    >
      <!-- 正面 -->
      <div class="card-face card-front" :class="isMonthly ? 'card-monthly' : 'card-yearly'">
        <!-- 表层质感（均在文字之下，pointer-events:none）：超大同色水印母题 / 受光 / 细噪点 -->
        <div class="surf surf-watermark" aria-hidden="true">
          <svg v-if="isMonthly" viewBox="0 0 24 24" fill="currentColor"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>
          <svg v-else viewBox="0 0 24 24" fill="currentColor"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
        </div>
        <div class="surf surf-light" aria-hidden="true" />
        <div class="surf surf-noise" aria-hidden="true" />

        <!-- 顶部装饰线 -->
        <div class="card-stripe" />

        <!-- 博文·星月卡 标志 -->
        <div class="card-brand">
          <span class="brand-text" :class="fontSizes[size].subtitle">博文·星月卡</span>
        </div>

        <!-- 中央图标（增大） -->
        <div class="card-icon-wrapper">
          <div class="card-icon-glow" />
          <component :is="isMonthly ? Moon : Star" :size="fontSizes[size].icon" class="card-icon" />
        </div>

        <!-- 卡片名称 -->
        <div class="card-name-section">
          <h3 class="card-name" :class="fontSizes[size].title">{{ cardName }}</h3>
        </div>

        <!-- 底部：持卡人 + 到期日 -->
        <div class="card-footer" :class="fontSizes[size].desc">
          <span v-if="holderDisplay" class="card-footer-holder">{{ holderDisplay }}</span>
          <span v-else />
          <span v-if="expiresDate" class="card-footer-expires">{{ expiresDate }}到期</span>
        </div>

        <!-- 闪光效果 -->
        <div :key="shimmerKey" class="card-shimmer" />
      </div>

      <!-- 背面 -->
      <div class="card-face card-back" :class="isMonthly ? 'card-monthly-back' : 'card-yearly-back'">
        <div class="back-content">
          <div class="back-header" :class="fontSizes[size].subtitle">
            <Sparkles class="back-icon" :size="14" />
            {{ cardName }}权益
          </div>
          <ul class="back-benefits" :class="fontSizes[size].desc">
            <li><span class="benefit-dot" />V4 Pro 大模型</li>
            <li><span class="benefit-dot" />全题型考试</li>
            <li><span class="benefit-dot" />错题智能归因</li>
            <li><span class="benefit-dot" />学习诊断报告</li>
          </ul>

          <!-- 背面内嵌兑换码（无边框，底部细线 + 占位提示） -->
          <div v-if="redeemable" class="back-redeem" @click.stop>
            <div class="back-redeem-row">
              <Ticket class="back-redeem-icon" :size="14" />
              <input
                class="back-redeem-input"
                :value="redeemCode"
                @input="onRedeemInput"
                @keydown.enter="emit('redeem')"
                @click.stop
                :disabled="redeeming"
                :placeholder="redeemPlaceholder"
                maxlength="48"
                autocomplete="off"
                spellcheck="false"
              />
              <button
                class="back-redeem-btn"
                @click.stop="emit('redeem')"
                :disabled="redeeming || !redeemCode.trim()"
                :title="redeemPlaceholder"
              >
                <LoaderCircle v-if="redeeming" :size="14" class="back-redeem-spin" />
                <ArrowRight v-else :size="14" />
              </button>
            </div>
          </div>
        </div>
      </div>
      </div>
    </div>
    <!-- 卡片下方价格文本（仅广告模式显示） -->
    <div v-if="showPrice && !holderDisplay" class="card-price-label">
      <span class="card-price-value" :class="{ 'card-price-value-yearly': !isMonthly }">{{ cardPrice }}</span>
      <span v-if="cardOriginalPrice" class="card-price-original">{{ cardOriginalPrice }}</span>
    </div>
  </div>
</template>

<style scoped>
.membership-card-outer {
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
}

.membership-card-container {
  perspective: 1000px;
  cursor: pointer;
  user-select: none;
}

.membership-card {
  position: relative;
  width: 100%;
  height: 100%;
  transform-style: preserve-3d;
  transition: transform 0.5s cubic-bezier(0.34, 1.56, 0.64, 1);
  border-radius: 16px;
}

.membership-card.is-flipped {
  transform: rotateY(180deg) !important;
}

.card-face {
  position: absolute;
  inset: 0;
  backface-visibility: hidden;
  border-radius: 16px;
  overflow: hidden;
}

/* ── 正面样式 ── */
.card-front {
  display: flex;
  flex-direction: column;
  padding: 16px 20px;
  box-shadow:
    0 8px 32px -8px rgba(0, 0, 0, 0.15),
    0 2px 8px -2px rgba(0, 0, 0, 0.08),
    inset 0 1px 0 rgba(255, 255, 255, 0.4);
}

/* ── 表层质感（水印 / 受光 / 噪点，均位于文字之下）── */
.surf {
  position: absolute;
  inset: 0;
  pointer-events: none;
  border-radius: 16px;
}
/* 超大同色母题水印，随卡尺寸自适应、出血到右下角 */
.surf-watermark {
  z-index: 1;
  display: flex;
  align-items: flex-end;
  justify-content: flex-end;
  overflow: hidden;
}
.surf-watermark svg {
  height: 108%;
  width: auto;
  aspect-ratio: 1 / 1;
  transform: translate(22%, 24%);
  display: block;
}
.card-monthly .surf-watermark { color: #fff; opacity: 0.11; }
.card-yearly .surf-watermark { color: #fff; opacity: 0.12; }

/* 受光：定向高光 + 一道镜面光带 + 极淡暗角 + 发丝亮边（整体偏弱） */
.surf-light {
  z-index: 2;
  background:
    radial-gradient(120% 85% at 16% 8%, rgba(255, 255, 255, 0.3), rgba(255, 255, 255, 0) 42%),
    linear-gradient(115deg, transparent 40%, rgba(255, 255, 255, 0.12) 49%, rgba(255, 255, 255, 0.02) 56%, transparent 64%),
    radial-gradient(130% 120% at 50% 40%, transparent 60%, rgba(0, 0, 0, 0.06));
  box-shadow:
    inset 0 0 0 1px rgba(255, 255, 255, 0.32),
    inset 0 -12px 26px -20px rgba(0, 0, 0, 0.2);
}
/* 星耀为彩色面，白光更显——进一步压低光感预算 */
.card-yearly .surf-light { opacity: 0.6; }

/* 细噪点：消除色带、增加纸/金属肌理 */
.surf-noise {
  z-index: 3;
  opacity: 0.45;
  mix-blend-mode: soft-light;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
}

/* 文字内容抬到质感层之上；扫光层置于最顶 */
.card-front > .card-stripe { z-index: 4; }
.card-front > .card-brand,
.card-front > .card-icon-wrapper,
.card-front > .card-name-section,
.card-front > .card-footer { position: relative; z-index: 4; }
.card-front > .card-shimmer { z-index: 5; }

.card-monthly {
  /* 冷调铂金/银 */
  background: linear-gradient(135deg, #eef1f3 0%, #e2e7ea 45%, #cfd6db 100%);
  border: 1px solid rgba(160, 170, 178, 0.45);
}

.card-yearly {
  /* 雾面紫罗兰：降低强度预算（明度落差 ~14、饱和收敛），与皓月同档、无金 */
  background: linear-gradient(135deg, #efe8f4 0%, #e0d3ea 50%, #cbb6dd 100%);
  border: 1px solid rgba(170, 140, 198, 0.45);
}

/* 顶部装饰线 */
.card-stripe {
  position: absolute;
  top: 0;
  left: 20px;
  right: 20px;
  height: 3px;
  border-radius: 0 0 2px 2px;
  opacity: 0.6;
}

.card-monthly .card-stripe {
  background: linear-gradient(90deg, transparent, #a0a0a0, transparent);
}

.card-yearly .card-stripe {
  background: linear-gradient(90deg, transparent, #c9a0e8, transparent);
}

/* 博文·星月卡标志 */
.card-brand {
  display: flex;
  align-items: center;
  margin-bottom: 8px;
}

.brand-text {
  font-family: var(--font-display);
  font-weight: 700;
  letter-spacing: 0.08em;
}

.card-monthly .brand-text {
  color: #7a756e;
  opacity: 0.7;
}

.card-yearly .brand-text {
  color: #5c3d7a;
  opacity: 0.7;
}

/* 中央图标（增大版） */
.card-icon-wrapper {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 16px auto 6px;
  border-radius: 50%;
}

.card-icon-glow {
  position: absolute;
  inset: -8px;
  border-radius: 50%;
  opacity: 0.15;
  filter: blur(12px);
}

.card-monthly .card-icon-glow {
  background: radial-gradient(circle, #a0a0a0 0%, transparent 70%);
}

.card-yearly .card-icon-glow {
  background: radial-gradient(circle, #c9a0e8 0%, transparent 70%);
}

.card-icon {
  position: relative;
  z-index: 1;
}

.card-monthly .card-icon {
  color: #8f9aa3;
}

.card-yearly .card-icon {
  color: #7b4da8;
}

/* 卡片名称区域 */
.card-name-section {
  text-align: center;
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}

.card-name {
  font-family: var(--font-display);
  font-weight: 700;
  letter-spacing: 0.06em;
}

.card-monthly .card-name {
  color: #5c5852;
}

.card-yearly .card-name {
  color: #4a2070;
}

/* 底部 */
.card-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  opacity: 0.7;
  padding-top: 8px;
  border-top: 1px solid rgba(0, 0, 0, 0.06);
}

.card-monthly .card-footer {
  color: #8a8580;
}

.card-yearly .card-footer {
  color: #6a3d8a;
}

.card-footer-no {
  font-family: var(--font-body);
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.04em;
}

/* 持卡人名字 */
.card-footer-holder {
  font-family: var(--font-display);
  font-weight: 600;
  letter-spacing: 0.02em;
}

.card-footer-expires {
  font-family: var(--font-body);
}

/* 底部价格强调文本 */
.card-footer-price {
  font-family: var(--font-display);
  font-weight: 700;
  font-size: 1.15em;
  letter-spacing: 0.02em;
  color: #5c5852;
}

.card-footer-price-yearly {
  color: var(--premium-gold-strong);
}

.card-footer-original {
  font-family: var(--font-display);
  text-decoration: line-through;
  opacity: 0.45;
}

/* 卡片下方价格标签 */
.card-price-label {
  display: flex;
  align-items: baseline;
  gap: 6px;
}

.card-price-value {
  font-family: var(--font-display);
  font-weight: 700;
  font-size: 1rem;
  color: #5c5852;
}

.card-price-value-yearly {
  color: #7b4da8;
}

.card-price-original {
  font-family: var(--font-body);
  font-size: 0.75rem;
  text-decoration: line-through;
  opacity: 0.45;
  color: var(--ink-soft);
}

/* 闪光动画 */
.card-shimmer {
  position: absolute;
  inset: 0;
  background: linear-gradient(
    105deg,
    transparent 40%,
    rgba(255, 255, 255, 0.15) 50%,
    transparent 60%
  );
  background-size: 200% 100%;
  animation: shimmer-sweep 2s ease-in-out 1;
  pointer-events: none;
  border-radius: 16px;
}

@keyframes shimmer-sweep {
  0% { background-position: 200% center; }
  100% { background-position: -200% center; }
}

/* ── 背面样式 ── */
.card-back {
  transform: rotateY(180deg);
  display: flex;
  align-items: stretch;
  justify-content: center;
  padding: 16px 18px;
  box-shadow:
    0 8px 32px -8px rgba(0, 0, 0, 0.15),
    inset 0 1px 0 rgba(255, 255, 255, 0.4);
}

.card-monthly-back {
  /* 与正面同一冷调铂金/银，略提亮以便阅读权益与输入 */
  background: linear-gradient(135deg, #f3f5f6 0%, #e8ecef 45%, #dde3e7 100%);
  border: 1px solid rgba(160, 170, 178, 0.4);
}

.card-yearly-back {
  /* 与正面同一雾面紫罗兰，略提亮 */
  background: linear-gradient(135deg, #f4eef8 0%, #e7dcf1 45%, #d7c6e6 100%);
  border: 1px solid rgba(170, 140, 198, 0.4);
}

/* 背面同样叠一层极淡噪点，保持正反材质一致 */
.card-back::after {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: 16px;
  pointer-events: none;
  opacity: 0.4;
  mix-blend-mode: soft-light;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
}
.back-content { position: relative; z-index: 1; }

.back-content {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
}

.back-header {
  display: flex;
  align-items: center;
  gap: 6px;
  font-family: var(--font-display);
  font-weight: 700;
  margin-bottom: 10px;
  padding-bottom: 7px;
  border-bottom: 1px solid rgba(0, 0, 0, 0.06);
}

.card-monthly-back .back-header {
  color: #5c5852;
}

.card-yearly-back .back-header {
  color: #4a2070;
}

.back-icon {
  flex-shrink: 0;
}

.back-benefits {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.back-benefits li {
  display: flex;
  align-items: center;
  gap: 8px;
}

.card-monthly-back .back-benefits li {
  color: #6a6560;
}

.card-yearly-back .back-benefits li {
  color: #5c3a80;
}

.benefit-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  flex-shrink: 0;
}

.card-monthly-back .benefit-dot {
  background: #a0a0a0;
}

.card-yearly-back .benefit-dot {
  background: #b07dd6;
}

/* ── 背面内嵌兑换码（无边框：仅底部细线作为输入提示）── */
.back-redeem {
  margin-top: auto;       /* 贴卡片底部 */
  padding-top: 9px;
  cursor: default;
}

.back-redeem-row {
  display: flex;
  align-items: center;
  gap: 7px;
  padding-bottom: 4px;
  border-bottom: 1px solid rgba(0, 0, 0, 0.18);
  transition: border-color 0.2s ease;
}
.back-redeem-row:focus-within {
  border-bottom-color: currentColor;
}

.back-redeem-icon {
  flex-shrink: 0;
  opacity: 0.6;
}

.back-redeem-input {
  flex: 1;
  min-width: 0;
  border: none;
  background: transparent;
  outline: none;
  font-family: var(--font-body);
  font-size: 0.78rem;
  letter-spacing: 0.04em;
  color: inherit;
  padding: 1px 0;
}
.back-redeem-input::placeholder {
  color: currentColor;
  opacity: 0.45;
  letter-spacing: 0.02em;
}
.back-redeem-input:disabled {
  opacity: 0.6;
}

.back-redeem-btn {
  flex-shrink: 0;
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  border: none;
  border-radius: 50%;
  cursor: pointer;
  color: #fff;
  transition: opacity 0.2s ease, transform 0.15s ease;
}
.back-redeem-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.back-redeem-btn:not(:disabled):active {
  transform: scale(0.9);
}

.card-monthly-back .back-redeem,
.card-monthly-back .back-redeem-icon {
  color: #6a6560;
}
.card-monthly-back .back-redeem-btn {
  background: linear-gradient(180deg, #9a948c 0%, #7a756e 100%);
}

.card-yearly-back .back-redeem,
.card-yearly-back .back-redeem-icon {
  color: #5c3a80;
}
.card-yearly-back .back-redeem-btn {
  background: linear-gradient(180deg, #9b72bf 0%, #7b4da8 100%);
}

.back-redeem-spin {
  animation: back-redeem-spin 0.8s linear infinite;
}
@keyframes back-redeem-spin {
  to { transform: rotate(360deg); }
}
</style>
