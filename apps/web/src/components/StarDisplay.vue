<script setup lang="ts">
defineProps<{ score: number }>();

function stars(s: number): number {
  if (s < 0) return 0;
  return Math.round((s / 10) * 2) / 2;
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
