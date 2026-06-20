<script setup lang="ts">
import { useUiStore } from '@/stores/ui';

const uiStore = useUiStore();
</script>

<template>
  <div v-if="!uiStore.isCollege" class="clay-sm relative flex bg-[var(--surface)] p-1">
    <span
      class="absolute top-1 bottom-1 left-1 rounded-[14px] bg-accent transition-[transform] duration-500"
      :style="{
        width: `${100 / uiStore.availableSubjects.length}%`,
        transform: `translateX(${uiStore.subjectIndex * 100}%)`,
        transitionTimingFunction: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
      }"
    ></span>
    <button
      v-for="s in uiStore.availableSubjects"
      :key="s.value"
      @click="uiStore.handleSubjectChange(s.value)"
      class="relative z-10 flex flex-1 items-center justify-center gap-1 rounded-[14px] py-1.5 font-display text-sm font-semibold transition-colors duration-300 cursor-pointer"
      :class="uiStore.subject === s.value ? 'text-white' : 'text-[var(--ink-soft)] hover:text-[var(--ink)]'"
    >
      <span>{{ s.emoji }}</span>{{ s.label }}
    </button>
  </div>
</template>
