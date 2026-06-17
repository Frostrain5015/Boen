<script setup lang="ts">
import { ref, computed, nextTick } from 'vue';
import { Send, Sparkles } from 'lucide-vue-next';
import { renderMarkdown } from '@/lib/markdown';
import type { GradeBand, QuestionPayload, AnswerPayload, GradingResult, SseEvent } from '@boen/shared';
import { streamChat, streamAnswer } from '@/services/chat';
import QuestionCard from '@/components/QuestionCard.vue';
import Mascot from '@/components/Mascot.vue';
import TypingDots from '@/components/TypingDots.vue';

type ChatItem =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string; chunks: string[]; done: boolean }
  | { kind: 'question'; toolCallId: string; question: QuestionPayload; answered: boolean; grading?: GradingResult };

const newAssistant = (text = ''): ChatItem => ({ kind: 'assistant', text, chunks: text ? [text] : [], done: false });

const GRADE_LABELS: { value: GradeBand; label: string; emoji: string }[] = [
  { value: 'primary', label: '小学', emoji: '🌱' },
  { value: 'middle', label: '中学', emoji: '🌿' },
  { value: 'undergrad', label: '本科', emoji: '🎓' },
];
const QUICK_CHIPS = ['考我一道选择题', '出一道判断题', '讲讲三角形的面积', '帮我复习光合作用'];

const items = ref<ChatItem[]>([]);
const input = ref('');
const gradeBand = ref<GradeBand>('middle');
const busy = ref(false);
const threadId = `web-${Date.now()}`;
const scroller = ref<HTMLElement | null>(null);

const hasItems = computed(() => items.value.length > 0);
const gradeIndex = computed(() => GRADE_LABELS.findIndex((g) => g.value === gradeBand.value));
const showTyping = computed(() => {
  const last = items.value[items.value.length - 1];
  return busy.value && last?.kind === 'assistant' && !last.text;
});

function scrollDown() {
  nextTick(() => {
    requestAnimationFrame(() => {
      const el = scroller.value;
      if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    });
  });
}

function handleEvent(e: SseEvent, idx: { value: number }) {
  if (e.type === 'token') {
    let cur = items.value[idx.value];
    if (!cur || cur.kind !== 'assistant') {
      items.value.push(newAssistant());
      idx.value = items.value.length - 1;
      cur = items.value[idx.value];
    }
    if (cur.kind === 'assistant') {
      cur.text += e.value;
      cur.chunks.push(e.value);
    }
  } else if (e.type === 'question') {
    const cur = items.value[idx.value];
    if (cur && cur.kind === 'assistant' && !cur.text.trim()) items.value.splice(idx.value, 1);
    items.value.push({ kind: 'question', toolCallId: e.toolCallId, question: e.question, answered: false });
    idx.value = -1;
  } else if (e.type === 'grading') {
    const q = items.value.find((it) => it.kind === 'question' && it.toolCallId === e.toolCallId);
    if (q && q.kind === 'question') q.grading = e.result;
  } else if (e.type === 'error') {
    items.value.push(newAssistant(`⚠️ ${e.message}`));
  }
  scrollDown();
}

/** 流结束后把助手气泡标记完成，切换到 Markdown 渲染 */
function finalizeAssistants() {
  items.value.forEach((it) => {
    if (it.kind === 'assistant') it.done = true;
  });
}

async function send(text: string) {
  const t = text.trim();
  if (!t || busy.value) return;
  input.value = '';
  busy.value = true;
  items.value.push({ kind: 'user', text: t });
  items.value.push(newAssistant());
  const idx = { value: items.value.length - 1 };
  scrollDown();
  try {
    await streamChat({ threadId, message: t, gradeBand: gradeBand.value }, (e) => handleEvent(e, idx));
  } catch (err) {
    items.value.push(newAssistant(`⚠️ 请求失败：${err instanceof Error ? err.message : String(err)}`));
  } finally {
    finalizeAssistants();
    busy.value = false;
  }
}

async function onAnswer(item: Extract<ChatItem, { kind: 'question' }>, answer: AnswerPayload) {
  if (item.answered || busy.value) return;
  item.answered = true;
  busy.value = true;
  const idx = { value: -1 };
  try {
    await streamAnswer({ threadId, toolCallId: item.toolCallId, answer }, (e) => handleEvent(e, idx));
  } catch (err) {
    items.value.push(newAssistant(`⚠️ 提交失败：${err instanceof Error ? err.message : String(err)}`));
  } finally {
    finalizeAssistants();
    busy.value = false;
  }
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send(input.value);
  }
}
</script>

