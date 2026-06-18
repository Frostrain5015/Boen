<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import Mascot from '@/components/Mascot.vue';
import { CheckCircle2, XCircle, Sparkles, Clock, AlertTriangle, BarChart3, GraduationCap, BrainCircuit, ChevronDown, ChevronUp, Send, ArrowLeft } from 'lucide-vue-next';
import type { QuestionType, AnswerPayload } from '@boen/shared';
import { getToken } from '@/services/auth';
import { streamExamGenerate } from '@/services/chat';

interface ExamConfigData {
  subject: 'chinese' | 'math' | 'english' | 'science';
  grade: string;
  difficulty: string;
  durationMinutes: number;
}

interface ExamQuestionData {
  index: number;
  type: QuestionType;
  points: number;
  stem: string;
  passage?: string;
  options?: { key: string; text: string }[];
  multiSelect?: boolean;
  blankCount?: number;
  knowledgePoint?: string;
  difficulty?: string;
}

interface ExamSessionData {
  examId: string;
  title: string;
  totalQuestions: number;
  totalScore: number;
  durationMinutes: number;
  questions: ExamQuestionData[];
}

interface ExamResultsData {
  totalScore: number;
  maxScore: number;
  percentage: number;
  grade: string;
  questionResults: Array<{
    index: number; correct: boolean | null; score: number; maxScore: number;
    reference: string; explanation: string; knowledgePoint?: string; literacy?: string[];
  }>;
  tierBreakdown: Array<{ tier: string; correct: number; total: number; percentage: number }>;
  kpBreakdown: Array<{ kp: string; score: number; maxScore: number; percentage: number }>;
  literacyBreakdown: Array<{ literacy: string; score: number; maxScore: number }>;
}

const emit = defineEmits<{ (e: 'back'): void; (e: 'refresh'): void }>();

const examState = ref<'config' | 'generating' | 'taking' | 'grading' | 'results'>('config');
const config = ref<ExamConfigData>({ subject: 'math', grade: '7', difficulty: 'medium', durationMinutes: 45 });
const session = ref<ExamSessionData | null>(null);
const results = ref<ExamResultsData | null>(null);
const answers = ref<Map<number, any>>(new Map());
const timer = ref(0);
const timerInterval = ref<ReturnType<typeof setInterval> | null>(null);
const expandedResults = ref<Set<number>>(new Set());
const genProgress = ref({ step: 'analyze' as 'analyze' | 'write' | 'review', message: '', progress: 0 });

const SUBJECTS = [
  { value: 'chinese' as const, label: '语文', emoji: '📖' },
  { value: 'math' as const, label: '数学', emoji: '🔢' },
  { value: 'english' as const, label: '英语', emoji: '🔤' },
  { value: 'science' as const, label: '科学', emoji: '🔬' },
];
const GRADES = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
const DIFFICULTIES = [
  { value: 'easy', label: '简单', emoji: '🌱' },
  { value: 'medium', label: '中等', emoji: '⚖️' },
  { value: 'hard', label: '困难', emoji: '🔥' },
];
const DURATIONS = [20, 30, 45, 60];

const subjectIndex = computed(() => SUBJECTS.findIndex((s) => s.value === config.value.subject));
const answeredCount = computed(() => {
  let c = 0;
  for (const q of session.value?.questions ?? []) {
    const a = answers.value.get(q.index);
    if (a !== undefined && a !== null) {
      if (q.type === 'fill_blank' && Array.isArray(a) && a.some((v: string) => v.trim())) c++;
      else if (q.type === 'short_answer' && typeof a === 'string' && a.trim()) c++;
      else if (q.type === 'true_false' && typeof a === 'boolean') c++;
      else if (q.type === 'multiple_choice' && Array.isArray(a) && a.length > 0) c++;
      else c++;
    }
  }
  return c;
});
const timerDisplay = computed(() => {
  const m = Math.floor(timer.value / 60);
  const s = timer.value % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
});
const timerUrgent = computed(() => timer.value < 300 && timer.value > 0);

function gradeLabel(g: string): string {
  const n = Number(g);
  return n <= 6 ? `小${'一二三四五六'[n - 1]}` : `初${'一二三'[n - 7]}`;
}

