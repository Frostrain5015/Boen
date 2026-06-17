<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import confetti from 'canvas-confetti';
import { CheckCircle2, XCircle, Sparkles, Lightbulb, PencilLine } from 'lucide-vue-next';
import type { QuestionPayload, AnswerPayload, GradingResult } from '@boen/shared';
import { renderMarkdown, renderMarkdownInline } from '@/lib/markdown';

const props = defineProps<{
  question: QuestionPayload;
  answered: boolean;
  grading?: GradingResult;
  /** 当前学科（数学模式下显示公式编辑工具栏） */
  subject?: string;
}>();
const emit = defineEmits<{ submit: [answer: AnswerPayload] }>();

const root = ref<HTMLElement | null>(null);

const TYPE_LABEL: Record<QuestionPayload['type'], string> = {
  multiple_choice: '选择题',
  fill_blank: '填空题',
  true_false: '判断题',
  short_answer: '简答题',
};
const DIFF_DOTS: Record<string, number> = { easy: 1, medium: 2, hard: 3 };

const selectedKeys = ref<string[]>([]);
const blanks = ref<string[]>(
  props.question.type === 'fill_blank' ? Array(props.question.blankCount).fill('') : [],
);
const tfValue = ref<boolean | null>(null);
const shortText = ref('');

// 从 reference 反推正确选项 key（作答后才用于高亮）
const correctKeys = computed(() => {
  if (props.question.type !== 'multiple_choice' || !props.grading) return [];
  return props.question.options.filter((o) => props.grading!.reference.includes(`${o.key}.`)).map((o) => o.key);
});

/** 填空题干：为每个 ____ 编号，避免歧义 */
const processedStem = computed(() => {
  const stem = props.question.stem;
  if (props.question.type !== 'fill_blank') return stem;
  const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩'];
  let idx = 0;
  return stem.replace(/_{4,}/g, () => `${CIRCLED[idx] ?? `[${idx + 1}]`}____`);
});

/** 数学公式编辑器符号库 */
const MATH_SYMBOLS = [
  { label: 'xⁿ', insert: '^{}' },
  { label: 'xₙ', insert: '_{}' },
  { label: 'a/b', insert: '\\frac{}{}' },
  { label: '√', insert: '\\sqrt{}' },
  { label: 'π', insert: '\\pi' },
  { label: '±', insert: '\\pm' },
  { label: '∞', insert: '\\infty' },
  { label: '≥', insert: '\\ge' },
  { label: '≤', insert: '\\le' },
  { label: '≠', insert: '\\ne' },
  { label: '×', insert: '\\times' },
  { label: '÷', insert: '\\div' },
  { label: 'θ', insert: '\\theta' },
  { label: 'α', insert: '\\alpha' },
  { label: 'β', insert: '\\beta' },
];

