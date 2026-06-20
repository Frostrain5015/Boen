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
    <!-- 类课堂跑马灯 + 步骤进度条：Teleport 到 body，避免 App.vue overflow-hidden 裁切 fixed 元素 -->
    <Teleport to="body">
      <div v-if="uiStore.sessionActive" class="session-beam"></div>
      <Transition name="todo-fade">
        <div v-if="uiStore.sessionActive && chatStore.todoProgress" class="todo-progress-bar">
          <div class="todo-progress-inner">
            <span class="todo-step-label">{{ chatStore.todoProgress.detail }}</span>
            <div class="todo-track">
              <div class="todo-fill" :style="{ width: `${(chatStore.todoProgress.completed / 5) * 100}%` }"></div>
            </div>
            <span class="todo-count">{{ chatStore.todoProgress.completed }} / 5</span>
          </div>
        </div>
      </Transition>
    </Teleport>
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

/* ── 类课堂步骤进度条 ── */
.todo-progress-bar {
  position: fixed;
  top: 2px;
  left: 0;
  right: 0;
  z-index: 9998;
  pointer-events: none;
  display: flex;
  justify-content: center;
  padding: 6px 16px 0;
}
.todo-progress-inner {
  display: flex;
  align-items: center;
  gap: 8px;
  background: rgba(255,255,255,0.85);
  backdrop-filter: blur(8px);
  border: 1px solid rgba(212,160,83,0.25);
  border-radius: 20px;
  padding: 4px 14px;
  pointer-events: auto;
  box-shadow: 0 1px 4px rgba(0,0,0,0.06);
}
.todo-step-label {
  font-size: 11px;
  font-weight: 500;
  color: #8b6914;
  white-space: nowrap;
}
.todo-track {
  width: 60px;
  height: 4px;
  background: #f0e6d0;
  border-radius: 2px;
  overflow: hidden;
}
.todo-fill {
  height: 100%;
  background: #d4a053;
  border-radius: 2px;
  transition: width 0.6s cubic-bezier(0.4, 0, 0.2, 1);
}
.todo-count {
  font-size: 11px;
  font-weight: 600;
  color: #b8860b;
  font-variant-numeric: tabular-nums;
}
.todo-fade-enter-active, .todo-fade-leave-active {
  transition: opacity 0.3s, transform 0.3s;
}
.todo-fade-enter-from, .todo-fade-leave-to {
  opacity: 0;
  transform: translateY(-8px);
}
</style>
