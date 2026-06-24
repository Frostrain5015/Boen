<script setup lang="ts">
import { useChatStore } from '@/stores/chat';
import SubjectSwitcher from './SubjectSwitcher.vue';

const chatStore = useChatStore();
</script>

<template>
  <header
    class="flex items-center gap-3 px-5 py-3.5"
    :class="chatStore.hasItems ? 'pl-18' : ''"
  >
    <div class="leading-tight">
      <!-- 双层渐变：下层固定色，上层随学科 accent 交叉淡变（与侧边栏品牌字一致） -->
      <h1 class="relative inline-block text-2xl font-bold tracking-tight">
        <span class="brand-text-bg">博文 Boen</span>
        <span class="brand-text-overlay">博文 Boen</span>
      </h1>
      <p class="text-xs font-semibold text-[var(--ink-soft)]">AI 原生时代的教育智能体</p>
    </div>

    <div class="ml-auto flex items-center gap-3" data-tour="subject">
      <SubjectSwitcher />
    </div>
  </header>
</template>