function insertMath(text: string) {
  if (props.answered) return;
  const el = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
  if (!el || !(el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return;
  const start = el.selectionStart ?? 0;
  const end = el.selectionEnd ?? 0;
  const before = el.value.substring(0, start);
  const after = el.value.substring(end);
  el.value = before + text + after;
  const pos = start + text.length;
  el.setSelectionRange(pos, pos);
  el.focus();
  el.dispatchEvent(new Event('input'));
}

const canSubmit = computed(() => {
  if (props.answered) return false;
  switch (props.question.type) {
    case 'multiple_choice': return selectedKeys.value.length > 0;
    case 'fill_blank': return blanks.value.some((b) => b.trim());
    case 'true_false': return tfValue.value !== null;
    case 'short_answer': return shortText.value.trim().length > 0;
  }
});

function toggleKey(key: string, multi: boolean) {
  if (props.answered) return;
  if (multi) {
    selectedKeys.value = selectedKeys.value.includes(key)
      ? selectedKeys.value.filter((k) => k !== key)
      : [...selectedKeys.value, key];
  } else selectedKeys.value = [key];
}

function optionClass(key: string) {
  const selected = selectedKeys.value.includes(key);
  if (!props.answered || !props.grading) {
    return selected ? 'opt-selected' : 'opt-idle';
  }
  const isCorrect = correctKeys.value.includes(key);
  if (isCorrect) return 'opt-correct';
  if (selected) return 'opt-wrong';
  return 'opt-muted';
}

function submit() {
  if (!canSubmit.value) return;
  const q = props.question;
  let answer: AnswerPayload;
  switch (q.type) {
    case 'multiple_choice': answer = { type: 'multiple_choice', selectedKeys: selectedKeys.value }; break;
    case 'fill_blank': answer = { type: 'fill_blank', answers: blanks.value }; break;
    case 'true_false': answer = { type: 'true_false', value: tfValue.value! }; break;
    case 'short_answer': answer = { type: 'short_answer', text: shortText.value }; break;
  }
  emit('submit', answer);
}

// 答对撒花
watch(
  () => props.grading,
  (g) => {
    if (g?.correct === true) {
      const r = root.value?.getBoundingClientRect();
      const origin = r
        ? { x: (r.left + r.width / 2) / window.innerWidth, y: (r.top + 40) / window.innerHeight }
        : { x: 0.5, y: 0.3 };
      confetti({ particleCount: 90, spread: 70, startVelocity: 38, origin, scalar: 0.9, ticks: 160 });
    }
  },
);
</script>

<template>
  <div
    ref="root"
    class="clay overflow-hidden"
    v-motion
    :initial="{ opacity: 0, y: 24, scale: 0.96 }"
    :enter="{ opacity: 1, y: 0, scale: 1, transition: { type: 'spring', stiffness: 260, damping: 20 } }"
  >
    <!-- 头部 -->
    <div class="flex items-center gap-2 bg-accent-soft px-5 py-3">
      <PencilLine class="h-4 w-4 text-accent" />
      <span class="font-display text-sm font-semibold text-accent">{{ TYPE_LABEL[question.type] }}</span>
      <div v-if="question.difficulty" class="flex gap-1">
        <span
          v-for="i in 3"
          :key="i"
          class="h-1.5 w-1.5 rounded-full"
          :class="i <= (DIFF_DOTS[question.difficulty] ?? 0) ? 'bg-accent' : 'bg-black/10'"
        />
      </div>
      <span v-if="question.knowledgePoint" class="ml-auto truncate text-xs text-[var(--ink-soft)]">
        {{ question.knowledgePoint }}
      </span>
    </div>

    <div class="space-y-4 px-5 py-4">
      <!-- 阅读材料块（语文/英语阅读理解专用） -->
      <div v-if="question.passage" class="passage-block md-body" v-html="renderMarkdown(question.passage)"></div>
      <div class="md-body font-display text-[1.02rem] font-medium leading-relaxed" v-html="renderMarkdown(processedStem)"></div>

      <!-- 选择题 -->
      <div v-if="question.type === 'multiple_choice'" class="space-y-2.5">
        <button
          v-for="(opt, i) in question.options"
          :key="opt.key"
          @click="toggleKey(opt.key, question.multiSelect)"
          :disabled="answered"
          class="opt group"
          :class="optionClass(opt.key)"
          v-motion
          :initial="{ opacity: 0, x: -16 }"
          :enter="{ opacity: 1, x: 0, transition: { delay: 120 + i * 70 } }"
        >
          <span class="opt-key">{{ opt.key }}</span>
          <span class="md-body flex-1 text-left" v-html="renderMarkdownInline(opt.text)"></span>
          <CheckCircle2 v-if="answered && correctKeys.includes(opt.key)" class="h-5 w-5 shrink-0 text-[var(--success)]" />
          <XCircle v-else-if="answered && selectedKeys.includes(opt.key)" class="h-5 w-5 shrink-0 text-[var(--error)]" />
        </button>
        <p v-if="question.multiSelect && !answered" class="text-xs text-[var(--ink-soft)]">可选多个</p>
      </div>

      <!-- 判断题 -->
      <div v-else-if="question.type === 'true_false'" class="grid grid-cols-2 gap-3">
        <button
          v-for="opt in [{ v: true, t: '正确' }, { v: false, t: '错误' }]"
          :key="String(opt.v)"
          @click="!answered && (tfValue = opt.v)"
          :disabled="answered"
          class="tf"
          :class="tfValue === opt.v ? 'tf-on' : 'tf-off'"
        >
          {{ opt.t }}
        </button>
      </div>

      <!-- 填空题 -->
      <div v-else-if="question.type === 'fill_blank'" class="space-y-2.5">
        <!-- 数学公式工具栏 -->
        <div v-if="subject === 'math' && !answered" class="math-bar">
          <button v-for="sym in MATH_SYMBOLS" :key="sym.insert" @click="insertMath(sym.insert)" class="math-btn" :title="sym.insert">
            {{ sym.label }}
          </button>
        </div>
        <div
          v-for="(_, i) in blanks"
          :key="i"
          class="flex items-center gap-2"
          v-motion
          :initial="{ opacity: 0, y: 8 }"
          :enter="{ opacity: 1, y: 0, transition: { delay: 120 + i * 70 } }"
        >
          <span class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-xs font-bold text-accent">
            {{ i + 1 }}
          </span>
          <input
            v-model="blanks[i]"
            :disabled="answered"
            class="field"
            :class="answered && grading?.perBlank ? (grading.perBlank[i] ? 'field-ok' : 'field-no') : ''"
            placeholder="填写答案…"
          />
          <CheckCircle2 v-if="answered && grading?.perBlank?.[i]" class="h-5 w-5 shrink-0 text-[var(--success)]" />
          <XCircle v-else-if="answered && grading?.perBlank" class="h-5 w-5 shrink-0 text-[var(--error)]" />
        </div>
      </div>

      <!-- 简答题 -->
      <div v-else-if="question.type === 'short_answer'">
        <!-- 数学公式工具栏 -->
        <div v-if="subject === 'math' && !answered" class="math-bar">
          <button v-for="sym in MATH_SYMBOLS" :key="sym.insert" @click="insertMath(sym.insert)" class="math-btn" :title="sym.insert">
            {{ sym.label }}
          </button>
        </div>
        <textarea v-model="shortText" :disabled="answered" rows="4" class="field" placeholder="写下你的思路与答案…" />
      </div>

      <!-- 提交 -->
      <button v-if="!answered" @click="submit" :disabled="!canSubmit" class="btn-accent flex items-center gap-2 rounded-2xl px-6 py-2.5 font-display text-sm font-semibold">
        <Sparkles class="h-4 w-4" /> 提交答案
      </button>

      <!-- 判分结果 -->
      <Transition name="reveal">
        <div v-if="answered && grading" class="result" :class="grading.correct === true ? 'res-ok' : grading.correct === false ? 'res-no' : 'res-soft'">
          <div class="flex items-center gap-2 font-display font-bold">
            <CheckCircle2 v-if="grading.correct === true" class="check h-6 w-6 text-[var(--success)]" />
            <XCircle v-else-if="grading.correct === false" class="check h-6 w-6 text-[var(--error)]" />
            <Lightbulb v-else class="check h-6 w-6 text-[#E0A92E]" />
            <span>
              <template v-if="grading.correct === true">太棒了，回答正确！</template>
              <template v-else-if="grading.correct === false">差一点，继续加油～</template>
              <template v-else>已提交，看看点评</template>
            </span>
            <span class="ml-auto rounded-full bg-white/70 px-2.5 py-0.5 text-sm font-bold">
              {{ grading.score }} / {{ grading.maxScore }}
            </span>
          </div>
          <p class="mt-2 text-sm"><span class="font-semibold text-[var(--ink-soft)]">参考答案：</span><span class="md-body" v-html="renderMarkdownInline(grading.reference)"></span></p>
          <div v-if="grading.explanation" class="md-body mt-1.5 text-sm leading-relaxed text-[var(--ink-soft)]" v-html="renderMarkdown(grading.explanation)"></div>
        </div>
      </Transition>
    </div>
  </div>
</template>

<style scoped>
.opt {
  display: flex;
  align-items: center;
  gap: 0.7rem;
  width: 100%;
  padding: 0.7rem 0.9rem;
  border-radius: 16px;
  border: 1.5px solid var(--line);
  background: #fff;
  font-size: 0.95rem;
  cursor: pointer;
  transition: transform 0.16s ease, border-color 0.2s, background-color 0.2s, box-shadow 0.2s;
}
.opt:disabled { cursor: default; }
.opt-idle:hover { transform: translateY(-2px); border-color: var(--accent); box-shadow: 0 8px 18px -12px var(--accent-glow); }
.opt-selected { border-color: var(--accent); background: var(--accent-soft); box-shadow: 0 0 0 3px var(--accent-soft); }
.opt-correct { border-color: var(--success); background: #e7f7ee; }
.opt-wrong { border-color: var(--error); background: #fdeaef; }
.opt-muted { opacity: 0.6; }
.opt-key {
  display: grid;
  place-items: center;
  width: 1.75rem;
  height: 1.75rem;
  border-radius: 50%;
  font-weight: 800;
  font-size: 0.8rem;
  background: var(--accent-soft);
  color: var(--accent-strong);
  transition: background-color 0.5s, color 0.5s;
}
.opt-selected .opt-key { background: var(--accent); color: #fff; }
.opt-correct .opt-key { background: var(--success); color: #fff; }
.opt-wrong .opt-key { background: var(--error); color: #fff; }

.tf {
  padding: 0.8rem;
  border-radius: 18px;
  border: 1.5px solid var(--line);
  background: #fff;
  font-family: var(--font-display);
  font-weight: 600;
  cursor: pointer;
  transition: transform 0.16s ease, border-color 0.2s, background-color 0.2s;
}
.tf-off:hover { transform: translateY(-2px); border-color: var(--accent); }
.tf-on { border-color: var(--accent); background: var(--accent-soft); color: var(--accent-strong); box-shadow: 0 0 0 3px var(--accent-soft); }

.field {
  flex: 1;
  width: 100%;
  padding: 0.55rem 0.85rem;
  border-radius: 14px;
  border: 1.5px solid var(--line);
  background: #fff;
  font-size: 0.95rem;
  resize: none;
  transition: border-color 0.2s, box-shadow 0.2s;
}
.field:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.field:disabled { background: #faf6ef; }
.field-ok { border-color: var(--success); background: #e7f7ee; }
.field-no { border-color: var(--error); background: #fdeaef; }

.result { border-radius: 18px; padding: 0.9rem 1rem; }
.res-ok { background: #e7f7ee; }
.res-no { background: #fdeaef; }
.res-soft { background: #fff6e3; }
.check { animation: checkPop 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) both; }

.reveal-enter-active { transition: all 0.4s cubic-bezier(0.22, 1, 0.36, 1); }
.reveal-enter-from { opacity: 0; transform: translateY(10px); }

/* ── 数学公式工具栏 ──────────────────────────── */
.math-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 6px 8px;
  border-radius: 14px;
  background: var(--paper);
  border: 1px solid var(--line);
}
.math-btn {
  display: grid;
  place-items: center;
  min-width: 2rem;
  height: 1.8rem;
  padding: 0 0.3rem;
  border-radius: 8px;
  border: 1px solid transparent;
  background: var(--surface);
  font-size: 0.82rem;
  font-weight: 600;
  font-family: 'Times New Roman', 'Latin Modern Math', serif;
  color: var(--ink);
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s, transform 0.12s;
}
.math-btn:hover { background: var(--accent-soft); border-color: var(--accent); transform: translateY(-1px); }
.math-btn:active { transform: translateY(0); }
</style>
