<script setup lang="ts">
import { ref, computed } from 'vue';
import { Moon, Star, Sparkles } from 'lucide-vue-next';

interface Props {
  type: 'monthly' | 'yearly';
  expiresAt?: number | null;
  holderName?: string;
  showBack?: boolean;
  size?: 'sm' | 'md' | 'lg';
  /** 是否在卡面上显示价格（广告页显示，已有卡不显示） */
  showPrice?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  expiresAt: null,
  holderName: '',
  showBack: false,
  size: 'md',
  showPrice: true,
});

const isFlipped = ref(props.showBack);
const cardRef = ref<HTMLDivElement | null>(null);

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

defineExpose({ flip, isFlipped });
</script>

<template>
  <div class="membership-card-outer">
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
        <div class="card-shimmer" />
      </div>

      <!-- 背面 -->
      <div class="card-face card-back" :class="isMonthly ? 'card-monthly-back' : 'card-yearly-back'">
        <div class="back-content">
          <div class="back-header" :class="fontSizes[size].subtitle">
            <Sparkles class="back-icon" :size="14" />
            {{ cardName }}权益
          </div>
          <ul class="back-benefits" :class="fontSizes[size].desc">
            <li><span class="benefit-dot" />DeepSeek V4 Pro 大模型</li>
            <li><span class="benefit-dot" />考试与全题型练习</li>
            <li><span class="benefit-dot" />错题本智能归因</li>
            <li><span class="benefit-dot" />学习诊断报告</li>
          </ul>
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

.card-monthly {
  background: linear-gradient(135deg, #f0ebe6 0%, #e8e4e0 40%, #ddd8d3 100%);
  border: 1px solid rgba(180, 175, 170, 0.4);
}

.card-yearly {
  background: linear-gradient(135deg, #f5e6c8 0%, #e8d4a8 30%, #d4a853 70%, #b8862d 100%);
  border: 1px solid rgba(184, 134, 45, 0.4);
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
  background: linear-gradient(90deg, transparent, #f5d89a, transparent);
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
  color: #5c3d0e;
  opacity: 0.7;
}

/* 中央图标（增大版） */
.card-icon-wrapper {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0 auto 6px;
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
  background: radial-gradient(circle, #f5d89a 0%, transparent 70%);
}

.card-icon {
  position: relative;
  z-index: 1;
}

.card-monthly .card-icon {
  color: #8a8580;
}

.card-yearly .card-icon {
  color: #8b6914;
}

/* 卡片名称区域 */
.card-name-section {
  text-align: center;
  margin-bottom: auto;
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
  color: #4a3508;
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
  color: #7a5c1a;
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
  color: var(--premium-gold-strong);
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
  animation: shimmer-sweep 4s ease-in-out infinite;
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
  align-items: center;
  justify-content: center;
  padding: 20px;
  box-shadow:
    0 8px 32px -8px rgba(0, 0, 0, 0.15),
    inset 0 1px 0 rgba(255, 255, 255, 0.4);
}

.card-monthly-back {
  background: linear-gradient(135deg, #f5f0ea 0%, #ebe6e0 100%);
  border: 1px solid rgba(180, 175, 170, 0.4);
}

.card-yearly-back {
  background: linear-gradient(135deg, #fdf3e0 0%, #f5e6c8 100%);
  border: 1px solid rgba(184, 134, 45, 0.4);
}

.back-content {
  width: 100%;
}

.back-header {
  display: flex;
  align-items: center;
  gap: 6px;
  font-family: var(--font-display);
  font-weight: 700;
  margin-bottom: 12px;
  padding-bottom: 8px;
  border-bottom: 1px solid rgba(0, 0, 0, 0.06);
}

.card-monthly-back .back-header {
  color: #5c5852;
}

.card-yearly-back .back-header {
  color: #4a3508;
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
  gap: 6px;
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
  color: #5c4a1a;
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
  background: #c9a04b;
}
</style>
