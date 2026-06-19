<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue';
import { ArrowLeft, GraduationCap, BrainCircuit, CheckCircle2, XCircle, ChevronDown, ChevronUp, FileSearch } from 'lucide-vue-next';
import Mascot from '@/components/Mascot.vue';
import type { ExamReviewDetail, ExamQuestion, ExamQuestionResult, AnswerPayload } from '@boen/shared';
import { getExamReview } from '@/services/chat';
import { renderMarkdown } from '@/lib/markdown';
import { processTikzDiagrams } from '@/lib/tikz';
import StarDisplay from '@/components/StarDisplay.vue';

const props = defineProps<{ examId: string | null }>();
const emit = defineEmits<{ (e: 'back'): void }>();

const loading = ref(false);
const detail = ref<ExamReviewDetail | null>(null);
const expanded = ref<Set<number>>(new Set());
const error = ref('');

const SUBJECT_LABELS: Record<string, { label: string; emoji: string }> = {
  chinese: { label: '语文', emoji: '📖' },
  math: { label: '数学', emoji: '🔢' },
  english: { label: '英语', emoji: '🔤' },
  science: { label: '科学', emoji: '🔬' },
};
const TYPE_LABELS: Record<string, string> = { multiple_choice: '选择题', fill_blank: '填空题', true_false: '判断题', short_answer: '简答题' };

