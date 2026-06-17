<script setup lang="ts">
withDefaults(defineProps<{ size?: number; float?: boolean }>(), { size: 64, float: true });
</script>

<template>
  <div
    class="mascot"
    :class="{ floaty: float }"
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
.mascot { display: inline-grid; place-items: center; }
.eyes {
  transform-box: fill-box;
  transform-origin: center;
  animation: blink 5.5s ease-in-out infinite;
}
.tassel { animation: floaty 4s ease-in-out infinite; transform-box: fill-box; transform-origin: top center; }
</style>
