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
      top: '14px',
      left: uiStore.sidebarOpen ? '276px' : '20px',
    }"
  >
    <Mascot :size="46" :state="chatStore.mascotState" :float="true" :animated="true" class="mascot-corner-cycle" />
  </div>

  <!-- Floating mascot (bottom-right) -->
  <div
    v-if="chatStore.hasItems"
    class="fixed bottom-16 right-5 z-20 transition-all duration-500"
    :class="chatStore.busy ? 'opacity-100 translate-y-0' : 'opacity-90 translate-y-1'"
  >
    <div class="relative drop-shadow-[0_12px_20px_rgba(86,64,40,0.28)]">
      <Mascot :size="96" :float="true" :limbs="true" :state="chatStore.mascotState" />
    </div>
  </div>
</template>
