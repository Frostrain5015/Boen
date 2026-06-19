<script setup lang="ts">
import { nextTick, onMounted } from 'vue';
import { Send, Sparkles, GraduationCap, BookOpen, Target, PenTool, Mic } from 'lucide-vue-next';
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
      <!-- 学习模式按钮 -->
      <div class="mb-2 flex items-center gap-1.5 px-1">
        <button @click="uiStore.activateMode('review')" class="flex items-center gap-1.5 rounded-2xl border px-3.5 py-1.5 text-xs font-semibold shadow-[0_4px_10px_-6px_rgba(86,64,40,0.2)] transition-all active:scale-[0.96]" :class="uiStore.activeMode === 'review' ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent-strong)]' : 'border-[var(--line)] bg-white/70 text-[var(--ink)] hover:border-[var(--accent)] hover:bg-[var(--accent-soft)] hover:text-[var(--accent-strong)]'"><GraduationCap class="h-3.5 w-3.5" /><span>复习巩固</span></button>
        <button @click="uiStore.activateMode('preview')" class="flex items-center gap-1.5 rounded-2xl border px-3.5 py-1.5 text-xs font-semibold shadow-[0_4px_10px_-6px_rgba(86,64,40,0.2)] transition-all active:scale-[0.96]" :class="uiStore.activeMode === 'preview' ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent-strong)]' : 'border-[var(--line)] bg-white/70 text-[var(--ink)] hover:border-[var(--accent)] hover:bg-[var(--accent-soft)] hover:text-[var(--accent-strong)]'"><BookOpen class="h-3.5 w-3.5" /><span>预习模式</span></button>
        <button @click="uiStore.activateMode('weakness')" class="flex items-center gap-1.5 rounded-2xl border px-3.5 py-1.5 text-xs font-semibold shadow-[0_4px_10px_-6px_rgba(86,64,40,0.2)] transition-all active:scale-[0.96]" :class="uiStore.activeMode === 'weakness' ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent-strong)]' : 'border-[var(--line)] bg-white/70 text-[var(--ink)] hover:border-[var(--accent)] hover:bg-[var(--accent-soft)] hover:text-[var(--accent-strong)]'"><Target class="h-3.5 w-3.5" /><span>集中练习</span></button>
        <!-- 专项练习 -->
        <div v-if="uiStore.practiceMenu.length" class="relative inline-block">
          <button @click="uiStore.togglePracticeMenu()" class="flex items-center gap-1.5 rounded-2xl border px-3.5 py-1.5 text-xs font-semibold shadow-[0_4px_10px_-6px_rgba(86,64,40,0.2)] transition-all active:scale-[0.96]" :class="uiStore.practiceMenuOpen ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent-strong)]' : 'border-[var(--line)] bg-white/70 text-[var(--ink)] hover:border-[var(--accent)] hover:bg-[var(--accent-soft)] hover:text-[var(--accent-strong)]'"><PenTool class="h-3.5 w-3.5" /><span>专项练习</span></button>
          <Transition name="fade">
            <div v-if="uiStore.practiceMenuOpen" class="absolute left-0 bottom-full z-50 mb-1 min-w-[140px]">
              <div class="clay-sm flex flex-col gap-0.5 p-1.5 shadow-lg" @mouseleave="uiStore.closePracticeMenu()">
                <button v-for="p in uiStore.practiceMenu" :key="p.type" @click="uiStore.startPractice(p.type, p.hint); focusInput()" class="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-xs font-medium text-[var(--ink)] transition-colors hover:bg-[var(--accent-soft)] hover:text-[var(--accent-strong)] whitespace-nowrap">{{ p.label }}</button>
              </div>
            </div>
          </Transition>
        </div>
      </div>
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
  </footer>
</template>

<style scoped>
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
