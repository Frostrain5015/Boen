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
/* ── 跑马灯（3px + 底部柔光阴影） ── */
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
    rgba(99, 110, 250, 0.3) 15%,
    #636efa 40%,
    rgba(99, 110, 250, 0.7) 60%,
    rgba(116, 185, 255, 0.2) 80%,
    transparent 100%
  );
  background-size: 200% 100%;
  animation: scan-beam 3s cubic-bezier(0.5, 0, 0.5, 1) infinite;
  box-shadow: 0 1px 12px rgba(99, 110, 250, 0.35), 0 0 4px rgba(99, 110, 250, 0.5);
}

@keyframes scan-beam {
  0%   { background-position: 200% 0; opacity: 0.4; }
  15%  { opacity: 1; }
  45%  { background-position: -20% 0; }
  55%  { background-position: -20% 0; opacity: 0.9; }
  85%  { opacity: 0.4; }
  100% { background-position: -100% 0; opacity: 0.2; }
}

/* ── 类课堂步骤进度条（全宽轨道 + 右侧步数徽章） ── */
.todo-progress-bar {
  position: fixed;
  top: 3px;
  left: 0;
  right: 0;
  z-index: 9998;
  pointer-events: none;
  display: flex;
  align-items: center;
  padding: 0;
}
.todo-progress-inner {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 5px 14px 5px 0;
  pointer-events: auto;
}
.todo-track {
  flex: 1;
  height: 3px;
  background: rgba(99, 110, 250, 0.12);
  overflow: hidden;
  border-radius: 0 2px 2px 0;
}
.todo-fill {
  height: 100%;
  background: linear-gradient(90deg, #636efa, #74b9ff);
  border-radius: 0 2px 2px 0;
  transition: width 0.7s cubic-bezier(0.4, 0, 0.2, 1);
  box-shadow: 0 0 6px rgba(99, 110, 250, 0.6);
}
.todo-step-label {
  font-size: 11px;
  font-weight: 500;
  color: #636efa;
  white-space: nowrap;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 140px;
}
.todo-count {
  font-size: 10px;
  font-weight: 700;
  color: #fff;
  background: #636efa;
  border-radius: 10px;
  padding: 1px 7px;
  letter-spacing: 0.02em;
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
  pointer-events: none;
}
.todo-fade-enter-active, .todo-fade-leave-active {
  transition: opacity 0.35s ease, transform 0.35s ease;
}
.todo-fade-enter-from, .todo-fade-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}
</style>