function masteryColor(ws: number): string {
  if (ws < 40) return '#f2557a'; if (ws < 60) return '#f59e42'; if (ws < 80) return '#e0a92e'; return '#18a558';
}

function setAnswer(qIndex: number, value: any) {
  const m = new Map(answers.value);
  m.set(qIndex, value);
  answers.value = m;
}

function getAnswer(qIndex: number) {
  return answers.value.get(qIndex);
}

/** 把前端存储的原始作答值规整为后端期望的 AnswerPayload；留空返回 null（视为未作答） */
function toAnswerPayload(type: QuestionType, raw: unknown): AnswerPayload | null {
  if (raw === undefined || raw === null) return null;
  if (type === 'multiple_choice') {
    return Array.isArray(raw) && raw.length ? { type, selectedKeys: raw as string[] } : null;
  }
  if (type === 'fill_blank') {
    const arr = Array.isArray(raw) ? (raw as string[]) : [];
    return arr.some((s) => String(s ?? '').trim()) ? { type, answers: arr } : null;
  }
  if (type === 'true_false') {
    return typeof raw === 'boolean' ? { type, value: raw } : null;
  }
  if (type === 'short_answer') {
    return typeof raw === 'string' && raw.trim() ? { type, text: raw } : null;
  }
  return null;
}

function startTimer(minutes: number) {
  timer.value = minutes * 60;
  if (timerInterval.value) clearInterval(timerInterval.value);
  timerInterval.value = setInterval(() => {
    timer.value--;
    if (timer.value <= 0) {
      clearInterval(timerInterval.value!);
      timerInterval.value = null;
      submitExam();
    }
  }, 1000);
}

interface ExamReadyData { examId: string; title: string; totalQuestions: number; totalScore: number; durationMinutes: number }

async function generateExamPaper() {
  examState.value = 'generating';
  genProgress.value = { step: 'analyze', message: '正在准备…', progress: 0 };
  let ready: ExamReadyData | undefined;
  let errMsg = '';
  try {
    await streamExamGenerate(config.value, (e) => {
      if (e.type === 'exam_progress') {
        genProgress.value = { step: e.step, message: e.message, progress: e.progress };
      } else if (e.type === 'exam_ready') {
        ready = { examId: e.examId, title: e.title, totalQuestions: e.totalQuestions, totalScore: e.totalScore, durationMinutes: e.durationMinutes };
      } else if (e.type === 'error') {
        errMsg = e.message;
      }
    });
    if (errMsg) throw new Error(errMsg);
    const r = ready as ExamReadyData | undefined;
    if (!r) throw new Error('生成试卷失败：未收到试卷数据');
    session.value = {
      examId: r.examId, title: r.title,
      totalQuestions: r.totalQuestions, totalScore: r.totalScore,
      durationMinutes: r.durationMinutes, questions: [],
    };
    await loadQuestions(r.examId);
    examState.value = 'taking';
    startTimer(r.durationMinutes);
    emit('refresh'); // 新试卷已入库，刷新侧栏考试列表
  } catch (err) {
    alert('生成试卷失败: ' + (err instanceof Error ? err.message : String(err)));
    examState.value = 'config';
  }
}

async function submitExam() {
  if (timerInterval.value) { clearInterval(timerInterval.value); timerInterval.value = null; }
  if (!session.value) return;
  examState.value = 'grading';
  // 只提交已作答的题（留空的题跳过，由后端按未作答计 0 分）
  const answerArray: { questionIndex: number; answer: AnswerPayload }[] = [];
  for (const q of session.value.questions) {
    const payload = toAnswerPayload(q.type, answers.value.get(q.index));
    if (payload) answerArray.push({ questionIndex: q.index, answer: payload });
  }
  try {
    const res = await fetch('/api/exam/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ examId: session.value.examId, answers: answerArray }),
    });
    const data = await res.json();
    if (data.results) { results.value = data.results; examState.value = 'results'; emit('refresh'); }
    else throw new Error(data.error || '提交失败');
  } catch (err) {
    alert('提交失败: ' + (err instanceof Error ? err.message : String(err)));
    examState.value = 'taking';
  }
}

