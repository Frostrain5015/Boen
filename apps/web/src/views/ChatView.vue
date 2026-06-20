<script setup lang="ts">
import { useChatStore } from '@/stores/chat';
import { useUiStore } from '@/stores/ui';
import AppHeader from '@/components/layout/AppHeader.vue';
import ChatMessages from '@/components/chat/ChatMessages.vue';
import InputArea from '@/components/chat/InputArea.vue';

const chatStore = useChatStore();
const uiStore = useUiStore();
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <!-- 类课堂跑马灯 - 独立 DOM 元素，不受 scoped 伪元素限制 -->
    <div v-if="uiStore.sessionActive" class="session-beam"></div>
    <AppHeader />
    <ChatMessages />
    <InputArea />
  </div>
</template>

<style>
/* ── 跑马灯边框特效（全局样式，避免 scoped 编译问题） ── */
.session-beam {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  height: 2px;
  z-index: 9999;
  pointer-events: none;
  background: linear-gradient(90deg,
    transparent 0%,
    rgba(212, 160, 83, 0.2) 15%,
    #d4a053 40%,
    rgba(212, 160, 83, 0.6) 60%,
    rgba(212, 160, 83, 0.15) 80%,
    transparent 100%
  );
  background-size: 200% 100%;
  animation: scan-beam 3.5s cubic-bezier(0.5, 0, 0.5, 1) infinite;
}

@keyframes scan-beam {
  0%   { background-position: 200% 0; opacity: 0.2; }
  15%  { opacity: 1; }
  45%  { background-position: -20% 0; }
  55%  { background-position: -20% 0; opacity: 0.8; }
  85%  { opacity: 0.2; }
  100% { background-position: -100% 0; opacity: 0.1; }
}
</style>
