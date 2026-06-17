<script setup lang="ts">
import { computed } from 'vue';

export type MascotState = 'idle' | 'thinking' | 'listening' | 'happy' | 'surprise' | 'sleepy';

interface Props {
  size?: number;
  float?: boolean;
  state?: MascotState;
}

const { size = 64, float = true, state = 'idle' } = defineProps<Props>();

const stateClass = computed(() => `state-${state}`);
</script>

<template>
  <div
    class="mascot"
    :class="[float && 'floaty', stateClass]"
    :style="{ width: size + 'px', height: size + 'px', color: 'var(--accent)' }"
    aria-hidden="true"
  >
    <svg viewBox="0 0 100 100" :width="size" :height="size">
      <defs>
        <radialGradient id="bodyShine" cx="35%" cy="30%" r="75%">
          <stop offset="0%" stop-color="#ffffff" stop-opacity="0.55" />
          <stop offset="55%" stop-color="#ffffff" stop-opacity="0" />
        </radialGradient>
      </defs>

      <!-- 身体 -->
      <circle cx="50" cy="56" r="34" fill="currentColor" />
      <circle cx="50" cy="56" r="34" fill="url(#bodyShine)" />

      <!-- 腮红 -->
      <ellipse cx="32" cy="62" rx="6" ry="4" fill="#ffffff" opacity="0.45" />
      <ellipse cx="68" cy="62" rx="6" ry="4" fill="#ffffff" opacity="0.45" />

      <!-- 眼睛（会眨） -->
      <g class="eyes">
        <ellipse cx="40" cy="52" rx="6.5" ry="7.5" fill="#fffdf9" />
        <ellipse cx="60" cy="52" rx="6.5" ry="7.5" fill="#fffdf9" />
        <circle cx="41.5" cy="53" r="3.4" fill="#2c2722" />
        <circle cx="61.5" cy="53" r="3.4" fill="#2c2722" />
        <circle cx="43" cy="51.5" r="1.1" fill="#fffdf9" />
        <circle cx="63" cy="51.5" r="1.1" fill="#fffdf9" />
      </g>

      <!-- 微笑 -->
      <path d="M42 66 Q50 72 58 66" stroke="#2c2722" stroke-width="2.4" stroke-linecap="round" fill="none" />

      <!-- 学士帽 -->
      <g class="cap">
        <rect x="40" y="20" width="20" height="9" rx="2" fill="#2c2722" />
        <polygon points="50,12 76,22 50,32 24,22" fill="#37322c" />
        <polygon points="50,14 70,22 50,30 30,22" fill="#2c2722" />
        <circle cx="50" cy="22" r="2.4" fill="currentColor" />
        <path d="M50 22 L70 22 L70 34" stroke="#2c2722" stroke-width="1.6" fill="none" />
        <circle cx="70" cy="35" r="2.6" fill="currentColor" class="tassel" />
      </g>
    </svg>
  </div>
</template>

<style scoped>
.mascot {
  display: inline-grid;
  place-items: center;
  transition: transform 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);
}

.eyes {
  transform-box: fill-box;
  transform-origin: center;
  animation: blink 5.5s ease-in-out infinite;
}

.tassel {
  animation: floaty 4s ease-in-out infinite;
  transform-box: fill-box;
  transform-origin: top center;
}

/* ── 状态动画 ──────────────────────────────── */

/* idle: 轻微呼吸 */
.state-idle {
  animation: breathe 3s ease-in-out infinite;
}

/* thinking: 左右摇摆 */
.state-thinking {
  animation: wobble 1.2s ease-in-out infinite;
}
.state-thinking .eyes {
  animation: blink 2s ease-in-out infinite;
}

/* listening: 轻微上下浮动 */
.state-listening {
  animation: bob 1.5s ease-in-out infinite;
}

/* happy: 弹跳 */
.state-happy {
  animation: bounce 0.6s cubic-bezier(0.34, 1.56, 0.64, 1) infinite;
}
.state-happy .eyes {
  animation: squint 0.6s ease-in-out infinite;
}

/* surprise: 快速缩放 */
.state-surprise {
  animation: pop 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);
}

/* sleepy: 缓慢下沉 */
.state-sleepy {
  animation: sink 4s ease-in-out infinite;
}
.state-sleepy .eyes {
  animation: blink 8s ease-in-out infinite;
}

/* ── 关键帧 ────────────────────────────────── */
@keyframes blink {
  0%, 92%, 100% { transform: scaleY(1); }
  96% { transform: scaleY(0.1); }
}

@keyframes floaty {
  0%, 100% { transform: translateY(0) rotate(-2deg); }
  50% { transform: translateY(-9px) rotate(2deg); }
}

@keyframes breathe {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.03); }
}

@keyframes wobble {
  0%, 100% { transform: rotate(-3deg); }
  50% { transform: rotate(3deg); }
}

@keyframes bob {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-4px); }
}

@keyframes bounce {
  0%, 100% { transform: translateY(0) scale(1); }
  40% { transform: translateY(-8px) scale(1.05); }
  60% { transform: translateY(-2px) scale(0.98); }
}

@keyframes squint {
  0%, 100% { transform: scaleY(1); }
  50% { transform: scaleY(0.6); }
}

@keyframes pop {
  0% { transform: scale(0.8); }
  50% { transform: scale(1.1); }
  100% { transform: scale(1); }
}

@keyframes sink {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(3px); }
}
</style>