function goBack() { examState.value = 'config'; if (timerInterval.value) { clearInterval(timerInterval.value); timerInterval.value = null; } }
function toggleResult(qIndex: number) {
  const s = new Set(expandedResults.value);
  if (s.has(qIndex)) s.delete(qIndex); else s.add(qIndex);
  expandedResults.value = s;
}

async function loadQuestions(examId: string) {
  try {
    const res = await fetch(`/api/exam/${examId}`, { headers: authHeaders() });
    const data = await res.json();
    if (data.exam?.questions && session.value) {
      session.value = { ...session.value, questions: data.exam.questions };
    }
  } catch {}
}

function authHeaders(): Record<string, string> {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

onUnmounted(() => { if (timerInterval.value) clearInterval(timerInterval.value); });
</script>

<template>
  <div class="exam-root" v-motion :initial="{ opacity: 0 }" :enter="{ opacity: 1, transition: { duration: 300 } }">
    <!-- ═══ CONFIG ═══ -->
    <div v-if="examState === 'config'" class="flex h-full flex-col items-center justify-center p-6">
      <div class="clay w-full max-w-lg overflow-hidden" v-motion :initial="{ opacity: 0, y: 20 }" :enter="{ opacity: 1, y: 0, transition: { delay: 100 } }">
        <div class="border-b border-[var(--line)] px-6 py-4">
          <div class="flex items-center gap-2">
            <button @click="$emit('back')" class="flex h-8 w-8 items-center justify-center rounded-full transition-colors hover:bg-[var(--line)]/50"><ArrowLeft class="h-4 w-4 text-[var(--ink-soft)]" /></button>
            <h2 class="font-display text-base font-bold text-[var(--ink)]">考试模式</h2>
          </div>
        </div>
        <div class="space-y-5 px-6 py-5">
          <div>
            <p class="mb-2 text-xs font-semibold text-[var(--ink-soft)]">学科</p>
            <div class="clay-sm relative flex bg-[var(--surface)] p-1">
              <span class="absolute top-1 bottom-1 left-1 w-16 rounded-[14px] bg-accent" :style="{ transform: `translateX(calc(${subjectIndex} * 4rem))`, transition: 'transform 0.4s cubic-bezier(0.34, 1.56, 0.64, 1)' }"></span>
              <button v-for="s in SUBJECTS" :key="s.value" @click="config.subject = s.value" class="relative z-10 flex w-16 items-center justify-center gap-1 rounded-[14px] py-1.5 font-display text-sm font-semibold transition-colors" :class="config.subject === s.value ? 'text-white' : 'text-[var(--ink-soft)] hover:text-[var(--ink)]'"><span>{{ s.emoji }}</span>{{ s.label }}</button>
            </div>
          </div>
          <div>
            <p class="mb-2 text-xs font-semibold text-[var(--ink-soft)]">年级</p>
            <select v-model="config.grade" class="w-full rounded-xl border border-[var(--line)] bg-white px-3 py-2 text-sm font-semibold text-[var(--ink)] outline-none transition-colors focus:border-[var(--accent)] focus:shadow-[0_0_0_3px_var(--accent-soft)]">
              <option v-for="g in GRADES" :key="g" :value="g">{{ gradeLabel(g) }}</option>
            </select>
          </div>
          <div>
            <p class="mb-2 text-xs font-semibold text-[var(--ink-soft)]">难度</p>
            <div class="flex gap-2">
              <button v-for="d in DIFFICULTIES" :key="d.value" @click="config.difficulty = d.value" class="flex flex-1 items-center justify-center gap-1.5 rounded-2xl border-2 py-2.5 font-display text-sm font-bold transition-all active:scale-[0.97]" :class="config.difficulty === d.value ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent-strong)]' : 'border-[var(--line)] bg-white text-[var(--ink-soft)] hover:border-[var(--accent)]'">{{ d.emoji }} {{ d.label }}</button>
            </div>
          </div>
          <div>
            <p class="mb-2 text-xs font-semibold text-[var(--ink-soft)]">限时</p>
            <div class="flex gap-2">
              <button v-for="d in DURATIONS" :key="d" @click="config.durationMinutes = d" class="flex flex-1 items-center justify-center gap-1.5 rounded-2xl border-2 py-2.5 font-display text-sm font-bold transition-all active:scale-[0.97]" :class="config.durationMinutes === d ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent-strong)]' : 'border-[var(--line)] bg-white text-[var(--ink-soft)] hover:border-[var(--accent)]'"><Clock class="h-3.5 w-3.5" />{{ d }}分钟</button>
            </div>
          </div>
        </div>
        <div class="border-t border-[var(--line)] px-6 py-4">
          <button @click="generateExamPaper" class="btn-accent flex w-full items-center justify-center gap-2 rounded-2xl py-3 font-display text-sm font-bold"><Sparkles class="h-4 w-4" /> 生成试卷</button>
        </div>
      </div>
    </div>

    <!-- ═══ GENERATING（分步进度） ═══ -->
    <div v-if="examState === 'generating'" class="flex h-full flex-col items-center justify-center">
      <div class="flex flex-col items-center gap-6" v-motion :initial="{ opacity: 0, scale: 0.9 }" :enter="{ opacity: 1, scale: 1, transition: { delay: 100, duration: 500 } }">
        <Mascot :size="80" state="thinking" />
        <div class="w-72 space-y-3">
          <div class="flex items-center gap-3" :class="genProgress.step === 'analyze' || genProgress.progress > 20 ? 'opacity-100' : 'opacity-40'">
            <span class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold" :class="genProgress.progress > 20 ? 'bg-[#18a558] text-white' : 'bg-[var(--accent-soft)] text-[var(--accent-strong)]'">{{ genProgress.progress > 20 ? '✓' : '1' }}</span>
            <span class="flex-1 font-display text-sm font-semibold text-[var(--ink)]">分析知识图谱</span>
            <span v-if="genProgress.step === 'analyze'" class="h-2 w-2 animate-pulse rounded-full bg-[var(--accent)]"></span>
          </div>
          <div class="flex items-center gap-3" :class="genProgress.step === 'write' || genProgress.progress > 85 ? 'opacity-100' : 'opacity-40'">
            <span class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold" :class="genProgress.progress > 85 ? 'bg-[#18a558] text-white' : genProgress.step === 'write' ? 'bg-[var(--accent)] text-white' : 'bg-[var(--accent-soft)] text-[var(--accent-strong)]'">{{ genProgress.progress > 85 ? '✓' : '2' }}</span>
            <span class="flex-1 font-display text-sm font-semibold text-[var(--ink)]">分步编写试题</span>
            <span v-if="genProgress.step === 'write'" class="h-2 w-2 animate-pulse rounded-full bg-[var(--accent)]"></span>
          </div>
          <div class="flex items-center gap-3" :class="genProgress.step === 'review' || genProgress.progress >= 100 ? 'opacity-100' : 'opacity-40'">
            <span class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold" :class="genProgress.progress >= 100 ? 'bg-[#18a558] text-white' : genProgress.step === 'review' ? 'bg-[var(--accent)] text-white' : 'bg-[var(--accent-soft)] text-[var(--accent-strong)]'">{{ genProgress.progress >= 100 ? '✓' : '3' }}</span>
            <span class="flex-1 font-display text-sm font-semibold text-[var(--ink)]">再次审核试题</span>
            <span v-if="genProgress.step === 'review'" class="h-2 w-2 animate-pulse rounded-full bg-[var(--accent)]"></span>
          </div>
        </div>
        <div class="h-1.5 w-72 overflow-hidden rounded-full bg-[var(--line)]">
          <div class="h-full rounded-full bg-[var(--accent)] transition-all duration-500 ease-out" :style="{ width: genProgress.progress + '%' }"></div>
        </div>
        <p class="text-sm font-medium text-[var(--ink-soft)]">{{ genProgress.message }}</p>
      </div>
    </div>

    <!-- ═══ TAKING ═══ -->
    <div v-if="examState === 'taking' && session" class="flex h-full flex-col">
      <div class="flex items-center gap-3 border-b border-[var(--line)] bg-[var(--surface)] px-5 py-3">
        <button @click="goBack" class="flex h-8 w-8 items-center justify-center rounded-full transition-colors hover:bg-[var(--line)]/50"><ArrowLeft class="h-4 w-4 text-[var(--ink-soft)]" /></button>
        <div class="flex-1 truncate font-display text-sm font-bold text-[var(--ink)]">{{ session.title }}</div>
        <div class="flex items-center gap-3">
          <span class="text-xs font-medium text-[var(--ink-soft)]">{{ answeredCount }}/{{ session.totalQuestions }}</span>
          <div class="flex items-center gap-1.5 rounded-xl px-3 py-1.5 font-display text-sm font-bold transition-colors" :class="timerUrgent ? 'bg-[#fdeaef] text-[#f2557a] animate-pulse' : 'bg-[var(--accent-soft)] text-[var(--accent-strong)]'">
            <Clock class="h-4 w-4" />
            <span>{{ timerDisplay }}</span>
          </div>
        </div>
      </div>
      <div class="flex-1 overflow-y-auto px-4 py-4">
        <div class="mx-auto max-w-2xl space-y-4">
          <div v-for="q in session.questions" :key="q.index" class="clay overflow-hidden" v-motion :initial="{ opacity: 0, y: 16 }" :enter="{ opacity: 1, y: 0, transition: { delay: Math.min(q.index * 40, 500) } }">
            <div class="flex items-center gap-2 bg-[var(--accent-soft)] px-4 py-2.5">
              <span class="flex h-6 w-6 items-center justify-center rounded-full bg-[var(--accent)] text-xs font-bold text-white">{{ q.index + 1 }}</span>
              <span class="font-display text-xs font-semibold text-[var(--accent-strong)]">{{ { multiple_choice: '选择题', fill_blank: '填空题', true_false: '判断题', short_answer: '简答题' }[q.type] }}</span>
              <span class="ml-auto text-xs font-medium text-[var(--ink-soft)]">{{ q.points }}分</span>
            </div>
            <div class="space-y-3 px-4 py-3">
              <div v-if="q.passage" class="passage-block text-sm" :class="config.subject === 'chinese' ? 'passage-block-chi' : config.subject === 'english' ? 'passage-block-eng' : ''">{{ q.passage }}</div>
              <p class="text-sm font-medium leading-relaxed text-[var(--ink)]">{{ q.stem }}</p>

              <!-- Multiple Choice -->
              <div v-if="q.type === 'multiple_choice'" class="space-y-2">
                <button v-for="opt in q.options" :key="opt.key" @click="setAnswer(q.index, q.multiSelect ? [...(getAnswer(q.index) || []), opt.key].filter((k, i, a) => a.indexOf(k) === i) : [opt.key])"
                  class="flex w-full items-center gap-3 rounded-2xl border-2 px-4 py-2.5 text-left text-sm transition-all active:scale-[0.98]"
                  :class="(getAnswer(q.index) || []).includes(opt.key) ? 'border-[var(--accent)] bg-[var(--accent-soft)]' : 'border-[var(--line)] bg-white hover:border-[var(--accent)]'"
                ><span class="flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold" :class="(getAnswer(q.index) || []).includes(opt.key) ? 'bg-[var(--accent)] text-white' : 'bg-[var(--accent-soft)] text-[var(--accent-strong)]'">{{ opt.key }}</span><span>{{ opt.text }}</span></button>
                <p v-if="q.multiSelect" class="text-xs text-[var(--ink-soft)]">可多选</p>
              </div>

              <!-- True/False -->
              <div v-if="q.type === 'true_false'" class="flex gap-3">
                <button v-for="opt in [{ v: true, l: '正确' }, { v: false, l: '错误' }]" :key="String(opt.v)" @click="setAnswer(q.index, opt.v)" class="flex-1 rounded-2xl border-2 py-3 text-center font-display text-sm font-bold transition-all" :class="getAnswer(q.index) === opt.v ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent-strong)]' : 'border-[var(--line)] bg-white text-[var(--ink-soft)] hover:border-[var(--accent)]'">{{ opt.l }}</button>
              </div>

              <!-- Fill Blank -->
              <div v-if="q.type === 'fill_blank'" class="space-y-2">
                <div v-for="i in q.blankCount" :key="i" class="flex items-center gap-2">
                  <span class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--accent-soft)] text-xs font-bold text-[var(--accent-strong)]">{{ i }}</span>
                  <input :value="(getAnswer(q.index) || [])[i - 1] || ''" @input="(e) => { const v = getAnswer(q.index) || Array(q.blankCount).fill(''); v[i - 1] = (e.target as HTMLInputElement).value; setAnswer(q.index, v); }" class="flex-1 rounded-xl border border-[var(--line)] px-3 py-2 text-sm outline-none transition-colors focus:border-[var(--accent)] focus:shadow-[0_0_0_3px_var(--accent-soft)]" placeholder="填写答案" />
                </div>
              </div>

              <!-- Short Answer -->
              <div v-if="q.type === 'short_answer'">
                <textarea :value="getAnswer(q.index) || ''" @input="(e) => setAnswer(q.index, (e.target as HTMLTextAreaElement).value)" rows="3" class="w-full rounded-xl border border-[var(--line)] px-3 py-2 text-sm outline-none transition-colors focus:border-[var(--accent)] focus:shadow-[0_0_0_3px_var(--accent-soft)]" placeholder="写下你的答案…" />
              </div>
            </div>
          </div>
        </div>
      </div>
      <div class="border-t border-[var(--line)] bg-[var(--surface)] px-4 py-3">
        <div class="mx-auto flex max-w-2xl items-center justify-between">
          <span class="text-xs font-medium text-[var(--ink-soft)]">已答 {{ answeredCount }}/{{ session.totalQuestions }} 题</span>
          <button @click="submitExam" class="btn-accent flex items-center gap-2 rounded-2xl px-6 py-2.5 font-display text-sm font-bold"><Send class="h-4 w-4" /> 提交全部</button>
        </div>
      </div>
    </div>

    <!-- ═══ GRADING ═══ -->
    <div v-if="examState === 'grading'" class="flex h-full flex-col items-center justify-center">
      <div class="flex flex-col items-center gap-4">
        <Mascot :size="90" state="thinking" />
        <p class="font-display text-lg font-bold text-[var(--ink)]">批改中…</p>
        <div class="h-1.5 w-48 overflow-hidden rounded-full bg-[var(--line)]"><div class="h-full w-full origin-left animate-pulse rounded-full bg-[var(--accent)]"></div></div>
      </div>
    </div>

    <!-- ═══ RESULTS ═══ -->
    <div v-if="examState === 'results' && results" class="flex h-full flex-col overflow-y-auto">
      <div class="mx-auto w-full max-w-2xl space-y-4 p-4">
        <!-- Score Hero -->
        <div class="clay p-6 text-center" v-motion :initial="{ opacity: 0, scale: 0.9 }" :enter="{ opacity: 1, scale: 1, transition: { type: 'spring', stiffness: 260, damping: 20 } }">
          <div class="relative mx-auto mb-3 h-28 w-28">
            <svg class="h-full w-full -rotate-90" viewBox="0 0 120 120">
              <circle cx="60" cy="60" r="54" fill="none" stroke="var(--line)" stroke-width="8" />
              <circle cx="60" cy="60" r="54" fill="none" :stroke="masteryColor(results.percentage)" stroke-width="8" stroke-linecap="round" :stroke-dasharray="2 * Math.PI * 54" :stroke-dashoffset="2 * Math.PI * 54 * (1 - results.percentage / 100)" class="transition-all duration-1000 ease-out" />
            </svg>
            <div class="absolute inset-0 flex flex-col items-center justify-center">
              <span class="font-display text-3xl font-bold" :style="{ color: masteryColor(results.percentage) }">{{ results.percentage }}</span>
              <span class="text-[10px] font-medium text-[var(--ink-soft)]">分</span>
            </div>
          </div>
          <span class="inline-block rounded-full px-4 py-1 font-display text-sm font-bold" :class="results.grade === '优秀' ? 'bg-[#e7f7ee] text-[#18a558]' : results.grade === '良好' ? 'bg-[#fef7e6] text-[#e0a92e]' : results.grade === '及格' ? 'bg-[#fef3e2] text-[#f59e42]' : 'bg-[#fdeaef] text-[#f2557a]'">{{ results.grade }}</span>
          <div class="mt-3 text-xs text-[var(--ink-soft)]">{{ results.totalScore }}/{{ results.maxScore }} 分</div>
        </div>

        <!-- Tier Breakdown -->
        <div class="clay p-4" v-motion :initial="{ opacity: 0, y: 16 }" :enter="{ opacity: 1, y: 0, transition: { delay: 150 } }">
          <h3 class="mb-3 font-display text-xs font-bold text-[var(--ink-soft)]">权重层级得分</h3>
          <div v-for="t in results.tierBreakdown" :key="t.tier" class="mb-2 last:mb-0">
            <div class="mb-1 flex items-center justify-between text-xs">
              <span class="font-semibold text-[var(--ink)]">{{ { Core: '核心知识点', Important: '重要知识点', Standard: '标准知识点' }[t.tier] || t.tier }}</span>
              <span class="font-bold" :style="{ color: masteryColor(t.percentage) }">{{ t.correct }}/{{ t.total }}</span>
            </div>
            <div class="h-2 overflow-hidden rounded-full bg-[var(--line)]"><div class="h-full rounded-full transition-all duration-700" :style="{ width: t.percentage + '%', background: masteryColor(t.percentage) }"></div></div>
          </div>
        </div>

        <!-- KP Breakdown -->
        <div class="clay p-4" v-motion :initial="{ opacity: 0, y: 16 }" :enter="{ opacity: 1, y: 0, transition: { delay: 200 } }">
          <h3 class="mb-3 font-display text-xs font-bold text-[var(--ink-soft)]">知识点分析</h3>
          <div v-for="kp in results.kpBreakdown" :key="kp.kp" class="mb-2 flex items-center gap-3 last:mb-0">
            <GraduationCap class="h-3.5 w-3.5 shrink-0 text-[var(--accent)]" />
            <span class="flex-1 text-xs font-medium text-[var(--ink)]">{{ kp.kp }}</span>
            <div class="h-1.5 w-16 overflow-hidden rounded-full bg-[var(--line)]"><div class="h-full rounded-full" :style="{ width: kp.percentage + '%', background: masteryColor(kp.percentage) }"></div></div>
            <span class="text-xs font-bold" :style="{ color: masteryColor(kp.percentage) }">{{ kp.percentage }}%</span>
          </div>
        </div>

        <!-- Literacy Breakdown -->
        <div class="clay p-4" v-motion :initial="{ opacity: 0, y: 16 }" :enter="{ opacity: 1, y: 0, transition: { delay: 250 } }">
          <h3 class="mb-3 font-display text-xs font-bold text-[var(--ink-soft)]">核心素养</h3>
          <div class="flex flex-wrap gap-2">
            <span v-for="lit in results.literacyBreakdown" :key="lit.literacy" class="inline-flex items-center gap-1.5 rounded-full bg-[#f0e7fa] px-3 py-1.5 text-xs font-semibold text-[#7c3aae]"><BrainCircuit class="h-3 w-3" />{{ lit.literacy }} <span class="opacity-60">{{ lit.score }}/{{ lit.maxScore }}</span></span>
          </div>
        </div>

        <!-- Per-Question Details -->
        <div class="clay overflow-hidden" v-motion :initial="{ opacity: 0, y: 16 }" :enter="{ opacity: 1, y: 0, transition: { delay: 300 } }">
          <div class="border-b border-[var(--line)] px-4 py-3"><h3 class="font-display text-xs font-bold text-[var(--ink-soft)]">逐题详情</h3></div>
          <div v-for="qr in results.questionResults" :key="qr.index" class="border-b border-[var(--line)] last:border-b-0">
            <button @click="toggleResult(qr.index)" class="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-[var(--accent-soft)]/30">
              <span class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold" :class="qr.correct ? 'bg-[#e7f7ee] text-[#18a558]' : 'bg-[#fdeaef] text-[#f2557a]'">{{ qr.correct ? '✓' : '✗' }}</span>
              <span class="flex-1 truncate text-xs font-medium text-[var(--ink)]">第 {{ qr.index + 1 }} 题</span>
              <span v-if="qr.knowledgePoint" class="hidden truncate text-[10px] text-[var(--ink-soft)] sm:block">{{ qr.knowledgePoint }}</span>
              <span class="text-xs font-bold" :class="qr.correct ? 'text-[#18a558]' : 'text-[#f2557a]'">{{ qr.score }}/{{ qr.maxScore }}</span>
              <component :is="expandedResults.has(qr.index) ? ChevronUp : ChevronDown" class="h-3.5 w-3.5 text-[var(--ink-soft)]" />
            </button>
            <Transition name="reveal">
              <div v-if="expandedResults.has(qr.index)" class="border-t border-[var(--line)] bg-[var(--surface)] px-4 py-3">
                <div class="space-y-2 text-xs">
                  <p><span class="font-semibold text-[var(--ink-soft)]">参考答案：</span><span class="text-[var(--ink)]">{{ qr.reference }}</span></p>
                  <div v-if="qr.explanation" class="rounded-xl bg-white p-3 text-[var(--ink)]">{{ qr.explanation }}</div>
                  <div v-if="qr.knowledgePoint" class="flex flex-wrap gap-1.5">
                    <span class="inline-flex items-center gap-1 rounded-full bg-[#e6edfa] px-2 py-0.5 text-[10px] font-semibold text-[#2b5fa8]"><GraduationCap class="h-2.5 w-2.5" />{{ qr.knowledgePoint }}</span>
                    <span v-for="lit in qr.literacy" :key="lit" class="inline-flex items-center gap-1 rounded-full bg-[#f0e7fa] px-2 py-0.5 text-[10px] font-semibold text-[#7c3aae]"><BrainCircuit class="h-2.5 w-2.5" />{{ lit }}</span>
                  </div>
                </div>
              </div>
            </Transition>
          </div>
        </div>

        <!-- Back Button -->
        <div class="pb-6 text-center">
          <button @click="examState = 'config'; session = null; results = null; answers = new Map()" class="inline-flex items-center gap-2 rounded-2xl border border-[var(--line)] bg-white px-6 py-2.5 font-display text-sm font-semibold text-[var(--ink)] transition-all hover:border-[var(--accent)] hover:bg-[var(--accent-soft)] active:scale-[0.97]"><ArrowLeft class="h-4 w-4" /> 返回首页</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.exam-root { height: 100%; background: transparent; overflow-y: auto; }
