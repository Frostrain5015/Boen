<script setup lang="ts">
import { onMounted } from 'vue';
import { PencilLine, Wrench } from 'lucide-vue-next';
import { renderMarkdown } from '@/lib/markdown';
import Mascot from '@/components/Mascot.vue';
import QuestionCard from '@/components/QuestionCard.vue';
import TypingDots from '@/components/TypingDots.vue';
import { useChatStore } from '@/stores/chat';
import { useUiStore } from '@/stores/ui';
import { useScrollManagement } from '@/composables/useScrollManagement';

const chatStore = useChatStore();
const uiStore = useUiStore();
const { scroller, hasScrollOverflow, scrollDown, checkScrollOverflow } = useScrollManagement();

// Wire scroll callback into chat store
chatStore.setScrollDownCallback(scrollDown);

function formatTime() {
  return new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

// After conversation restore, re-check scroll & TikZ
onMounted(() => {
  checkScrollOverflow();
});
</script>

<template>
  <main ref="scroller" class="chat-scroller min-h-0 flex-1 overflow-y-auto px-4" :class="{ 'chat-scroll-fade': hasScrollOverflow }">
    <div class="mx-auto w-full max-w-2xl py-5">
      <!-- 欢迎页 / 消息列表：整块淡入淡出切换 -->
      <!-- 欢迎页 -->
      <div v-if="!chatStore.hasItems" class="flex flex-col items-center gap-5 pt-[8vh] text-center">
        <Mascot :size="120" :state="chatStore.mascotState" />
        <div>
          <h2 class="font-display text-2xl font-bold">嗨，我是博文！👋</h2>
          <p class="mt-1.5 text-[var(--ink-soft)]">想问什么？开始学习吧～</p>
        </div>
      </div>

      <!-- 消息列表 -->
      <div v-else v-auto-animate class="flex flex-col gap-6">
        <template v-for="(m, i) in chatStore.items" :key="i">
          <!-- 题目卡片 -->
          <QuestionCard
            v-if="m.kind === 'question'"
            :question="m.question"
            :answered="m.answered"
            :grading="m.grading"
            :user-answer="(m as any).userAnswer"
            :subject="uiStore.subject"
            @submit="(a) => chatStore.onAnswer(m, a)"
          />

          <!-- 工具卡片（pending/done/error 单一模板，仅切换 CSS 类，不重建 DOM） -->
          <div v-else-if="m.kind === 'tool_pending' || m.kind === 'tool_result' || m.kind === 'tool_error'" class="flex flex-col gap-1">
            <div class="flex items-center gap-2">
              <Mascot :size="24" :float="false" :animated="false" />
              <span class="text-xs font-semibold text-[var(--accent)]">博文</span>
            </div>
            <div class="pl-8">
              <div class="quiz-gen clay-sm"
                :class="m.kind === 'tool_result' ? 'quiz-gen-done' : m.kind === 'tool_error' ? 'quiz-gen-err' : ''">
                <div class="quiz-gen-inner">
                  <span class="quiz-gen-icon"
                    :class="m.kind === 'tool_result' ? 'quiz-gen-icon-done' : m.kind === 'tool_error' ? 'quiz-gen-icon-err' : ''">
                    <template v-if="m.kind === 'tool_error'">⚠️</template>
                    <Wrench v-else-if="m.kind === 'tool_pending'" class="h-4 w-4" />
                    <template v-else>{{ m.action === 'plan' ? '📋' : m.action === 'advance' ? '▶️' : m.action === 'query' ? '📖' : '🎓' }}</template>
                  </span>
                  <span class="quiz-gen-label">
                    <template v-if="m.kind === 'tool_pending'">{{ m.action === 'plan' ? '博文正在备课...' : m.action === 'advance' ? '正在进入下一阶段...' : m.action === 'query' ? '正在查询教材库...' : '课堂即将结束' }}</template>
                    <template v-else-if="m.kind === 'tool_result'">{{ (m as any).detail }}</template>
                    <template v-else>{{ (m as any).error }}</template>
                  </span>
                  <span class="quiz-gen-dots" :class="{ 'opacity-0': m.kind !== 'tool_pending' }"><span></span><span></span><span></span></span>
                </div>
              </div>
            </div>
          </div>

          <!-- 用户消息 -->
          <div v-else-if="m.kind === 'user'" class="flex flex-col items-end gap-1 anim-fadeUp">
            <div class="max-w-[85%] text-right">
              <p class="text-[15px] leading-relaxed text-[var(--ink)]" style="white-space: pre-wrap; word-break: break-word;">
                <span v-if="m.modeTag" class="font-semibold" :class="
                  m.modeTag.includes('集中练习') ? 'text-[#f2557a]' :
                  m.modeTag.includes('复习巩固') ? 'text-[#18a558]' :
                  m.modeTag.includes('预习') ? 'text-[#2b5fa8]' :
                  'text-[var(--accent-strong)]'
                ">{{ m.modeTag }}</span>{{ m.text }}
              </p>
              <span class="mt-1 inline-block text-[10px] text-[var(--ink-soft)]/60">{{ formatTime() }}</span>
            </div>
          </div>

          <!-- 助手消息 -->
          <div v-else-if="m.kind === 'assistant'" class="flex flex-col gap-1 anim-fadeUp">
            <div class="flex items-center gap-2">
              <Mascot :size="24" :float="false" :animated="false" />
              <span class="text-xs font-semibold text-[var(--accent)]">博文</span>
            </div>
            <div class="pl-8">
              <div v-if="m.text" class="stream-wrap" :class="{ 'is-streaming': !m.done }">
                <div class="md-body text-[15px] leading-relaxed" v-html="renderMarkdown(m.text)"></div>
              </div>
              <!-- 正在出题提示，仅在最后一条且是 assistant 时 -->
              <div v-if="i === chatStore.items.length - 1 && chatStore.isGeneratingQuiz" class="quiz-gen clay-sm">
                <div class="quiz-gen-inner">
                  <span class="quiz-gen-icon">
                    <PencilLine class="h-4 w-4" />
                  </span>
                  <span class="quiz-gen-label">博文正在出题</span>
                  <span class="quiz-gen-dots"><span></span><span></span><span></span></span>
                </div>
              </div>
              <TypingDots v-else-if="i === chatStore.items.length - 1 && chatStore.showTyping && !m.text" />
            </div>
          </div>
        </template>
      </div>
    </div>
  </main>

  <!-- 学习结算卡片 -->
  <Teleport to="body">
    <Transition name="panel-scale">
      <div v-if="chatStore.learningSettlement" class="fixed inset-0 z-50 flex items-center justify-center bg-black/20 backdrop-blur-sm" @click.self="chatStore.learningSettlement = null">
        <div class="clay clay-glass mx-4 w-full max-w-md overflow-hidden" v-motion :initial="{ opacity: 0, scale: 0.9, y: 20 }" :enter="{ opacity: 1, scale: 1, y: 0, transition: { type: 'spring', stiffness: 300, damping: 25 } }">
          <div class="border-b border-[var(--line)] bg-[var(--accent-soft)] px-5 py-4 text-center">
            <span class="text-2xl">🎉</span>
            <h3 class="mt-1 font-display text-lg font-bold text-[var(--ink)]">本次学习完成！</h3>
          </div>
          <div class="space-y-4 px-5 py-4">
            <div class="flex items-center justify-center gap-4">
              <div class="relative h-20 w-20">
                <svg class="h-full w-full -rotate-90" viewBox="0 0 80 80">
                  <circle cx="40" cy="40" r="34" fill="none" stroke="var(--line)" stroke-width="6" />
                  <circle cx="40" cy="40" r="34" fill="none" stroke="#d4a053" stroke-width="6" stroke-linecap="round"
                    :stroke-dasharray="2 * Math.PI * 34"
                    :stroke-dashoffset="2 * Math.PI * 34 * (1 - chatStore.learningSettlement.score / 100)"
                    class="transition-all duration-1000" />
                </svg>
                <div class="absolute inset-0 flex flex-col items-center justify-center">
                  <span class="font-display text-xl font-bold text-[#d4a053]">{{ chatStore.learningSettlement.score }}</span>
                  <span class="text-[9px] font-medium text-[var(--ink-soft)]">分</span>
                </div>
              </div>
              <div class="text-left text-xs text-[var(--ink-soft)]">
                <p>📝 已完成 {{ chatStore.learningSettlement.stepsCompleted }} / {{ chatStore.learningSettlement.totalSteps }} 步</p>
                <p>📊 更新了 {{ chatStore.learningSettlement.updatedKps }} 个知识点</p>
              </div>
            </div>
            <div class="max-h-32 overflow-y-auto rounded-xl bg-[var(--surface)] p-3 text-xs leading-relaxed text-[var(--ink)] md-body"
              v-html="renderMarkdown(chatStore.learningSettlement.summary)">
            </div>
            <button @click="chatStore.learningSettlement = null"
              class="flex w-full items-center justify-center gap-2 rounded-2xl bg-[var(--accent)] py-2.5 font-display text-sm font-bold text-white transition-all hover:opacity-90 active:scale-[0.97]">
              继续学习
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
