<script setup lang="ts">
import { ref, watch } from 'vue';

const props = defineProps<{ score: number; animateFrom?: number }>();
const uid = 'st' + Math.random().toString(36).slice(2, 6);

const displayScore = ref(props.animateFrom ?? props.score);

watch(() => props.score, (newVal) => {
  if (props.animateFrom !== undefined) {
    // 从 animateFrom 逐步动画到新值
    const from = props.animateFrom;
    const duration = 800; // ms
    const start = performance.now();
    function step(now: number) {
      const t = Math.min(1, (now - start) / duration);
      displayScore.value = from + (newVal - from) * t;
      if (t < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  } else {
    displayScore.value = newVal;
  }
}, { immediate: true });

function starVal(s: number): number {
  if (s < 0) return 0;
  return Math.round(5 * Math.pow(s / 100, 0.7) * 2) / 2;
}
</script>

<template>
  <span class="inline-flex gap-px">
    <svg v-for="i in 5" :key="i" class="h-3 w-3" viewBox="0 0 20 20" style="overflow: visible">
      <defs>
        <clipPath :id="uid + '-cp-' + i">
          <rect x="0" y="0" :width="Math.max(0, Math.min(20, (starVal(displayScore) - (i - 1)) * 20))" height="20"
            style="transition: width 0.8s cubic-bezier(0.34, 1.56, 0.64, 1);" />
        </clipPath>
      </defs>
      <path d="M10 1l2.2 4.6 5.1.7-3.7 3.6.9 5.1L10 12.7l-4.5 2.3.9-5.1L2.7 6.3l5.1-.7z" fill="#e0dcd3" />
      <path :clip-path="'url(#' + uid + '-cp-' + i + ')'" d="M10 1l2.2 4.6 5.1.7-3.7 3.6.9 5.1L10 12.7l-4.5 2.3.9-5.1L2.7 6.3l5.1-.7z"
        :fill="score >= 80 ? '#d4a053' : score >= 60 ? '#e0a92e' : score >= 40 ? '#f59e42' : '#f2557a'" />
    </svg>
  </span>
</template>
