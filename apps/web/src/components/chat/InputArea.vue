<script setup lang="ts">
import { nextTick, onMounted, computed, ref } from 'vue';
import { Send, Sparkles, GraduationCap, BookOpen, Target, PenTool, Mic, ListChecks, CheckCircle, XCircle, Loader2 } from 'lucide-vue-next';
import { useChatStore } from '@/stores/chat';
import { useAuthStore } from '@/stores/auth';
import { useUiStore } from '@/stores/ui';
import DailyLimitBanner from '@/components/DailyLimitBanner.vue';
import { useVoiceInput } from '@/composables/useVoiceInput';
import Mascot from '@/components/Mascot.vue';

const chatStore = useChatStore();
const uiStore = useUiStore();
const authStore = useAuthStore();
const { speechSupported, voiceListening, voiceButtonLabel, toggleVoiceInput, initVoiceSupport } = useVoiceInput();

let _inputEl: HTMLTextAreaElement | null = null;
function setInputEl(el: unknown) {
  _inputEl = el instanceof HTMLTextAreaElement ? el : null;
}
function focusInput() { nextTick(() => _inputEl?.focus()); }

const practiceBtnRef = ref<HTMLElement | null>(null);
const practiceMenuStyle = computed(() => {
  const btn = practiceBtnRef.value;
  if (!btn) return null;
  const rect = btn.getBoundingClientRect();
  return {
    left: rect.left + 'px',
    bottom: (window.innerHeight - rect.top) + 'px',
    minWidth: '140px',
  };
});

// ── 课堂进度 todo 浮层定位（从按钮左上方向上弹出，Teleport 到 body 避免裁切）──
const todoBtnRef = ref<HTMLElement | null>(null);
const todoPanelStyle = computed(() => {
  // 依赖 todoPanelOpen 触发重算，确保每次打开都读取最新按钮位置
  if (!uiStore.todoPanelOpen) return null;
  const btn = todoBtnRef.value;
  if (!btn) return null;
  const rect = btn.getBoundingClientRect();
  return {
    left: rect.left + 'px',
    bottom: (window.innerHeight - rect.top + 8) + 'px',
    width: 'min(20rem, calc(100vw - 2rem))',
  };
});

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    chatStore.send(chatStore.input);
  }
}

onMounted(() => {
  initVoiceSupport();
});
</script>

