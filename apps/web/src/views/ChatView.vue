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
  <div class="flex min-h-0 flex-1 flex-col session-wrap" :class="{ 'session-active': uiStore.sessionActive }">
    <AppHeader />
    <ChatMessages />
    <InputArea />
  </div>
</template>

<style scoped>
/* ── 跑马灯边框特效 ── */
.session-wrap {
  position: relative;
}

.session-wrap.session-active {
  box-shadow:
    inset 0 0 40px rgba(212, 160, 83, 0.03),
    0 0 30px rgba(212, 160, 83, 0.05);
}

/* 上下两条流光轨道 */
.session-wrap.session-active::before,
.session-wrap.session-active::after {
  content: '';
  position: absolute;
  pointer-events: none;
  z-index: 10;
  background: linear-gradient(90deg,
    transparent 0%,
    rgba(212, 160, 83, 0.15) 10%,
    rgba(212, 160, 83, 0.6) 25%,
    var(--accent) 45%,
    rgba(212, 160, 83, 0.6) 65%,
    rgba(212, 160, 83, 0.15) 85%,
    transparent 100%
  );
  background-size: 200% 100%;
  height: 2px;
}

/* 上边：从右向左平滑扫过 */
.session-wrap.session-active::before {
  top: 0;
  left: 0;
  right: 0;
  animation: scan-beam-top 4s cubic-bezier(0.45, 0, 0.55, 1) infinite;
}

/* 下边：从左向右平滑扫过 */
.session-wrap.session-active::after {
  bottom: 0;
  left: 0;
  right: 0;
  animation: scan-beam-bottom 4s cubic-bezier(0.45, 0, 0.55, 1) infinite;
}

@keyframes scan-beam-top {
  0%   { background-position: 200% 0; opacity: 0.1; }
  20%  { opacity: 1; }
  45%  { background-position: -50% 0; }
  55%  { background-position: -50% 0; opacity: 1; }
  80%  { opacity: 0.1; }
  100% { background-position: -100% 0; opacity: 0.05; }
}

@keyframes scan-beam-bottom {
  0%   { background-position: -100% 0; opacity: 0.05; }
  20%  { opacity: 0.1; }
  45%  { background-position: 150% 0; }
  55%  { background-position: 150% 0; opacity: 0.1; }
  80%  { opacity: 1; }
  100% { background-position: 200% 0; opacity: 0.1; }
}
</style>