.loading-mascot { animation: loadingFloat 2.4s ease-in-out infinite; }
@keyframes loadingFloat { 0%,100% { transform: translateY(0) scale(1); } 50% { transform: translateY(-8px) scale(1.03); } }
.loading-bar { width: 120px; height: 3px; background: var(--line); border-radius: 99px; overflow: hidden; }
.loading-bar-inner { width: 40%; height: 100%; border-radius: 99px; background: linear-gradient(90deg, var(--accent-soft), var(--accent), var(--accent-strong)); animation: loadingSlide 1.4s ease-in-out infinite; }
@keyframes loadingSlide { 0% { transform: translateX(-30%); } 100% { transform: translateX(260%); } }
.reveal-enter-active { transition: all 0.25s ease; overflow: hidden; }
.reveal-leave-active { transition: all 0.15s ease; overflow: hidden; }
.reveal-enter-from, .reveal-leave-to { opacity: 0; max-height: 0; }
.passage-block { border-radius: 14px; padding: 0.9rem 1.1rem; line-height: 1.8; font-size: 0.9rem; }
.passage-block-chi { font-family: 'KaiTi','STKaiti',serif; background: #fff8f0; border: 1.5px solid #f0dcc0; color: #5c4a32; }
.passage-block-eng { font-family: 'Georgia','Times New Roman',serif; background: #f5f0ff; border: 1.5px solid #d8cce8; color: #3d2e5c; }
</style>
