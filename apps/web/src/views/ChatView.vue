<script setup lang="ts">
import { onMounted, nextTick } from 'vue';
import { useChatStore } from '@/stores/chat';
import { useUiStore } from '@/stores/ui';
import { useOnboardingStore } from '@/stores/onboarding';
import AppHeader from '@/components/layout/AppHeader.vue';
import ChatMessages from '@/components/chat/ChatMessages.vue';
import InputArea from '@/components/chat/InputArea.vue';

const chatStore = useChatStore();
const uiStore = useUiStore();
const onboarding = useOnboardingStore();

// 首次登录完成设置后进入对话页：尝试开启新手引导（仅一次）
onMounted(() => {
  nextTick(() => onboarding.maybeStart('chat'));
});
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <!-- 类课堂跑马灯：Teleport 到 body，避免 App.vue overflow-hidden 裁切 fixed 元素 -->
    <Teleport to="body">
      <div v-if="uiStore.sessionActive" class="session-beam"></div>
    </Teleport>
    <AppHeader />
    <ChatMessages />
    <InputArea />
  </div>
</template>

<style>
/* ── 跑马灯（3px + 底部柔光阴影，颜色跟随学科 accent） ── */
.session-beam {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  height: 3px;
  z-index: 9999;
  pointer-events: none;
  background: linear-gradient(90deg,
    transparent 0%,
    var(--accent-glow) 15%,
    var(--accent) 40%,
    var(--accent-glow) 60%,
    rgba(255,255,255,0.1) 80%,
    transparent 100%
  );
  background-size: 200% 100%;
  animation: scan-beam 3s cubic-bezier(0.5, 0, 0.5, 1) infinite;
  box-shadow: 0 1px 12px var(--accent-glow), 0 0 4px var(--accent-glow);
  transition: background 0.7s ease, box-shadow 0.7s ease;
}

@keyframes scan-beam {
  0%   { background-position: 200% 0; opacity: 0.4; }
  15%  { opacity: 1; }
  45%  { background-position: -20% 0; }
  55%  { background-position: -20% 0; opacity: 0.9; }
  85%  { opacity: 0.4; }
  100% { background-position: -100% 0; opacity: 0.2; }
}
</style>
