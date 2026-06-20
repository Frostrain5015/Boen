<script setup lang="ts">
import { ref, computed, watch } from 'vue';

const props = defineProps<{ score: number; sigma?: number; animateFrom?: number }>();
const uid = 'st' + Math.random().toString(36).slice(2, 6);

const displayScore = ref(props.animateFrom ?? props.score);

watch(() => props.score, (newVal) => {
  if (props.animateFrom !== undefined) {
    const from = props.animateFrom;
    const duration = 800;
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

/** 线性映射：score ∈ [0,100] → stars ∈ [0,5]，半步长 */
function starVal(s: number): number {
  if (s < 0) return 0;
  return Math.round(Math.max(0, s) / 10) / 2;
}

/** 是否无数据（从未练习） */
const noData = computed(() => props.score < 0);

/** 金色填充透明度：sigma ∈ [3,25] → opacity [0.95, 0.55] */
const fillOpacity = computed(() => {
  if (noData.value) return 0;
  if (props.sigma == null) return 1;
  return Math.max(0.55, 1 - 0.4 * Math.min(props.sigma, 25) / 25);
});

const FILL_GOLD = '#d4a053';
</script>

<template>
  <span class="inline-flex gap-px">
    <svg v-for="i in 5" :key="i" class="h-3 w-3" viewBox="0 0 20 20" style="overflow: visible">
      <defs v-if="!noData">
        <clipPath :id="uid + '-cp-' + i">
          <rect x="0" y="0" :width="Math.max(0, Math.min(20, (starVal(displayScore) - (i - 1)) * 20))" height="20"
            style="transition: width 0.8s cubic-bezier(0.34, 1.56, 0.64, 1);" />
        </clipPath>
      </defs>
      <!-- 未填充/灰底 -->
      <path d="M10 1l2.2 4.6 5.1.7-3.7 3.6.9 5.1L10 12.7l-4.5 2.3.9-5.1L2.7 6.3l5.1-.7z" fill="#e0dcd3" />
      <!-- 填充层：无数据时全灰，有数据时金色+透明度 -->
      <path v-if="!noData" :clip-path="'url(#' + uid + '-cp-' + i + ')'"
        d="M10 1l2.2 4.6 5.1.7-3.7 3.6.9 5.1L10 12.7l-4.5 2.3.9-5.1L2.7 6.3l5.1-.7z"
        :fill="FILL_GOLD" :opacity="fillOpacity" />
    </svg>
  </span>
</template>
