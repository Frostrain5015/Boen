<script setup lang="ts">
import { useChatStore } from '@/stores/chat';

const chatStore = useChatStore();
</script>

<template>
  <header
    class="flex items-center gap-3 px-5 py-3.5"
    :class="chatStore.hasItems ? 'pl-18' : ''"
  >
    <div class="leading-tight">
      <h1 class="brand-text text-2xl font-bold tracking-tight">博文 Boen</h1>
      <p class="text-xs font-semibold text-[var(--ink-soft)]">你的学习小伙伴</p>
    </div>
  </header>
</template>
