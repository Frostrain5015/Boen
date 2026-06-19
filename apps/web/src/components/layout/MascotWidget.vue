<script setup lang="ts">
import { useChatStore } from '@/stores/chat';
import { useUiStore } from '@/stores/ui';
import Mascot from '@/components/Mascot.vue';

const chatStore = useChatStore();
const uiStore = useUiStore();
</script>

<template>
  <!-- Corner mascot (top-left, appears when chat has items) -->
  <div
    v-if="chatStore.hasItems"
    class="fixed z-30 pointer-events-none transition-all duration-500 ease-[cubic-bezier(0.34,1.56,0.64,1)]"
    :style="{
      top: '16px',
      left: uiStore.sidebarOpen ? '280px' : '24px',
    }"
  >
    <Mascot :size="44" :state="chatStore.mascotState" :float="true" :animated="true" class="mascot-corner-cycle" />
  </div>
</template>
