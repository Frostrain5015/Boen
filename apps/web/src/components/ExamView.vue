<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue';
import Mascot from '@/components/Mascot.vue';
import { CheckCircle2, XCircle, Sparkles, Clock, AlertTriangle, BarChart3, GraduationCap, BrainCircuit, ChevronDown, ChevronUp, Send, ArrowLeft } from 'lucide-vue-next';
import type { QuestionType, AnswerPayload } from '@boen/shared';
import { getToken } from '@/services/auth';
import { streamExamGenerate } from '@/services/chat';
import { renderMarkdown, renderMarkdownInline } from '@/lib/markdown';
import { processTikzDiagrams } from '@/lib/tikz';
import { useToast } from '@/composables/useToast';

const toast = useToast();

interface ExamConfigData {
  subject: 'chinese' | 'math' | 'english' | 'science';
  grade: string;
  durationMinutes: number;
  notes: string;
}

interface ExamQuestionData {
  index: number;
  type: QuestionType;
  points: number;
  stem: string;
  passage?: string;
  options?: { key: string; text: string }[];
  correctKeys?: string[];
  multiSelect?: boolean;
  blanks?: { acceptedAnswers: string[] }[];
  blankCount?: number;
  answer?: boolean;
  referenceAnswer?: string;
  keyPoints?: string[];
  knowledgePoint?: string;
  knowledgePointId?: number;
  literacies?: string[];
  difficulty?: string;
  explanation?: string;
  groupId?: number;
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
  literacyBreakdown: Array<{ literacy: string; score: number; maxScore: number; percentage: number }>;
  analysis?: string;
  proficiencyChanges?: Array<{ kpTitle: string; before: number; after: number; score: number; maxScore: number }>;
}

const emit = defineEmits<{ (e: 'back'): void; (e: 'refresh'): void }>();

const examState = ref<'config' | 'generating' | 'ready' | 'taking' | 'grading' | 'graded' | 'results'>('config');
const config = ref<ExamConfigData>({ subject: 'math', grade: '7', durationMinutes: 45, notes: '' });

// 从档案传入的考试备注（章节测试/卷册测试），组件挂载时自动填入
const props = defineProps<{ autoNotes?: string }>();
if (props.autoNotes) { config.value.notes = props.autoNotes; }
const session = ref<ExamSessionData | null>(null);
const results = ref<ExamResultsData | null>(null);
const answers = ref<Map<number, any>>(new Map());
const timer = ref(0);
const timerInterval = ref<ReturnType<typeof setInterval> | null>(null);
const expandedResults = ref<Set<number>>(new Set());
const genProgress = ref({ step: 'blueprint' as 'blueprint' | 'write' | 'review' | 'regenerate' | 'complete' | 'analyze', message: '', progress: 0 });
const scoreRevealed = ref(false);

/** 将题目按 groupId 分组，无 groupId 的每题自成一组 */
const groupedQuestions = computed(() => {
  const qs = session.value?.questions ?? [];
  const groups: Array<{ groupId?: number; passage?: string; questions: ExamQuestionData[] }> = [];
  let current: { groupId: number | undefined; passage: string | undefined; questions: ExamQuestionData[] } | null = null;
  for (const q of qs) {
    if (current && q.groupId !== undefined && current.groupId === q.groupId) {
      current.questions.push(q);
    } else {
      current = { groupId: q.groupId, passage: q.passage, questions: [q] };
      groups.push(current);
    }
  }
  return groups;
});

const SUBJECTS = [
  { value: 'chinese' as const, label: '语文', emoji: '📖' },
  { value: 'math' as const, label: '数学', emoji: '🔢' },
  { value: 'english' as const, label: '英语', emoji: '🔤' },
  { value: 'science' as const, label: '科学', emoji: '🔬' },
];
const GRADES = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
const DURATIONS = [
  { value: 15, label: '巩固自测', emoji: '📝' },
  { value: 45, label: '单元考试', emoji: '📚' },
  { value: 90, label: '期末考试', emoji: '🎯' },
];

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