<template>
  <footer class="px-4 pb-4 pt-16">
    <div class="mx-auto w-full max-w-2xl">
      <!-- 学习模式按钮（大学仅通用模式，不显示） -->
      <div v-if="!uiStore.isCollege" class="mb-2 flex items-center gap-1.5 overflow-x-auto px-1" style="scrollbar-width:none;overflow-y:visible">
        <button @click="uiStore.activateMode('review')" class="flex shrink-0 items-center gap-1.5 rounded-2xl border px-3.5 py-1.5 text-xs font-semibold shadow-[0_4px_10px_-6px_rgba(86,64,40,0.2)] transition-all active:scale-[0.96]" :class="uiStore.activeMode === 'review' ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent-strong)]' : 'border-[var(--line)] bg-white/70 text-[var(--ink)] hover:border-[var(--accent)] hover:bg-[var(--accent-soft)] hover:text-[var(--accent-strong)]'"><GraduationCap class="h-3.5 w-3.5" /><span>复习巩固</span></button>
        <button @click="uiStore.activateMode('preview')" class="flex shrink-0 items-center gap-1.5 rounded-2xl border px-3.5 py-1.5 text-xs font-semibold shadow-[0_4px_10px_-6px_rgba(86,64,40,0.2)] transition-all active:scale-[0.96]" :class="uiStore.activeMode === 'preview' ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent-strong)]' : 'border-[var(--line)] bg-white/70 text-[var(--ink)] hover:border-[var(--accent)] hover:bg-[var(--accent-soft)] hover:text-[var(--accent-strong)]'"><BookOpen class="h-3.5 w-3.5" /><span>预习模式</span></button>
        <button @click="uiStore.activateMode('weakness')" class="flex shrink-0 items-center gap-1.5 rounded-2xl border px-3.5 py-1.5 text-xs font-semibold shadow-[0_4px_10px_-6px_rgba(86,64,40,0.2)] transition-all active:scale-[0.96]" :class="uiStore.activeMode === 'weakness' ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent-strong)]' : 'border-[var(--line)] bg-white/70 text-[var(--ink)] hover:border-[var(--accent)] hover:bg-[var(--accent-soft)] hover:text-[var(--accent-strong)]'"><Target class="h-3.5 w-3.5" /><span>集中练习</span></button>
        <!-- 专项练习 -->
        <div v-if="uiStore.practiceMenu.length" class="relative inline-block" ref="practiceBtnRef">
          <button @click="uiStore.togglePracticeMenu()" class="flex shrink-0 items-center gap-1.5 rounded-2xl border px-3.5 py-1.5 text-xs font-semibold shadow-[0_4px_10px_-6px_rgba(86,64,40,0.2)] transition-all active:scale-[0.96]" :class="uiStore.practiceMenuOpen ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent-strong)]' : 'border-[var(--line)] bg-white/70 text-[var(--ink)] hover:border-[var(--accent)] hover:bg-[var(--accent-soft)] hover:text-[var(--accent-strong)]'"><PenTool class="h-3.5 w-3.5" /><span>专项练习</span></button>
        </div>
      </div>
      <!-- 专项练习下拉菜单（Teleport 到 body 避免 overflow:hidden 裁剪） -->
      <Teleport to="body">
        <div v-if="uiStore.practiceMenuOpen && practiceMenuStyle" class="fixed z-50" :style="practiceMenuStyle" @mouseleave="uiStore.closePracticeMenu()">
          <div class="clay-sm flex flex-col gap-0.5 p-1.5 shadow-lg">
            <button v-for="p in uiStore.practiceMenu" :key="p.type" @click="uiStore.startPractice(p.type, p.hint); uiStore.closePracticeMenu(); focusInput()" class="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-xs font-medium text-[var(--ink)] transition-colors hover:bg-[var(--accent-soft)] hover:text-[var(--accent-strong)] whitespace-nowrap">{{ p.label }}</button>
          </div>
        </div>
      </Teleport>
      <DailyLimitBanner :show="chatStore.dailyLimitReached" @close="chatStore.dailyLimitReached = false" />
      <div class="relative">
        <!-- 吉祥物踩在输入框右上角 -->
        <Transition name="mascot-pop">
          <div
            v-if="chatStore.hasItems"
            class="absolute right-0 z-10 pointer-events-none select-none"
            :style="{ bottom: 'calc(100% + 6px)' }"
            :class="chatStore.busy ? 'mascot-bounce' : ''"
          >
            <Mascot :size="58" :float="true" :limbs="true" :state="chatStore.mascotState" :animated="true" />
          </div>
        </Transition>
        <div class="clay clay-glass flex items-end gap-2 p-2" :class="chatStore.dailyLimitReached ? 'opacity-50 pointer-events-none' : ''">
          <!-- 课堂进度 todo 按钮（常驻显示；不在课堂时无角标、面板显示空态） -->
          <button
            ref="todoBtnRef"
            @click="uiStore.toggleTodoPanel()"
            class="relative grid h-11 w-11 shrink-0 place-items-center self-center rounded-[18px] border transition-all active:scale-[0.96]"
            :class="uiStore.todoPanelOpen ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent-strong)]' : 'border-[var(--line)] bg-white/75 text-[var(--ink-soft)] hover:border-[var(--accent)] hover:bg-[var(--accent-soft)] hover:text-[var(--accent-strong)]'"
            :title="uiStore.hasTodoList ? `课堂进度 第${uiStore.todoProgress.current}/${uiStore.todoProgress.total}步` : '课堂进度（暂无）'"
            aria-label="课堂进度"
          >
            <ListChecks class="h-5 w-5" />
            <!-- 进度角标：当前所处阶段号 / 总步数（仅课堂中显示） -->
            <span v-if="uiStore.hasTodoList" class="absolute -right-1 -top-1 min-w-[18px] rounded-full bg-[var(--accent)] px-1 text-[10px] font-bold leading-[18px] text-white shadow-sm">{{ uiStore.todoProgress.current }}/{{ uiStore.todoProgress.total }}</span>
          </button>
          <!-- 免费用户用量环 -->
          <div
            v-if="authStore.authenticated && !authStore.isPremium"
            class="relative flex h-9 w-9 shrink-0 items-center justify-center self-center"
            :title="`今日剩余 ${authStore.dailyRemaining ?? 0} 次`"
          >
            <svg class="h-9 w-9 -rotate-90" viewBox="0 0 36 36">
              <circle cx="18" cy="18" r="15" fill="none" stroke="var(--line)" stroke-width="3" />
              <circle
                cx="18" cy="18" r="15" fill="none"
                :stroke="(authStore.dailyRemaining ?? 10) <= 3 ? 'var(--error)' : 'var(--accent)'"
                stroke-width="3" stroke-linecap="round"
                :stroke-dasharray="2 * Math.PI * 15"
                :stroke-dashoffset="2 * Math.PI * 15 * (1 - ((authStore.dailyRemaining ?? 10) / 10))"
                class="transition-all duration-500"
              />
            </svg>
            <span class="absolute text-[10px] font-bold" :style="{ color: (authStore.dailyRemaining ?? 10) <= 3 ? 'var(--error)' : 'var(--ink-soft)' }">
              {{ authStore.dailyRemaining ?? 10 }}
            </span>
          </div>
          <textarea
            :ref="setInputEl"
            v-model="chatStore.input"
            @keydown="onKeydown"
            rows="1"
            placeholder="今天想学习什么？"
            class="max-h-32 flex-1 resize-none bg-transparent px-3 py-2.5 text-[15px] placeholder:text-[var(--ink-soft)]/70 focus:outline-none"
          />
          <button
            @click="toggleVoiceInput"
            :disabled="chatStore.busy || !speechSupported"
            class="grid h-11 w-11 shrink-0 place-items-center rounded-[18px] border transition-all active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-45"
            :class="voiceListening ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent-strong)] shadow-[0_0_0_4px_var(--accent-soft)]' : 'border-[var(--line)] bg-white/75 text-[var(--ink-soft)] hover:border-[var(--accent)] hover:bg-[var(--accent-soft)] hover:text-[var(--accent-strong)]'"
            :aria-label="voiceButtonLabel"
            :aria-pressed="voiceListening"
            :title="voiceButtonLabel"
          >
            <Mic class="h-5 w-5" :class="{ 'animate-pulse': voiceListening }" />
          </button>
          <span class="sr-only" aria-live="polite">{{ voiceButtonLabel }}</span>
          <button
            @click="chatStore.send(chatStore.input)"
            :disabled="chatStore.busy || !chatStore.input.trim()"
            class="btn-accent grid h-11 w-11 shrink-0 place-items-center rounded-[18px]"
            aria-label="发送"
          >
            <Sparkles v-if="chatStore.busy" class="h-5 w-5 animate-spin" />
            <Send v-else class="h-5 w-5" />
          </button>
        </div>
      </div>
    </div>

    <!-- 课堂进度浮层（Teleport 到 body，从 todo 按钮左上方弹出） -->
    <Teleport to="body">
      <Transition name="todo-panel">
        <div
          v-if="uiStore.todoPanelOpen && todoPanelStyle"
          class="fixed z-50"
          :style="todoPanelStyle"
        >
          <div class="clay-sm overflow-hidden bg-[var(--surface)] shadow-xl">
            <!-- 头部 -->
            <div class="flex items-center justify-between gap-2 border-b border-[var(--line)] px-4 py-3">
              <div class="flex items-center gap-2">
                <ListChecks class="h-4 w-4 text-[var(--accent-strong)]" />
                <span class="font-display text-sm font-bold text-[var(--ink)]">课堂进度</span>
              </div>
              <span v-if="uiStore.hasTodoList" class="text-xs font-semibold text-[var(--ink-soft)]">第 {{ uiStore.todoProgress.current }}/{{ uiStore.todoProgress.total }} 步</span>
            </div>
            <!-- 空态：未处于课堂 -->
            <div v-if="!uiStore.hasTodoList" class="px-4 py-8 text-center">
              <p class="text-sm font-medium text-[var(--ink-soft)]">当前不在课堂中</p>
              <p class="mt-1 text-xs text-[var(--ink-soft)]/70">进入复习 / 预习等学习模式后，这里会显示课堂步骤进度</p>
            </div>
            <!-- 步骤列表 -->
            <ul v-else class="max-h-[50vh] space-y-1 overflow-y-auto p-2">
              <li
                v-for="step in uiStore.todoList"
                :key="step.id"
                class="flex items-start gap-2.5 rounded-xl px-2.5 py-2 transition-colors"
                :class="step.status === 'in_progress' ? 'bg-[var(--accent-soft)]/60' : ''"
              >
                <!-- 三态图标（参考工具标签：进行中=脉冲点 / 完成=绿勾 / 失败=红叉 / 待进行=空心点） -->
                <span class="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full"
                  :class="step.status === 'completed' ? 'bg-[#d4f0dd] text-[#18a558]'
                    : step.status === 'failed' ? 'bg-[#fee2e2] text-[#dc2626]'
                    : step.status === 'in_progress' ? 'bg-[var(--accent-soft)] text-[var(--accent-strong)]'
                    : 'bg-[var(--line)]/60 text-[var(--ink-soft)]'">
                  <CheckCircle v-if="step.status === 'completed'" class="h-3.5 w-3.5" />
                  <XCircle v-else-if="step.status === 'failed'" class="h-3.5 w-3.5" />
                  <Loader2 v-else-if="step.status === 'in_progress'" class="h-3.5 w-3.5 animate-spin" />
                  <span v-else class="h-1.5 w-1.5 rounded-full bg-current opacity-60"></span>
                </span>
                <div class="min-w-0 flex-1">
                  <p class="text-[13px] leading-snug"
                    :class="step.status === 'completed' ? 'text-[var(--ink-soft)] line-through decoration-[var(--ink-soft)]/40'
                      : step.status === 'in_progress' ? 'font-semibold text-[var(--ink)]'
                      : step.status === 'failed' ? 'font-medium text-[#dc2626]'
                      : 'text-[var(--ink)]'">
                    <span class="mr-1 text-[var(--ink-soft)]">{{ step.id }}.</span>{{ step.label }}
                  </p>
                  <span v-if="step.status === 'in_progress'" class="text-[11px] font-medium text-[var(--accent-strong)]">进行中…</span>
                  <span v-else-if="step.status === 'failed'" class="text-[11px] font-medium text-[#dc2626]">未完成</span>
                </div>
              </li>
            </ul>
          </div>
        </div>
      </Transition>
    </Teleport>
    <!-- 点击外部关闭进度浮层 -->
    <Teleport to="body">
      <div v-if="uiStore.todoPanelOpen" class="fixed inset-0 z-40" @click="uiStore.closeTodoPanel()" />
    </Teleport>
  </footer>
