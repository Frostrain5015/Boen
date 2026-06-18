<script setup lang="ts">
defineProps<{ score: number }>();

/** 非线性的星映射：低分段易涨、高分段难满 */
function stars(s: number): number {
  if (s < 0) return 0;
  // 用幂曲线让 0→0★, 50→~3★, 80→~4.2★, 95→~4.7★, 100→5★
  const raw = 5 * Math.pow(s / 100, 0.7);
  // 四舍五入到 0.5 粒度
  return Math.round(raw * 2) / 2;
}
</script>

<template>
  <span class="inline-flex gap-[1px]">
    <svg v-for="i in 5" :key="i" class="h-3 w-3" viewBox="0 0 20 20">
      <defs>
        <clipPath :id="'sc-' + i + '-' + score">
          <rect x="0" y="0" :width="Math.max(0, Math.min(20, (stars(score) - (i - 1)) * 20))" height="20" />
        </clipPath>
      </defs>
      <!-- 背景星（灰） -->
      <path d="M10 1l2.2 4.6 5.1.7-3.7 3.6.9 5.1L10 12.7l-4.5 2.3.9-5.1L2.7 6.3l5.1-.7z" fill="#e0dcd3" />
      <!-- 前景星（彩色） -->
      <path :clip-path="'url(#sc-' + i + '-' + score + ')'" d="M10 1l2.2 4.6 5.1.7-3.7 3.6.9 5.1L10 12.7l-4.5 2.3.9-5.1L2.7 6.3l5.1-.7z"
        :fill="score >= 80 ? '#18a558' : score >= 60 ? '#e0a92e' : score >= 40 ? '#f59e42' : '#f2557a'" />
    </svg>
  </span>
</template>