/** 步骤是否已完成（依据进度阈值） */
function stepDone(step: string): boolean {
  const p = genProgress.value.progress;
  if (step === 'blueprint') return p > 20;
  if (step === 'write') return p > 85;
  if (step === 'review') return p >= 100;
  if (step === 'regenerate') return p >= 100;
  if (step === 'complete') return p >= 100;
  return false;
}
/** 步骤当前状态: 'pending' | 'active' | 'done' */
function stepState(step: string): 'pending' | 'active' | 'done' {
  if (stepDone(step)) return 'done';
  // review 之后还有 regenerate/complete 阶段，但 UI 只显示三步
  // 让 review 在 regenerate/complete 期间仍保持 active 状态
  if (step === 'review' && ['regenerate', 'complete'].includes(genProgress.value.step)) return 'active';
  return genProgress.value.step === step ? 'active' : 'pending';
}
/** 步骤圆点样式 class */
function dotCls(step: string): string {
  const s = stepState(step);
  if (s === 'done') return 'dot-done';
  if (s === 'active') return 'dot-active';
  return 'dot-pending';
}
/** 步骤圆点图标 */
function dotIcon(step: string): string {
  return stepDone(step) ? '✓' : '●';
}
/** 步骤标签文字：pending → 待…  active → 正在…  done → …已完成 */
function stepLabel(step: string): string {
  const s = stepState(step);
  const labels: Record<string, [string, string, string]> = {
    blueprint: ['待分析知识图谱', '正在分析知识图谱', '分析已完成'],
    write: ['待编写试题', '正在编写试题', '编写已完成'],
    review: ['待审核试题', '正在审核试题', '审核已完成'],
    regenerate: ['待修正试题', '正在修正试题', '修正已完成'],
    complete: ['准备就绪', '即将完成', '已完成'],
  };
  const idx = s === 'pending' ? 0 : s === 'active' ? 1 : 2;
  return labels[step]?.[idx] ?? step;
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

/** 根据限时决定试卷总分：15分钟→20分，45分钟→50分，90分钟→100分 */
function totalScoreForDuration(minutes: number): number {
  if (minutes <= 15) return 20;
  if (minutes <= 45) return 50;
  return 100;
}

async function generateExamPaper() {
  examState.value = 'generating';
  genProgress.value = { step: 'blueprint', message: '正在准备…', progress: 0 };
  let ready: ExamReadyData | undefined;
  let errMsg = '';
  try {
    const examRequest = { ...config.value, totalScore: totalScoreForDuration(config.value.durationMinutes) };
    await streamExamGenerate(examRequest, (e) => {
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
    examState.value = 'ready';
    // 计时器在用户点击「开始考试」后才启动
    emit('refresh'); // 新试卷已入库，刷新侧栏考试列表
  } catch (err) {
    toast.error('生成试卷失败: ' + (err instanceof Error ? err.message : String(err)));
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
    if (data.results) { results.value = data.results; examState.value = 'graded'; emit('refresh'); }
    else throw new Error(data.error || '提交失败');
  } catch (err) {
    toast.error('提交失败: ' + (err instanceof Error ? err.message : String(err)));
    examState.value = 'taking';
  }
}

// 进入答题页后编译题面里的 TikZ 示意图
watch(examState, (s) => {
  if (s === 'taking') nextTick(() => processTikzDiagrams());
});

function startExam() {
  if (!session.value) return;
  examState.value = 'taking';
  startTimer(session.value.durationMinutes);
}

function revealResults() {
  scoreRevealed.value = false;
  examState.value = 'results';
  // 下一帧启动动画
  requestAnimationFrame(() => { requestAnimationFrame(() => { scoreRevealed.value = true; }); });
}

/** 动画显示的分值：逐步递增 */
const displayPct = ref(0);
/** 把 proficiencyChanges 数组转成按 kpTitle 索引的 Map，方便模板查找 */
const proficiencyMap = computed(() => {
  const m: Record<string, { before: number; after: number }> = {};
  if (results.value?.proficiencyChanges) {
    for (const pc of results.value.proficiencyChanges) {
      m[pc.kpTitle] = { before: pc.before, after: pc.after };
    }
  }
  return m;
});
watch(scoreRevealed, (v) => {
  if (v && results.value) {
    displayPct.value = 0;
    const target = results.value.percentage;
    const duration = 1200; // ms
    const step = Math.max(1, Math.floor(target / 60));
    const interval = setInterval(() => {
      displayPct.value = Math.min(target, displayPct.value + step);
      if (displayPct.value >= target) clearInterval(interval);
    }, duration / 60);
  }
});
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
            <p class="mb-2 text-xs font-semibold text-[var(--ink-soft)]">备注 <span class="font-normal text-[var(--ink-soft)]/60">（教材章节 / 知识点 / 特殊要求）</span></p>
            <textarea v-model="config.notes" rows="2" class="w-full resize-none rounded-xl border border-[var(--line)] bg-white px-3 py-2 text-sm text-[var(--ink)] outline-none transition-colors placeholder:text-[var(--ink-soft)]/40 focus:border-[var(--accent)] focus:shadow-[0_0_0_3px_var(--accent-soft)]" placeholder="例：人教版七年级上册第三章「一元一次方程」, 侧重实际应用题" />
          </div>
          <div>
            <p class="mb-2 text-xs font-semibold text-[var(--ink-soft)]">限时</p>
            <div class="flex gap-2">
              <button v-for="d in DURATIONS" :key="d.value" @click="config.durationMinutes = d.value" class="flex flex-1 items-center justify-center gap-1.5 rounded-2xl border-2 py-2.5 font-display text-sm font-bold transition-all active:scale-[0.97]" :class="config.durationMinutes === d.value ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent-strong)]' : 'border-[var(--line)] bg-white text-[var(--ink-soft)] hover:border-[var(--accent)]'"><Clock class="h-3.5 w-3.5" />{{ d.emoji }} {{ d.label }}</button>
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
        <div class="loading-mascot"><Mascot :size="80" state="thinking" /></div>
        <h2 class="brand-text text-xl font-bold tracking-tight">博文正在出卷</h2>
        <div class="w-80 space-y-0.5">
          <div v-for="st in ['blueprint','write','review']" :key="st">
            <div class="step-row" :class="stepState(st) === 'done' || stepState(st) === 'active' ? '' : 'opacity-30'">
              <span class="step-dot" :class="dotCls(st)">{{ dotIcon(st) }}</span>
              <span class="flex-1 font-display text-sm font-semibold text-[var(--ink)]">{{ stepLabel(st) }}</span>
              <span v-if="stepState(st) === 'active'" class="step-active-dot"></span>
              <span v-if="stepState(st) === 'done'" class="text-[11px] font-medium text-[#18a558]">完成</span>
            </div>
          </div>
        </div>
        <div class="h-1.5 w-80 overflow-hidden rounded-full bg-[var(--line)]">
          <div class="progress-fill" :style="{ width: genProgress.progress + '%' }"></div>
        </div>
      </div>
    </div>

    <!-- ═══ READY（待开始考试） ═══ -->
    <div v-if="examState === 'ready' && session" class="flex h-full flex-col items-center justify-center">
      <div class="flex flex-col items-center gap-6" v-motion :initial="{ opacity: 0, scale: 0.9 }" :enter="{ opacity: 1, scale: 1, transition: { type: 'spring', stiffness: 260, damping: 20 } }">
        <div class="loading-mascot"><Mascot :size="80" state="happy" /></div>
        <div class="text-center">
          <p class="mb-1 font-display text-lg font-bold text-[var(--ink)]">试卷已就绪</p>
          <p class="text-sm text-[var(--ink-soft)]">{{ session.title }} · 共 {{ session.totalQuestions }} 题 · {{ session.totalScore }} 分 · 限时 {{ session.durationMinutes }} 分钟</p>
        </div>
        <button @click="startExam" class="btn-accent flex items-center gap-2 rounded-2xl px-8 py-3 font-display text-base font-bold transition-all active:scale-[0.96]"><Sparkles class="h-5 w-5" /> 开始考试</button>
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
              <div v-if="q.passage" class="passage-block md-body text-sm" :class="config.subject === 'chinese' ? 'passage-block-chi' : config.subject === 'english' ? 'passage-block-eng' : ''" v-html="renderMarkdown(q.passage)"></div>
              <div class="md-body text-sm font-medium leading-relaxed text-[var(--ink)]" v-html="renderMarkdown(q.stem)"></div>

              <!-- Multiple Choice -->
              <div v-if="q.type === 'multiple_choice'" class="space-y-2">
                <button v-for="opt in q.options" :key="opt.key" @click="setAnswer(q.index, q.multiSelect ? [...(getAnswer(q.index) || []), opt.key].filter((k, i, a) => a.indexOf(k) === i) : [opt.key])"
                  class="flex w-full items-center gap-3 rounded-2xl border-2 px-4 py-2.5 text-left text-sm transition-all active:scale-[0.98]"
                  :class="(getAnswer(q.index) || []).includes(opt.key) ? 'border-[var(--accent)] bg-[var(--accent-soft)]' : 'border-[var(--line)] bg-white hover:border-[var(--accent)]'"
                ><span class="flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold" :class="(getAnswer(q.index) || []).includes(opt.key) ? 'bg-[var(--accent)] text-white' : 'bg-[var(--accent-soft)] text-[var(--accent-strong)]'">{{ opt.key }}</span><span class="md-body" v-html="renderMarkdownInline(opt.text)"></span></button>
                <p v-if="q.multiSelect" class="text-xs text-[var(--ink-soft)]">可多选</p>
              </div>

              <!-- True/False -->
              <div v-if="q.type === 'true_false'" class="flex gap-3">
                <button v-for="opt in [{ v: true, l: '正确' }, { v: false, l: '错误' }]" :key="String(opt.v)" @click="setAnswer(q.index, opt.v)" class="flex-1 rounded-2xl border-2 py-3 text-center font-display text-sm font-bold transition-all" :class="getAnswer(q.index) === opt.v ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent-strong)]' : 'border-[var(--line)] bg-white text-[var(--ink-soft)] hover:border-[var(--accent)]'">{{ opt.l }}</button>
              </div>

              <!-- Fill Blank -->
              <div v-if="q.type === 'fill_blank'" class="space-y-2">
                <div v-for="i in (q.blankCount ?? q.blanks?.length ?? 1)" :key="i" class="flex items-center gap-2">
                  <span class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--accent-soft)] text-xs font-bold text-[var(--accent-strong)]">{{ i }}</span>
                  <input :value="(getAnswer(q.index) || [])[i - 1] || ''" @input="(e) => { const v = getAnswer(q.index) || Array(q.blankCount ?? q.blanks?.length ?? 1).fill(''); v[i - 1] = (e.target as HTMLInputElement).value; setAnswer(q.index, v); }" class="flex-1 rounded-xl border border-[var(--line)] px-3 py-2 text-sm outline-none transition-colors focus:border-[var(--accent)] focus:shadow-[0_0_0_3px_var(--accent-soft)]" placeholder="填写答案" />
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

    <!-- ═══ GRADING（与 GENERATING 一致布局） ═══ -->
    <div v-if="examState === 'grading'" class="flex h-full flex-col items-center justify-center">
      <div class="flex flex-col items-center gap-6" v-motion :initial="{ opacity: 0, scale: 0.9 }" :enter="{ opacity: 1, scale: 1, transition: { delay: 100, duration: 500 } }">
        <div class="loading-mascot"><Mascot :size="80" state="thinking" /></div>
        <h2 class="brand-text text-xl font-bold tracking-tight">博文正在评分</h2>
        <div class="w-80 space-y-1">
          <div class="step-row">
            <span class="step-dot dot-active">✦</span>
            <span class="flex-1 font-display text-sm font-semibold text-[var(--ink)]">批改评分</span>
            <span class="step-active-dot"></span>
          </div>
          <div class="step-row">
            <span class="step-dot dot-pending">✦</span>
            <span class="flex-1 font-display text-sm font-semibold text-[var(--ink)]">生成分析报告</span>
          </div>
          <div class="step-row">
            <span class="step-dot dot-pending">✦</span>
            <span class="flex-1 font-display text-sm font-semibold text-[var(--ink)]">写入知识图谱</span>
          </div>
        </div>
        <div class="h-1.5 w-80 overflow-hidden rounded-full bg-[var(--line)]">
          <div class="loading-bar-inner h-full rounded-full"></div>
        </div>
      </div>
    </div>

    <!-- ═══ GRADED（待查看成绩） ═══ -->
    <div v-if="examState === 'graded' && results" class="flex h-full flex-col items-center justify-center">
      <div class="flex flex-col items-center gap-6" v-motion :initial="{ opacity: 0, scale: 0.9 }" :enter="{ opacity: 1, scale: 1, transition: { type: 'spring', stiffness: 260, damping: 20 } }">
        <div class="loading-mascot"><Mascot :size="80" state="happy" /></div>
        <p class="font-display text-lg font-bold text-[var(--ink)]">批改完成！</p>
        <button @click="revealResults" class="btn-accent flex items-center gap-2 rounded-2xl px-8 py-3 font-display text-base font-bold transition-all active:scale-[0.96]"><BarChart3 class="h-5 w-5" /> 查看成绩</button>
      </div>
    </div>

    <!-- ═══ RESULTS ═══ -->
    <div v-if="examState === 'results' && results" class="flex h-full flex-col overflow-y-auto">
      <div class="mx-auto w-full max-w-2xl space-y-4 p-4">
        <!-- Score Hero（带展开动画） -->
        <div class="clay p-6 text-center" :class="{ 'score-reveal': scoreRevealed }" v-motion :initial="{ opacity: 0, scale: 0.9 }" :enter="{ opacity: 1, scale: 1, transition: { type: 'spring', stiffness: 260, damping: 20 } }">
          <div class="relative mx-auto mb-3 h-28 w-28">
            <svg class="h-full w-full -rotate-90" viewBox="0 0 120 120">
              <circle cx="60" cy="60" r="54" fill="none" stroke="var(--line)" stroke-width="8" />
              <circle cx="60" cy="60" r="54" fill="none" :stroke="masteryColor(results.percentage)" stroke-width="8" stroke-linecap="round" :stroke-dasharray="2 * Math.PI * 54" :stroke-dashoffset="2 * Math.PI * 54 * (1 - (scoreRevealed ? results.percentage / 100 : 0))" class="circle-reveal" />
            </svg>
            <div class="absolute inset-0 flex flex-col items-center justify-center">
              <span class="font-display text-3xl font-bold" :style="{ color: masteryColor(results.percentage) }">{{ displayPct }}<span class="text-base">%</span></span>
              <span class="text-[10px] font-medium text-[var(--ink-soft)]">正确率</span>
            </div>
          </div>
          <span class="grade-badge" :class="results.grade === '优秀' ? 'grade-excellent' : results.grade === '良好' ? 'grade-good' : results.grade === '及格' ? 'grade-pass' : 'grade-fail'">{{ results.grade }}</span>
          <div class="mt-3 text-xs text-[var(--ink-soft)]">{{ results.totalScore }}/{{ results.maxScore }} 分</div>
        </div>

        <!-- 博文综合分析 -->
        <div v-if="results.analysis" class="clay overflow-hidden" v-motion :initial="{ opacity: 0, y: 16 }" :enter="{ opacity: 1, y: 0, transition: { delay: 120 } }">
          <div class="flex items-start gap-3 p-4">
            <div class="shrink-0"><Mascot :size="44" state="happy" /></div>
            <div class="min-w-0 flex-1">
              <p class="mb-2 font-display text-xs font-bold text-[var(--accent)]">博文的总结</p>
              <div class="analysis-body text-sm leading-relaxed text-[var(--ink)]" v-html="renderMarkdown(results.analysis)"></div>
            </div>
          </div>
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

        <!-- 知识点分析 + 熟练度变化（合并） -->
        <div class="clay p-4" v-motion :initial="{ opacity: 0, y: 16 }" :enter="{ opacity: 1, y: 0, transition: { delay: 200 } }">
          <h3 class="mb-3 font-display text-xs font-bold text-[var(--ink-soft)]">知识点分析</h3>
          <div v-for="kp in results.kpBreakdown" :key="kp.kp" class="mb-2 flex items-center gap-3 last:mb-0">
            <GraduationCap class="h-3.5 w-3.5 shrink-0 text-[var(--accent)]" />
            <span class="flex-1 min-w-0 truncate text-xs font-medium text-[var(--ink)]">{{ kp.kp }}</span>
            <div class="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-[var(--line)]"><div class="h-full rounded-full" :style="{ width: kp.percentage + '%', background: masteryColor(kp.percentage) }"></div></div>
            <span class="shrink-0 text-xs font-bold" :style="{ color: masteryColor(kp.percentage) }">{{ kp.percentage }}%</span>
            <span v-if="proficiencyMap[kp.kp]" class="flex shrink-0 items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[10px] font-bold" :class="proficiencyMap[kp.kp].after >= proficiencyMap[kp.kp].before ? 'bg-[#e7f7ee] text-[#18a558]' : 'bg-[#fdeaef] text-[#f2557a]'">
              <span v-if="proficiencyMap[kp.kp].after > proficiencyMap[kp.kp].before">↑</span>
              <span v-else-if="proficiencyMap[kp.kp].after < proficiencyMap[kp.kp].before">↓</span>
              <span>{{ proficiencyMap[kp.kp].before }}→{{ proficiencyMap[kp.kp].after }}</span>
            </span>
          </div>
        </div>

        <!-- 核心素养（主指标，优先展示） -->
        <div class="clay p-4" v-motion :initial="{ opacity: 0, y: 16 }" :enter="{ opacity: 1, y: 0, transition: { delay: 180 } }">
          <h3 class="mb-3 font-display text-xs font-bold text-[var(--ink-soft)]">核心素养 <span class="font-normal text-[var(--ink-soft)]/60">— 综合能力评价</span></h3>
          <div class="flex flex-wrap gap-3">
            <div v-for="lit in results.literacyBreakdown" :key="lit.literacy" class="flex flex-1 flex-col items-center gap-1.5 rounded-xl border border-[var(--line)] px-3 py-3 min-w-[100px]">
              <span class="text-xs font-semibold text-[var(--ink)]">{{ lit.literacy }}</span>
              <span class="font-display text-xl font-bold" :style="{ color: masteryColor(lit.percentage) }">{{ lit.percentage }}<span class="text-xs">%</span></span>
              <span class="inline-block rounded-full px-2 py-0.5 text-[10px] font-bold" :class="
                lit.percentage >= 80 ? 'bg-[#e7f7ee] text-[#18a558]' :
                lit.percentage >= 60 ? 'bg-[#fef7e6] text-[#e0a92e]' :
                lit.percentage >= 40 ? 'bg-[#fef3e2] text-[#f59e42]' :
                'bg-[#fdeaef] text-[#f2557a]'
              ">{{ lit.percentage >= 80 ? '优秀' : lit.percentage >= 60 ? '良好' : lit.percentage >= 40 ? '待加强' : '薄弱' }}</span>
            </div>
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
                  <p><span class="font-semibold text-[var(--ink-soft)]">参考答案：</span><span class="text-[var(--ink)] md-body" v-html="renderMarkdown(qr.reference)"></span></p>
                  <div v-if="qr.explanation" class="rounded-xl bg-white p-3 text-[var(--ink)] md-body" v-html="renderMarkdown(qr.explanation)"></div>
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
        <div class="flex items-center justify-center gap-3 pb-6">
          <button @click="session = null; results = null; answers = new Map(); $emit('back')" class="inline-flex items-center gap-2 rounded-2xl border border-[var(--line)] bg-white px-5 py-2.5 font-display text-sm font-semibold text-[var(--ink)] transition-all hover:border-[var(--accent)] hover:bg-[var(--accent-soft)] active:scale-[0.97]"><ArrowLeft class="h-4 w-4" /> 返回首页</button>
          <span class="text-xs text-[var(--ink-soft)]">成绩已保存，可在侧边栏「考试」中查看</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.exam-root { height: 100%; background: transparent; overflow-y: auto; }

/* ── 吉祥物浮动 ── */
.loading-mascot { animation: loadingFloat 2.4s ease-in-out infinite; }
@keyframes loadingFloat { 0%,100% { transform: translateY(0) scale(1); } 50% { transform: translateY(-8px) scale(1.03); } }

/* ── 进度条 ── */
.loading-bar-inner { width: 40%; height: 100%; border-radius: 99px; background: linear-gradient(90deg, var(--accent-soft), var(--accent), var(--accent-strong)); animation: loadingSlide 1.4s ease-in-out infinite; }
@keyframes loadingSlide { 0% { transform: translateX(-100%); } 100% { transform: translateX(250%); } }
.progress-fill { height: 100%; border-radius: 99px; background: linear-gradient(90deg, var(--accent), var(--accent-strong)); transition: width 0.5s cubic-bezier(0.34, 1.56, 0.64, 1); }

/* ── 步骤列表 ── */
.step-row { display: flex; align-items: center; gap: 0.75rem; padding: 0.375rem 0; transition: opacity 0.4s ease; }
.step-dot { display: flex; align-items: center; justify-content: center; width: 1.25rem; height: 1.25rem; border-radius: 999px; font-size: 0.5rem; flex-shrink: 0; transition: all 0.4s cubic-bezier(0.34, 1.56, 0.64, 1); }
.dot-active { background: var(--accent); color: white; box-shadow: 0 0 0 4px var(--accent-soft); }
.dot-pending { background: var(--accent-soft); color: var(--accent-strong); opacity: 0.5; }
.step-active-dot { width: 0.375rem; height: 0.375rem; border-radius: 999px; background: var(--accent); animation: stepPulse 1.6s ease-in-out infinite; }
@keyframes stepPulse { 0%,100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.4; transform: scale(0.6); } }