<template>
  <div :data-grade="gradeBand" class="relative flex h-full flex-col">
    <div class="app-bg"></div>
    <div class="app-grain"></div>

    <!-- 顶栏 -->
    <header
      class="relative z-10 flex items-center gap-3 px-5 py-3.5"
      v-motion
      :initial="{ opacity: 0, y: -20 }"
      :enter="{ opacity: 1, y: 0, transition: { duration: 500 } }"
    >
      <Mascot :size="46" />
      <div class="leading-tight">
        <h1 class="brand-text text-2xl font-bold tracking-tight">博文 Boen</h1>
        <p class="text-xs font-semibold text-[var(--ink-soft)]">你的学习小伙伴</p>
      </div>

      <!-- 年龄段切换（滑块） -->
      <div class="ml-auto">
        <div class="clay-sm relative flex bg-[var(--surface)] p-1">
          <span
            class="absolute top-1 bottom-1 rounded-[14px] bg-accent transition-transform duration-400"
            :style="{ width: 'calc((100% - 0.5rem) / 3)', transform: `translateX(calc(${gradeIndex} * 100%))` }"
            style="transition-timing-function: cubic-bezier(0.34, 1.56, 0.64, 1)"
          ></span>
          <button
            v-for="g in GRADE_LABELS"
            :key="g.value"
            @click="gradeBand = g.value"
            class="relative z-10 flex w-[4.2rem] items-center justify-center gap-1 rounded-[14px] py-1.5 font-display text-sm font-semibold transition-colors duration-300 cursor-pointer"
            :class="gradeBand === g.value ? 'text-white' : 'text-[var(--ink-soft)] hover:text-[var(--ink)]'"
          >
            <span>{{ g.emoji }}</span>{{ g.label }}
          </button>
        </div>
      </div>
    </header>

    <!-- 时间线 -->
    <main ref="scroller" class="relative z-10 flex-1 overflow-y-auto px-4">
      <div class="mx-auto w-full max-w-2xl py-5">
        <!-- 欢迎页 -->
        <div v-if="!hasItems" class="flex flex-col items-center gap-5 pt-[8vh] text-center anim-fadeUp">
          <Mascot :size="120" />
          <div>
            <h2 class="font-display text-2xl font-bold">嗨，我是博文！👋</h2>
            <p class="mt-1.5 text-[var(--ink-soft)]">问我问题，或者说一句「考我一道题」来练习吧～</p>
          </div>
          <div class="flex max-w-md flex-wrap justify-center gap-2.5">
            <button
              v-for="(chip, i) in QUICK_CHIPS"
              :key="chip"
              @click="send(chip)"
              class="clay-sm cursor-pointer bg-[var(--surface)] px-4 py-2 text-sm font-semibold transition-transform hover:-translate-y-1"
              v-motion
              :initial="{ opacity: 0, y: 14 }"
              :enter="{ opacity: 1, y: 0, transition: { delay: 200 + i * 90 } }"
            >
              {{ chip }}
            </button>
          </div>
        </div>

        <!-- 消息列表 -->
        <div v-auto-animate class="flex flex-col gap-4">
          <template v-for="(m, i) in items" :key="i">
            <QuestionCard
              v-if="m.kind === 'question'"
              :question="m.question"
              :answered="m.answered"
              :grading="m.grading"
              @submit="(a) => onAnswer(m, a)"
            />

            <div v-else-if="m.kind === 'user'" class="flex justify-end anim-pop">
              <div class="max-w-[82%] rounded-[22px] rounded-br-md bg-accent px-4 py-2.5 font-medium text-white shadow-lg">
                {{ m.text }}
              </div>
            </div>

            <div v-else class="flex items-end gap-2.5 anim-pop">
              <div class="clay-sm grid h-9 w-9 shrink-0 place-items-center bg-[var(--surface)]">
                <Mascot :size="26" :float="false" />
              </div>
              <div class="clay max-w-[82%] rounded-bl-md px-4 py-3">
                <TypingDots v-if="i === items.length - 1 && showTyping" />
                <div v-else-if="!m.done" class="md-body stream-text">
                  <span v-for="(c, ci) in m.chunks" :key="ci" class="tok">{{ c }}</span>
                </div>
                <div v-else class="md-body" v-html="renderMarkdown(m.text || '…')"></div>
              </div>
            </div>
          </template>
        </div>
      </div>
    </main>

    <!-- 输入区 -->
    <footer class="relative z-10 px-4 pb-4 pt-1">
      <div class="mx-auto w-full max-w-2xl">
        <div v-if="hasItems" class="mb-2.5 flex gap-2 overflow-x-auto pb-1">
          <button
            v-for="chip in QUICK_CHIPS"
            :key="chip"
            @click="send(chip)"
            :disabled="busy"
            class="shrink-0 cursor-pointer rounded-full border border-[var(--line)] bg-[var(--surface)]/80 px-3.5 py-1.5 text-xs font-semibold text-[var(--ink-soft)] backdrop-blur transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
          >
            {{ chip }}
          </button>
        </div>

        <div class="clay flex items-end gap-2 p-2">
          <textarea
            v-model="input"
            @keydown="onKeydown"
            rows="1"
            placeholder="输入问题，或说「考我一道选择题」…"
            class="max-h-32 flex-1 resize-none bg-transparent px-3 py-2.5 text-[15px] placeholder:text-[var(--ink-soft)]/70 focus:outline-none"
          />
          <button
            @click="send(input)"
            :disabled="busy || !input.trim()"
            class="btn-accent grid h-11 w-11 shrink-0 place-items-center rounded-[18px]"
            aria-label="发送"
          >
            <Sparkles v-if="busy" class="h-5 w-5 animate-spin" />
            <Send v-else class="h-5 w-5" />
          </button>
        </div>
      </div>
    </footer>
  </div>
</template>
