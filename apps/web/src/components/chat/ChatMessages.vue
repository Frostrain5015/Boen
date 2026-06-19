<script setup lang="ts">
import { onMounted } from 'vue';
import { PencilLine } from 'lucide-vue-next';
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
          <div v-else class="flex flex-col gap-1 anim-fadeUp">
            <div class="flex items-center gap-2">
              <Mascot :size="24" :float="false" :animated="false" />
              <span class="text-xs font-semibold text-[var(--accent)]">博文</span>
            </div>
            <div class="pl-8">
              <div v-if="m.text" class="stream-wrap" :class="{ 'is-streaming': !m.done }">
                <div class="md-body text-[15px] leading-relaxed" v-html="renderMarkdown(m.text)"></div>
              </div>
              <!-- 正在出题提示 -->
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
</template>