</template>

<style scoped>
/* ── 课堂进度浮层弹入 ── */
.todo-panel-enter-active {
  transition: transform 0.25s cubic-bezier(0.34, 1.4, 0.64, 1), opacity 0.2s ease;
}
.todo-panel-leave-active {
  transition: transform 0.18s ease, opacity 0.15s ease;
}
.todo-panel-enter-from,
.todo-panel-leave-to {
  transform: translateY(8px) scale(0.96);
  opacity: 0;
}

/* ── 吉祥物弹入动画 ── */
.mascot-pop-enter-active {
  transition: transform 0.5s cubic-bezier(0.34, 1.56, 0.64, 1), opacity 0.3s ease;
}
.mascot-pop-leave-active {
  transition: transform 0.25s ease, opacity 0.2s ease;
}
.mascot-pop-enter-from {
  transform: scale(0.4) translateY(20px);
  opacity: 0;
}
.mascot-pop-leave-to {
  transform: scale(0.6) translateY(10px);
  opacity: 0;
}

/* 吉祥物忙碌时轻弹 */
.mascot-bounce {
  animation: mascot-hop 1.8s ease-in-out infinite;
}
@keyframes mascot-hop {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-5px); }
}

@media (prefers-reduced-motion: reduce) {
  .mascot-pop-enter-active,
  .mascot-pop-leave-active {
    transition: opacity 0.2s ease;
  }
  .mascot-pop-enter-from,
  .mascot-pop-leave-to {
    transform: none;
  }
  .mascot-bounce {
    animation: none;
  }
}
</style>
