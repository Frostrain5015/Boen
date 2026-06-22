<script setup lang="ts">
import { ref, computed } from 'vue';
import { Moon, Crown, Sparkles } from 'lucide-vue-next';

interface Props {
  type: 'monthly' | 'yearly';
  expiresAt?: number | null;
  showBack?: boolean;
  size?: 'sm' | 'md' | 'lg';
}

const props = withDefaults(defineProps<Props>(), {
  expiresAt: null,
  showBack: false,
  size: 'md',
});

const isFlipped = ref(props.showBack);
const cardRef = ref<HTMLDivElement | null>(null);

const isMonthly = computed(() => props.type === 'monthly');
const cardName = computed(() => (isMonthly.value ? '皓月卡' : '星耀卡'));
const cardPrice = computed(() => (isMonthly.value ? '¥18/月' : '¥188/年'));
const cardOriginalPrice = computed(() => (isMonthly.value ? '' : '原价 ¥238.8'));

const sizeClasses = {
  sm: 'w-[280px] h-[177px]',
  md: 'w-[340px] h-[214px]',
  lg: 'w-[400px] h-[252px]',
};

const fontSizes = {
  sm: { title: 'text-base', subtitle: 'text-[11px]', price: 'text-lg', desc: 'text-[10px]' },
  md: { title: 'text-lg', subtitle: 'text-xs', price: 'text-xl', desc: 'text-[11px]' },
  lg: { title: 'text-xl', subtitle: 'text-sm', price: 'text-2xl', desc: 'text-xs' },
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

        <!-- 博文标志 -->
        <div class="card-brand">
          <span class="brand-text" :class="fontSizes[size].subtitle">博文</span>
          <span class="brand-dot" />
        </div>

        <!-- 中央图标 -->
        <div class="card-icon-wrapper">
          <div class="card-icon-glow" />
          <component :is="isMonthly ? Moon : Crown" class="card-icon" :class="fontSizes[size].title" />
        </div>

        <!-- 卡片名称 -->
        <div class="card-name-section">
          <h3 class="card-name" :class="fontSizes[size].title">{{ cardName }}</h3>
          <p class="card-price" :class="fontSizes[size].price">
            {{ cardPrice }}
            <span v-if="cardOriginalPrice" class="card-original-price" :class="fontSizes[size].desc">
              {{ cardOriginalPrice }}
            </span>
          </p>
        </div>

        <!-- 底部有效期 -->
        <div class="card-footer" :class="fontSizes[size].desc">
          <span v-if="expiresAt">
            有效期至 {{ new Date(expiresAt * 1000).toLocaleDateString('zh-CN') }}
          </span>
          <span v-else>激活后生效</span>
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
          <div class="back-hint" :class="fontSizes[size].desc">
            点击翻转查看正面
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
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

/* 博文标志 */
.card-brand {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-bottom: 8px;
}

.brand-text {
  font-family: var(--font-display);
  font-weight: 700;
  letter-spacing: 0.08em;
  color: var(--ink-soft);
  opacity: 0.7;
}

.card-monthly .brand-text {
  color: #7a756e;
}

.card-yearly .brand-text {
  color: #5c3d0e;
}

.brand-dot {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: currentColor;
  opacity: 0.5;
}

/* 中央图标 */
.card-icon-wrapper {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 48px;
  height: 48px;
  margin: 0 auto 8px;
  border-radius: 50%;
}

.card-icon-glow {
  position: absolute;
  inset: -4px;
  border-radius: 50%;
  opacity: 0.15;
  filter: blur(8px);
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
  width: 28px;
  height: 28px;
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
  margin-bottom: 4px;
}

.card-monthly .card-name {
  color: #5c5852;
}

.card-yearly .card-name {
  color: #4a3508;
}

.card-price {
  font-family: var(--font-display);
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
}

.card-monthly .card-price {
  color: #7a756e;
}

.card-yearly .card-price {
  color: #6b4e0a;
}

.card-original-price {
  text-decoration: line-through;
  opacity: 0.5;
}

/* 底部有效期 */
.card-footer {
  text-align: center;
  opacity: 0.6;
  padding-top: 8px;
  border-top: 1px solid rgba(0, 0, 0, 0.06);
}

.card-monthly .card-footer {
  color: #8a8580;
}

.card-yearly .card-footer {
  color: #7a5c1a;
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

.back-hint {
  text-align: center;
  margin-top: 12px;
  opacity: 0.4;
  font-style: italic;
}

.card-monthly-back .back-hint {
  color: #8a8580;
}

.card-yearly-back .back-hint {
  color: #8b6914;
}
</style>
