<script setup lang="ts">
import { useUiStore, SUBJECT_LABELS } from '@/stores/ui';

const uiStore = useUiStore();
</script>

<template>
  <div class="clay-sm relative flex bg-[var(--surface)] p-1">
    <span
      class="absolute top-1 bottom-1 left-1 w-16 rounded-[14px] bg-accent"
      :style="{
        transform: `translateX(calc(${uiStore.subjectIndex} * 4rem))`,
        transition: 'transform 0.5s cubic-bezier(0.34, 1.56, 0.64, 1)',
      }"
    ></span>
    <button
      v-for="s in SUBJECT_LABELS"
      :key="s.value"
      @click="uiStore.handleSubjectChange(s.value)"
      class="relative z-10 flex w-16 items-center justify-center gap-1 rounded-[14px] py-1.5 font-display text-sm font-semibold transition-colors duration-300 cursor-pointer"
      :class="uiStore.subject === s.value ? 'text-white' : 'text-[var(--ink-soft)] hover:text-[var(--ink)]'"
    >
      <span>{{ s.emoji }}</span>{{ s.label }}
    </button>
  </div>
</template>