/* ── 成绩揭开动画 ── */
.circle-reveal { transition: stroke-dashoffset 1.2s cubic-bezier(0.34, 1.56, 0.64, 1); }
.score-reveal .grade-badge { animation: badgeSlideIn 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) 0.4s both; }
.grade-badge { display: inline-block; border-radius: 999px; padding: 0.25rem 1rem; font-family: var(--font-display); font-size: 0.875rem; font-weight: 700; }
.grade-excellent { background: #e7f7ee; color: #18a558; }
.grade-good { background: #fef7e6; color: #e0a92e; }
.grade-pass { background: #fef3e2; color: #f59e42; }
.grade-fail { background: #fdeaef; color: #f2557a; }
@keyframes badgeSlideIn { from { opacity: 0; transform: translateY(10px) scale(0.8); } to { opacity: 1; transform: translateY(0) scale(1); } }

/* ── 结果展开/收起 ── */
.reveal-enter-active { transition: all 0.25s ease; overflow: hidden; }
.reveal-leave-active { transition: all 0.15s ease; overflow: hidden; }
.reveal-enter-from, .reveal-leave-to { opacity: 0; max-height: 0; }

/* ── 阅读材料 ── */
.passage-block { border-radius: 14px; padding: 0.9rem 1.1rem; line-height: 1.8; font-size: 0.9rem; }
.passage-block-chi { font-family: 'KaiTi','STKaiti',serif; background: #fff8f0; border: 1.5px solid #f0dcc0; color: #5c4a32; }
.passage-block-eng { font-family: 'Georgia','Times New Roman',serif; background: #f5f0ff; border: 1.5px solid #d8cce8; color: #3d2e5c; }
</style>