function subjectInfo(s: string) { return SUBJECT_LABELS[s] ?? { label: s, emoji: '📁' }; }
function gradeLabel(g: string): string {
  const n = Number(g);
  if (!n) return g;
  return n <= 6 ? `小${'一二三四五六'[n - 1]}` : `初${'一二三'[n - 7]}`;
}
function masteryColor(p: number): string {
  if (p < 40) return '#f2557a'; if (p < 60) return '#f59e42'; if (p < 80) return '#e0a92e'; return '#18a558';
}
function formatDateTime(ts?: number): string {
  if (!ts) return '';
  return new Date(ts * 1000).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

const answerMap = computed(() => {
  const m = new Map<number, AnswerPayload>();
  for (const a of detail.value?.answers ?? []) m.set(a.questionIndex, a.answer);
  return m;
});
const resultMap = computed(() => {
  const m = new Map<number, ExamQuestionResult>();
  for (const r of detail.value?.results?.questionResults ?? []) m.set(r.index, r);
  return m;
});
const proficiencyMap = computed(() => {
  const m: Record<string, { before: number; after: number }> = {};
  for (const pc of detail.value?.results?.proficiencyChanges ?? []) {
    m[pc.kpTitle] = { before: pc.before, after: pc.after };
  }
  return m;
});

function percent(score?: number, maxScore?: number): number {
  return maxScore && maxScore > 0 ? Math.round(((score ?? 0) / maxScore) * 100) : 0;
}

function userAnswerText(q: ExamQuestion): string {
  const a = answerMap.value.get(q.index);
  if (!a) return '（未作答）';
  if (a.type === 'short_answer') return a.text?.trim() ? a.text : '（未作答）';
  return '（未作答）';
}
function selectedKeys(q: ExamQuestion): string[] {
  const a = answerMap.value.get(q.index);
  return a && a.type === 'multiple_choice' ? a.selectedKeys : [];
}
function userTrueFalse(q: ExamQuestion): boolean | null {
  const a = answerMap.value.get(q.index);
  return a && a.type === 'true_false' ? a.value : null;
}
function userBlank(q: ExamQuestion, i: number): string {
  const a = answerMap.value.get(q.index);
  return a && a.type === 'fill_blank' ? (a.answers[i] ?? '') : '';
}

function isPlaceholderOptionText(text: unknown, key?: string): boolean {
  const raw = String(text ?? '').trim();
  const normalized = raw.replace(/[{}（）()【】\s]/g, '').toUpperCase();
  const expected = key ? key.toUpperCase() : '[A-F]';
  return !raw || normalized === expected || normalized === `选项${expected}` || /^选项[A-F]$/.test(normalized);
}

function stripOptionPrefix(text: string, key?: string): string {
  const k = key ? key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '[A-Fa-f]';
  return String(text ?? '').trim().replace(new RegExp(`^(?:选项\\s*)?${k}\\s*[.．、:：)]\\s*`, 'i'), '').trim();
}

function displayOptions(q: ExamQuestion): { key: string; text: string }[] {
  return (q.options ?? [])
    .map((o) => ({ key: String(o.key ?? '').trim().toUpperCase(), text: stripOptionPrefix(o.text, o.key) }))
    .filter((o) => o.key && !isPlaceholderOptionText(o.text, o.key));
}

function blankRows(q: ExamQuestion): { acceptedAnswers: string[] }[] {
  if (q.blanks?.length) return q.blanks;
  const markerCount = (q.stem.match(/_{2,}|＿{2,}|（\s*）|\(\s*\)|\[\s*\]/g) ?? []).length;
  const count = Math.max(q.blankCount ?? 0, markerCount, 1);
  return Array.from({ length: count }, () => ({ acceptedAnswers: [] }));
}

async function load(examId: string) {
  loading.value = true; error.value = ''; expanded.value = new Set(); detail.value = null;
  try {
    const { exam } = await getExamReview(examId);
    detail.value = exam;
    nextTick(() => processTikzDiagrams()); // 编译题面/选项里的 TikZ 示意图
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

function toggle(i: number) {
  const s = new Set(expanded.value);
  s.has(i) ? s.delete(i) : s.add(i);
  expanded.value = s;
  // 解析区展开后编译其中的 TikZ
  if (s.has(i)) nextTick(() => processTikzDiagrams());
}

watch(() => props.examId, (id) => { if (id) load(id); }, { immediate: true });
</script>

<template>
  <div class="review-root" v-motion :initial="{ opacity: 0 }" :enter="{ opacity: 1, transition: { duration: 300 } }">
    <!-- 顶栏 -->
    <div class="flex items-center gap-2 border-b border-[var(--line)] bg-[var(--surface)] px-5 py-3">
      <button @click="emit('back')" class="flex h-8 w-8 items-center justify-center rounded-full transition-colors hover:bg-[var(--line)]/50">
        <ArrowLeft class="h-4 w-4 text-[var(--ink-soft)]" />
      </button>
      <h2 class="truncate font-display text-base font-bold text-[var(--ink)]">{{ detail?.title ?? '考试回顾' }}</h2>
    </div>

    <div class="flex-1 overflow-y-auto px-4 py-4">
      <div class="mx-auto max-w-2xl">
        <div v-if="!examId" class="flex flex-col items-center gap-3 py-24 text-center text-[var(--ink-soft)]">
          <FileSearch class="h-12 w-12 opacity-40" />
          <p class="text-sm font-medium">从左侧选择一场考试查看回顾</p>
        </div>
        <div v-else-if="loading" class="py-16 text-center text-sm text-[var(--ink-soft)]">加载中…</div>
        <div v-else-if="error" class="py-16 text-center text-sm text-[#f2557a]">{{ error }}</div>

        <template v-else-if="detail">
          <!-- 完整判卷总览 -->
          <div v-if="detail.results" class="mb-4 space-y-3">
            <div class="clay p-5 text-center" v-motion :initial="{ opacity: 0, scale: 0.95 }" :enter="{ opacity: 1, scale: 1, transition: { type: 'spring', stiffness: 260, damping: 20 } }">
              <div class="relative mx-auto mb-3 h-24 w-24">
                <svg class="h-full w-full -rotate-90" viewBox="0 0 120 120">
                  <circle cx="60" cy="60" r="54" fill="none" stroke="var(--line)" stroke-width="9" />
                  <circle class="circle-reveal" cx="60" cy="60" r="54" fill="none" :stroke="masteryColor(detail.results.percentage)" stroke-width="9" stroke-linecap="round" :stroke-dasharray="2 * Math.PI * 54" :stroke-dashoffset="2 * Math.PI * 54 * (1 - detail.results.percentage / 100)" />
                </svg>
                <div class="absolute inset-0 flex flex-col items-center justify-center">
                  <span class="font-display text-3xl font-bold" :style="{ color: masteryColor(detail.results.percentage) }">{{ detail.results.percentage }}<span class="text-base">%</span></span>
                  <span class="text-[10px] font-medium text-[var(--ink-soft)]">正确率</span>
                </div>
              </div>
              <span class="inline-block rounded-full px-3 py-0.5 font-display text-sm font-bold" :class="detail.results.grade === '优秀' ? 'bg-[#e7f7ee] text-[#18a558]' : detail.results.grade === '良好' ? 'bg-[#fef7e6] text-[#e0a92e]' : detail.results.grade === '及格' ? 'bg-[#fef3e2] text-[#f59e42]' : 'bg-[#fdeaef] text-[#f2557a]'">{{ detail.results.grade }}</span>
              <p class="mt-2 text-sm font-semibold text-[var(--ink)]">{{ detail.results.totalScore }} / {{ detail.results.maxScore }} 分</p>
              <p class="text-xs text-[var(--ink-soft)]">{{ subjectInfo(detail.subject).label }} · {{ gradeLabel(detail.grade) }} · {{ formatDateTime(detail.submittedAt ?? detail.createdAt) }}</p>
            </div>

            <div v-if="detail.results.analysis" class="clay overflow-hidden" v-motion :initial="{ opacity: 0, y: 14 }" :enter="{ opacity: 1, y: 0, transition: { delay: 90 } }">
              <div class="flex items-start gap-3 p-4">
                <Mascot :size="44" state="happy" class="shrink-0" />
                <div class="min-w-0 flex-1">
                  <p class="mb-2 font-display text-xs font-bold text-[var(--accent)]">博文的总结</p>
                  <div class="analysis-body text-sm leading-relaxed text-[var(--ink)]" v-html="renderMarkdown(detail.results.analysis)"></div>
                </div>
              </div>
            </div>

            <div class="clay p-4" v-motion :initial="{ opacity: 0, y: 14 }" :enter="{ opacity: 1, y: 0, transition: { delay: 130 } }">
              <h3 class="mb-3 font-display text-xs font-bold text-[var(--ink-soft)]">权重层级得分</h3>
              <div v-for="t in detail.results.tierBreakdown" :key="t.tier" class="mb-2 last:mb-0">
                <div class="mb-1 flex items-center justify-between text-xs">
                  <span class="font-semibold text-[var(--ink)]">{{ { Core: '核心知识点', Important: '重要知识点', Standard: '标准知识点' }[t.tier] || t.tier }}</span>
                  <span class="font-bold" :style="{ color: masteryColor(t.percentage) }">{{ t.correct }}/{{ t.total }}</span>
                </div>
                <div class="h-2 overflow-hidden rounded-full bg-[var(--line)]"><div class="score-bar h-full rounded-full" :style="{ width: t.percentage + '%', background: masteryColor(t.percentage) }"></div></div>
              </div>
            </div>

            <div class="clay p-4" v-motion :initial="{ opacity: 0, y: 14 }" :enter="{ opacity: 1, y: 0, transition: { delay: 170 } }">
              <h3 class="mb-3 font-display text-xs font-bold text-[var(--ink-soft)]">知识点分析</h3>
              <div v-for="kp in detail.results.kpBreakdown" :key="kp.kp" class="mb-2 flex items-center gap-3 last:mb-0">
                <GraduationCap class="h-3.5 w-3.5 shrink-0 text-[var(--accent)]" />
                <span class="min-w-0 flex-1 truncate text-xs font-medium text-[var(--ink)]">{{ kp.kp }}</span>
                <div class="shrink-0"><StarDisplay :score="kp.percentage" /></div>
                <span class="shrink-0 text-[10px] font-semibold text-[var(--ink-soft)]">{{ kp.score }}/{{ kp.maxScore }}</span>
                <span v-if="proficiencyMap[kp.kp]" class="flex shrink-0 items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[10px] font-bold" :class="proficiencyMap[kp.kp].after >= proficiencyMap[kp.kp].before ? 'bg-[#e7f7ee] text-[#18a558]' : 'bg-[#fdeaef] text-[#f2557a]'">
                  <span v-if="proficiencyMap[kp.kp].after > proficiencyMap[kp.kp].before">↑</span>
                  <span v-else-if="proficiencyMap[kp.kp].after < proficiencyMap[kp.kp].before">↓</span>
                  <StarDisplay :score="proficiencyMap[kp.kp].after" :animateFrom="proficiencyMap[kp.kp].before" />
                  <span>{{ proficiencyMap[kp.kp].before }}→{{ proficiencyMap[kp.kp].after }}</span>
                </span>
              </div>
            </div>

            <div v-if="detail.results.literacyBreakdown.length" class="clay p-4" v-motion :initial="{ opacity: 0, y: 14 }" :enter="{ opacity: 1, y: 0, transition: { delay: 210 } }">
              <h3 class="mb-3 font-display text-xs font-bold text-[var(--ink-soft)]">核心素养 <span class="font-normal text-[var(--ink-soft)]/60">— 综合能力评价</span></h3>
              <div class="flex flex-wrap gap-3">
                <div v-for="lit in detail.results.literacyBreakdown" :key="lit.literacy" class="flex min-w-[100px] flex-1 flex-col items-center gap-1.5 rounded-xl border border-[var(--line)] px-3 py-3">
                  <span class="text-xs font-semibold text-[var(--ink)]">{{ lit.literacy }}</span>
                  <StarDisplay :score="percent(lit.score, lit.maxScore)" />
                  <span class="text-[10px] font-semibold text-[var(--ink-soft)]">{{ lit.score }}/{{ lit.maxScore }}</span>
                  <span class="inline-block rounded-full px-2 py-0.5 text-[10px] font-bold" :class="percent(lit.score, lit.maxScore) >= 80 ? 'bg-[#e7f7ee] text-[#18a558]' : percent(lit.score, lit.maxScore) >= 60 ? 'bg-[#fef7e6] text-[#e0a92e]' : percent(lit.score, lit.maxScore) >= 40 ? 'bg-[#fef3e2] text-[#f59e42]' : 'bg-[#fdeaef] text-[#f2557a]'">
                    {{ percent(lit.score, lit.maxScore) >= 80 ? '优秀' : percent(lit.score, lit.maxScore) >= 60 ? '良好' : percent(lit.score, lit.maxScore) >= 40 ? '待加强' : '薄弱' }}
                  </span>
                </div>
              </div>
            </div>
          </div>

          <!-- 逐题回顾 -->
          <div class="mb-3 flex items-center justify-between">
            <h3 class="font-display text-sm font-bold text-[var(--ink)]">完整题目与判卷详情</h3>
            <span class="text-xs font-medium text-[var(--ink-soft)]">共 {{ detail.questions.length }} 题</span>
          </div>
          <div class="space-y-3">
            <div v-for="q in detail.questions" :key="q.index" class="clay overflow-hidden" v-motion :initial="{ opacity: 0, y: 12 }" :enter="{ opacity: 1, y: 0, transition: { delay: Math.min(q.index * 30, 400) } }">
              <button @click="toggle(q.index)" class="flex w-full items-center gap-2 bg-[var(--accent-soft)]/60 px-4 py-2.5 text-left transition-colors hover:bg-[var(--accent-soft)]">
                <span class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold"
                  :class="resultMap.get(q.index)?.correct === true ? 'bg-[#e7f7ee] text-[#18a558]' : resultMap.get(q.index)?.correct === false ? 'bg-[#fdeaef] text-[#f2557a]' : 'bg-[var(--accent)] text-white'">
                  <CheckCircle2 v-if="resultMap.get(q.index)?.correct === true" class="h-3.5 w-3.5" />
                  <XCircle v-else-if="resultMap.get(q.index)?.correct === false" class="h-3.5 w-3.5" />
                  <template v-else>{{ q.index + 1 }}</template>
                </span>
                <span class="font-display text-xs font-semibold text-[var(--accent-strong)]">第{{ q.index + 1 }}题 · {{ TYPE_LABELS[q.type] }}</span>
                <span class="ml-auto text-xs font-bold" :style="{ color: masteryColor((resultMap.get(q.index)?.maxScore ?? 0) > 0 ? ((resultMap.get(q.index)?.score ?? 0) / (resultMap.get(q.index)!.maxScore)) * 100 : 0) }">{{ resultMap.get(q.index)?.score ?? 0 }}/{{ q.points }}分</span>
                <component :is="expanded.has(q.index) ? ChevronUp : ChevronDown" class="h-4 w-4 text-[var(--ink-soft)]" />
              </button>

              <div class="space-y-3 px-4 py-3">
                <div v-if="q.passage" class="md-body rounded-xl bg-[var(--surface)] p-3 text-sm leading-relaxed text-[var(--ink-soft)]" v-html="renderMarkdown(q.passage)"></div>
                <div class="md-body text-sm font-medium leading-relaxed text-[var(--ink)]" v-html="renderMarkdown(q.stem)"></div>

                <!-- 选择题 -->
                <div v-if="q.type === 'multiple_choice'" class="space-y-1.5">
                  <div v-for="opt in displayOptions(q)" :key="opt.key"
                    class="review-option flex items-center gap-2.5 rounded-xl border-2 px-3 py-2 text-sm"
                    :class="(q.correctKeys || []).includes(opt.key) ? 'border-[#18a558] bg-[#e7f7ee]'
                      : selectedKeys(q).includes(opt.key) ? 'border-[#f2557a] bg-[#fdeaef]'
                      : 'border-[var(--line)] bg-white'">
                    <span class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold"
                      :class="(q.correctKeys || []).includes(opt.key) ? 'bg-[#18a558] text-white' : selectedKeys(q).includes(opt.key) ? 'bg-[#f2557a] text-white' : 'bg-[var(--accent-soft)] text-[var(--accent-strong)]'">{{ opt.key }}</span>
                    <div class="md-body min-w-0 flex-1 text-[var(--ink)]" v-html="renderMarkdown(opt.text)"></div>
                    <span v-if="(q.correctKeys || []).includes(opt.key)" class="text-[11px] font-semibold text-[#18a558]">正确答案</span>
                    <span v-else-if="selectedKeys(q).includes(opt.key)" class="text-[11px] font-semibold text-[#f2557a]">你的选择</span>
                  </div>
                </div>

                <!-- 判断题 -->
                <div v-else-if="q.type === 'true_false'" class="flex flex-wrap gap-4 text-sm">
                  <span>正确答案：<b :class="q.answer ? 'text-[#18a558]' : 'text-[#f2557a]'">{{ q.answer ? '正确' : '错误' }}</b></span>
                  <span>你的作答：<b :class="userTrueFalse(q) === null ? 'text-[var(--ink-soft)]' : userTrueFalse(q) === q.answer ? 'text-[#18a558]' : 'text-[#f2557a]'">{{ userTrueFalse(q) === null ? '（未作答）' : userTrueFalse(q) ? '正确' : '错误' }}</b></span>
                </div>

                <!-- 填空题 -->
                <div v-else-if="q.type === 'fill_blank'" class="space-y-1.5 text-sm">
                  <div v-for="(b, i) in blankRows(q)" :key="i" class="flex flex-wrap items-center gap-x-3 gap-y-0.5">
                    <span class="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[var(--accent-soft)] text-[11px] font-bold text-[var(--accent-strong)]">{{ i + 1 }}</span>
                    <span>你的作答：<b :class="b.acceptedAnswers.some(ans => ans.trim() && ans.trim() === userBlank(q, i).trim()) ? 'text-[#18a558]' : 'text-[#f2557a]'">{{ userBlank(q, i).trim() || '（空）' }}</b></span>
                    <span class="text-[var(--ink-soft)]">参考：{{ b.acceptedAnswers.join(' / ') }}</span>
                  </div>
                </div>

                <!-- 简答题 -->
                <div v-else-if="q.type === 'short_answer'" class="space-y-2 text-sm">
                  <div class="rounded-xl bg-[var(--surface)] p-3">
                    <p class="mb-1 text-xs font-semibold text-[var(--ink-soft)]">你的作答</p>
                    <p class="whitespace-pre-wrap text-[var(--ink)]">{{ userAnswerText(q) }}</p>
                  </div>
                  <div v-if="q.referenceAnswer" class="rounded-xl bg-[#e7f7ee] p-3">
                    <p class="mb-1 text-xs font-semibold text-[#0e9b76]">参考答案</p>
                    <div class="md-body text-[var(--ink)]" v-html="renderMarkdown(q.referenceAnswer)"></div>
                  </div>
                  <div v-if="q.keyPoints?.length" class="flex flex-wrap gap-1.5">
                    <span v-for="(kp, i) in q.keyPoints" :key="i" class="rounded-full bg-[var(--accent-soft)] px-2.5 py-0.5 text-[11px] font-semibold text-[var(--accent-strong)]">{{ kp }}</span>
                  </div>
                </div>

                <!-- 解析 + 知识点 -->
                <Transition name="reveal">
                  <div v-if="expanded.has(q.index)" class="space-y-2 border-t border-[var(--line)] pt-3">
                    <div v-if="q.explanation" class="rounded-xl bg-[var(--surface)] p-3 text-sm text-[var(--ink)]">
                      <p class="mb-1 text-xs font-semibold text-[var(--ink-soft)]">解析</p>
                      <div class="md-body" v-html="renderMarkdown(q.explanation)"></div>
                    </div>
                    <div class="flex flex-wrap gap-1.5">
                      <span v-if="q.knowledgePoint" class="inline-flex items-center gap-1 rounded-full bg-[#e6edfa] px-2 py-0.5 text-[10px] font-semibold text-[#2b5fa8]"><GraduationCap class="h-2.5 w-2.5" />{{ q.knowledgePoint }}</span>
                      <span v-for="lit in q.literacies || []" :key="lit" class="inline-flex items-center gap-1 rounded-full bg-[#f0e7fa] px-2 py-0.5 text-[10px] font-semibold text-[#7c3aae]"><BrainCircuit class="h-2.5 w-2.5" />{{ lit }}</span>
                    </div>
                  </div>
                </Transition>
              </div>
            </div>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.review-root { display: flex; flex-direction: column; height: 100%; background: transparent; }
.review-option :deep(.md-body > :first-child) { margin-top: 0; }
.review-option :deep(.md-body > :last-child) { margin-bottom: 0; }
.circle-reveal { transition: stroke-dashoffset 0.9s cubic-bezier(0.34, 1.56, 0.64, 1); }
.score-bar { transition: width 0.75s cubic-bezier(0.34, 1.56, 0.64, 1); }
.analysis-body :deep(h1),
.analysis-body :deep(h2),
.analysis-body :deep(h3) { margin: 0.45rem 0 0.25rem; font-family: var(--font-display); font-size: 0.88rem; font-weight: 800; color: var(--ink); }
.analysis-body :deep(p) { margin: 0.25rem 0; }
.analysis-body :deep(ul),
.analysis-body :deep(ol) { margin: 0.35rem 0; padding-left: 1.2rem; }
.reveal-enter-active { transition: all 0.25s ease; overflow: hidden; }
.reveal-leave-active { transition: all 0.15s ease; overflow: hidden; }
.reveal-enter-from, .reveal-leave-to { opacity: 0; max-height: 0; }
@media (prefers-reduced-motion: reduce) {
  .circle-reveal, .score-bar, .reveal-enter-active, .reveal-leave-active { transition: none; }
}
</style>
