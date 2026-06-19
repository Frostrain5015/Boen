<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue';
import Mascot from '@/components/Mascot.vue';
import { CheckCircle2, XCircle, Sparkles, Clock, AlertTriangle, BarChart3, GraduationCap, BrainCircuit, ChevronDown, ChevronUp, Send, ArrowLeft, ChevronRight } from 'lucide-vue-next';
import type { QuestionType, AnswerPayload } from '@boen/shared';
import { getToken } from '@/services/auth';
import { streamExamGenerate, streamExamSubmit } from '@/services/chat';
import { renderMarkdown } from '@/lib/markdown';
import { processTikzDiagrams } from '@/lib/tikz';
import { useToast } from '@/composables/useToast';
import { useUiStore } from '@/stores/ui';
import StarDisplay from '@/components/StarDisplay.vue';

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
  tikzSvgs?: Record<string, string>;
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
type GenerationStep = 'kg' | 'blueprint' | 'write' | 'review';
const generationSteps: Array<{ step: GenerationStep }> = [
  { step: 'kg' },
  { step: 'blueprint' },
  { step: 'write' },
  { step: 'review' },
];
type GradingStep = 'grade' | 'analyze' | 'profile' | 'save' | 'complete';
const gradingProgress = ref<{ step: GradingStep; message: string; progress: number }>({ step: 'grade', message: '准备开始判卷', progress: 0 });
const gradingSteps: Array<{ step: GradingStep; label: string }> = [
  { step: 'grade', label: '批改评分' },
  { step: 'analyze', label: '生成分析' },
  { step: 'profile', label: '写入画像' },
  { step: 'save', label: '保存结果' },
];
const scoreRevealed = ref(false);
const currentQuestionIndex = ref(0);
const questionSwitchDirection = ref<'next' | 'prev'>('next');
const dotNavRef = ref<HTMLElement | null>(null);

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

/** 合并所有题目的预渲染 TikZ SVG 映射 */
const tikzSvgsMap = computed(() => {
  const all: Record<string, string> = {};
  for (const q of session.value?.questions ?? []) {
    if (q.tikzSvgs) Object.assign(all, q.tikzSvgs);
  }
  return Object.keys(all).length ? all : undefined;
});

const SUBJECTS = [
  { value: 'chinese' as const, label: '语文', emoji: '📖' },
  { value: 'math' as const, label: '数学', emoji: '🔢' },
  { value: 'english' as const, label: '英语', emoji: '🔤' },
  { value: 'science' as const, label: '科学', emoji: '🔬' },
];
/** 学科主题色（与 index.css data-subject CSS 变量保持一致） */
const UI_STORE = useUiStore();
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
    if (isQuestionAnswered(q)) c++;
  }
  return c;
});
const timerDisplay = computed(() => {
  const m = Math.floor(timer.value / 60);
  const s = timer.value % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
});
const timerUrgent = computed(() => timer.value < 300 && timer.value > 0);

const currentQuestion = computed(() => session.value?.questions[currentQuestionIndex.value] ?? null);
const isFirstQuestion = computed(() => currentQuestionIndex.value === 0);
const isLastQuestion = computed(() => currentQuestionIndex.value === (session.value?.questions.length ?? 1) - 1);
/** 题号窗口：固定显示 9 个（当前居中），左右溢出时动态调整 */
const VISIBLE_DOT_COUNT = 9;
const visibleDots = computed(() => {
  const qs = session.value?.questions ?? [];
  const total = qs.length;
  if (total <= VISIBLE_DOT_COUNT) return qs;
  const half = Math.floor(VISIBLE_DOT_COUNT / 2);
  let start = currentQuestionIndex.value - half;
  start = Math.max(0, Math.min(start, total - VISIBLE_DOT_COUNT));
  return qs.slice(start, start + VISIBLE_DOT_COUNT);
});
const visibleDotOffset = computed(() => {
  // 计算当前题号在可见窗口前的偏移量（用于首尾 item 显示省略效果）
  const qs = session.value?.questions ?? [];
  if (qs.length <= VISIBLE_DOT_COUNT) return 0;
  const half = Math.floor(VISIBLE_DOT_COUNT / 2);
  let start = currentQuestionIndex.value - half;
  return Math.max(0, Math.min(start, qs.length - VISIBLE_DOT_COUNT));
});
const nextButtonLabel = computed(() => (isLastQuestion.value ? '提交' : '下一题'));
const nextButtonIcon = computed(() => (isLastQuestion.value ? Send : ChevronRight));
function isQuestionAnswered(q: ExamQuestionData): boolean {
  const a = answers.value.get(q.index);
  if (a === undefined || a === null) return false;
  if (q.type === 'fill_blank' && Array.isArray(a)) return a.some((v: string) => String(v ?? '').trim());
  if (q.type === 'short_answer' && typeof a === 'string') return a.trim().length > 0;
  if (q.type === 'true_false' && typeof a === 'boolean') return true;
  if (q.type === 'multiple_choice' && Array.isArray(a)) return a.length > 0;
  return false;
}
const answeredStatus = computed(() => {
  const m = new Map<number, boolean>();
  for (const q of session.value?.questions ?? []) m.set(q.index, isQuestionAnswered(q));
  return m;
});

function goToQuestion(idx: number) {
  if (!session.value || idx < 0 || idx >= session.value.questions.length) return;
  questionSwitchDirection.value = idx > currentQuestionIndex.value ? 'next' : 'prev';
  currentQuestionIndex.value = idx;
}
function prevQuestion() { goToQuestion(currentQuestionIndex.value - 1); }
function nextQuestion() {
  if (isLastQuestion.value) submitExam();
  else goToQuestion(currentQuestionIndex.value + 1);
}

function handleKeydown(e: KeyboardEvent) {
  if (examState.value !== 'taking') return;
  if (e.key === 'ArrowLeft') { e.preventDefault(); prevQuestion(); }
  if (e.key === 'ArrowRight') { e.preventDefault(); nextQuestion(); }
}

function centerCurrentDot() {
  // 固定窗口渲染，无需滚动
}

function gradeLabel(g: string): string {
  const n = Number(g);
  return n <= 6 ? `小${'一二三四五六'[n - 1]}` : `初${'一二三'[n - 7]}`;
}

function masteryColor(ws: number): string {
  if (ws < 40) return '#f2557a'; if (ws < 60) return '#f59e42'; if (ws < 80) return '#e0a92e'; return '#18a558';
}

function stepDone(step: string): boolean {
  const p = genProgress.value.progress;
  if (step === 'blueprint') return p > 20;
  if (step === 'write') return p > 85;
  if (step === 'review') return p >= 100;
  if (step === 'regenerate') return p >= 100;
  if (step === 'complete') return p >= 100;
  return false;
}

/** 步骤是否已完成（依据进度阈值） */
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
function generationStepState(step: GenerationStep): 'pending' | 'active' | 'done' {
  const current = genProgress.value.step;
  const p = genProgress.value.progress;
  if (step === 'kg') {
    if (current === 'blueprint' && p < 10) return 'active';
    if (p >= 10 || current !== 'blueprint') return 'done';
    return 'pending';
  }
  if (step === 'blueprint') {
    if (current === 'blueprint' && p >= 20) return 'done';
    if (current === 'blueprint' && p >= 10) return 'active';
    if (['write', 'review', 'regenerate', 'complete'].includes(current)) return 'done';
    return 'pending';
  }
  if (step === 'write') {
    if (current === 'write') return 'active';
    if (['review', 'regenerate', 'complete'].includes(current)) return 'done';
    return 'pending';
  }
  if (step === 'review') {
    if (current === 'complete') return 'done';
    if (['review', 'regenerate'].includes(current)) return 'active';
    return 'pending';
  }
  return 'pending';
}
function generationDotCls(step: GenerationStep): string {
  const s = generationStepState(step);
  if (s === 'done') return 'dot-done';
  if (s === 'active') return 'dot-active';
  return 'dot-pending';
}
function generationDotIcon(step: GenerationStep): string {
  return generationStepState(step) === 'done' ? '✓' : '●';
}
function generationStepLabel(step: GenerationStep): string {
  const labels: Record<GenerationStep, string> = {
    kg: '知识图谱扫描',
    blueprint: '试卷蓝图设计',
    write: '试题编写',
    review: '质量审核',
  };
  return labels[step];
}

function gradingStepState(step: GradingStep): 'pending' | 'active' | 'done' {
  const order: GradingStep[] = ['grade', 'analyze', 'profile', 'save', 'complete'];
  const current = gradingProgress.value.step;
  if (current === 'complete') return 'done';
  const currentIndex = order.indexOf(current);
  const stepIndex = order.indexOf(step);
  if (stepIndex < currentIndex) return 'done';
  if (step === current) return 'active';
  return 'pending';
}
function gradingDotClass(step: GradingStep): string {
  const s = gradingStepState(step);
  if (s === 'done') return 'dot-done';
  if (s === 'active') return 'dot-active';
  return 'dot-pending';
}

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

function isPlaceholderOptionText(text: unknown, key?: string): boolean {
  const raw = String(text ?? '').trim();
  if (!raw) return true;
  const normalized = raw.replace(/[{}（）()【】\s]/g, '').toUpperCase();
  const expected = key ? key.toUpperCase() : '[A-F]';
  return normalized === `选项${expected}` || /^选项[A-F]$/.test(normalized);
}

function stripOptionPrefix(text: string, key?: string): string {
  const k = key ? key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '[A-Fa-f]';
  return String(text ?? '').trim().replace(new RegExp(`^(?:选项\\s*)?${k}\\s*[.．、:：)]\\s*`, 'i'), '').trim();
}

function displayOptions(q: ExamQuestionData | null): { key: string; text: string }[] {
  if (!q?.options) return [];
  return q.options
    .map((o) => ({ key: String(o.key ?? '').trim().toUpperCase(), text: stripOptionPrefix(o.text, o.key) }))
    .filter((o) => o.key && !isPlaceholderOptionText(o.text, o.key));
}

function blankCountForQuestion(q: ExamQuestionData | null): number {
  if (!q || q.type !== 'fill_blank') return 0;
  const markerCount = (q.stem.match(/_{2,}|＿{2,}|（\s*）|\(\s*\)|\[\s*\]/g) ?? []).length;
  return Math.max(q.blankCount ?? 0, q.blanks?.length ?? 0, markerCount, 1);
}

/** 单题模式下 safely 设置选择题作答（currentQuestion 可能为 null 时自动忽略） */
function setMultipleChoiceAnswer(qIndex: number | undefined, multiSelect: boolean | undefined, key: string) {
  if (qIndex === undefined) return;
  const prev = (getAnswer(qIndex) as string[] | undefined) ?? [];
  const next = multiSelect ? (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]) : [key];
  setAnswer(qIndex, next);
}
function setTrueFalseAnswer(qIndex: number | undefined, value: boolean) {
  if (qIndex !== undefined) setAnswer(qIndex, value);
}
function setFillBlankAnswer(qIndex: number | undefined, totalBlanks: number, i: number, value: string) {
  if (qIndex === undefined) return;
  const v = ((getAnswer(qIndex) as string[] | undefined) ?? Array(totalBlanks).fill(''));
  v[i] = value;
  setAnswer(qIndex, v);
}
function setShortAnswerAnswer(qIndex: number | undefined, value: string) {
  if (qIndex !== undefined) setAnswer(qIndex, value);
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
    gradingProgress.value = { step: 'grade', message: '准备开始判卷', progress: 0 };
    let gradedResults: ExamResultsData | null = null;
    let errMsg = '';
    await streamExamSubmit({ examId: session.value.examId, answers: answerArray }, (e) => {
      if (e.type === 'exam_grading_progress' && 'progress' in e) {
        gradingProgress.value = { step: e.step, message: e.message, progress: e.progress };
      } else if (e.type === 'exam_graded') {
        gradedResults = e.results as ExamResultsData;
      } else if (e.type === 'error') {
        errMsg = e.message;
      }
    });
    if (errMsg) throw new Error(errMsg);
    if (gradedResults) { results.value = gradedResults; examState.value = 'graded'; emit('refresh'); }
    else throw new Error('提交失败：未收到判卷结果');
  } catch (err) {
    toast.error('提交失败: ' + (err instanceof Error ? err.message : String(err)));
    examState.value = 'taking';
  }
}

// 进入答题页后编译题面里的 TikZ 示意图
watch(examState, (s) => {
  if (s === 'taking') {
    nextTick(() => processTikzDiagrams(document, tikzSvgsMap.value));
    centerCurrentDot();
  }
});
watch(currentQuestionIndex, () => {
  centerCurrentDot();
  nextTick(() => processTikzDiagrams(document, tikzSvgsMap.value));
});

function startExam() {
  if (!session.value) return;
  currentQuestionIndex.value = 0;
  answers.value = new Map();
  questionSwitchDirection.value = 'next';
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
function goBack() {
  examState.value = 'config';
  if (timerInterval.value) { clearInterval(timerInterval.value); timerInterval.value = null; }
  currentQuestionIndex.value = 0;
  answers.value = new Map();
}
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

onMounted(() => { window.addEventListener('keydown', handleKeydown); });
onUnmounted(() => { if (timerInterval.value) clearInterval(timerInterval.value); window.removeEventListener('keydown', handleKeydown); });
</script>

<template>
  <div class="exam-root" :data-subject="config.subject" v-motion :initial="{ opacity: 0 }" :enter="{ opacity: 1, transition: { duration: 300 } }">
    <!-- ═══ CONFIG ═══ -->
    <div v-if="examState === 'config'" class="flex h-full flex-col items-center justify-center p-6">
      <div class="clay clay-glass w-full max-w-lg overflow-hidden" v-motion :initial="{ opacity: 0, y: 20 }" :enter="{ opacity: 1, y: 0, transition: { delay: 100 } }">
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
              <span class="absolute top-1 bottom-1 left-1 w-16 rounded-[14px]" :style="{ background: 'var(--accent)', transform: `translateX(calc(${subjectIndex} * 4rem))`, transition: 'transform 0.4s cubic-bezier(0.34, 1.56, 0.64, 1)' }"></span>
              <button v-for="s in SUBJECTS" :key="s.value" @click="config.subject = s.value; UI_STORE.subject = s.value" class="relative z-10 flex w-16 items-center justify-center gap-1 rounded-[14px] py-1.5 font-display text-sm font-semibold transition-colors" :class="config.subject === s.value ? 'text-white' : 'text-[var(--ink-soft)] hover:text-[var(--ink)]'"><span>{{ s.emoji }}</span>{{ s.label }}</button>
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
        <h2 class="brand-text text-xl font-bold tracking-tight" style="color: var(--accent-strong)">博文正在出卷</h2>
        <div class="w-80 space-y-0.5">
          <div
            v-for="item in generationSteps"
            :key="item.step"
            class="step-row step-row-timeline"
            :class="[`step-row-${generationStepState(item.step)}`, generationStepState(item.step) === 'pending' ? 'opacity-45' : '']"
          >
            <span class="step-dot" :class="generationDotCls(item.step)"><span class="step-dot-core"></span></span>
            <span class="flex-1 font-display text-sm font-semibold text-[var(--ink)]">{{ generationStepLabel(item.step) }}</span>
            <span v-if="generationStepState(item.step) === 'active'" class="step-active-dot"></span>
          </div>
          <p class="px-1 pt-2 text-center text-xs font-medium text-[var(--ink-soft)]">{{ generationStepLabel(genProgress.step as GenerationStep) }}</p>
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
    <div v-if="examState === 'taking' && session" class="relative flex h-full flex-col">
      <!-- 顶部栏 -->
      <div class="flex items-center gap-3 border-b border-[var(--line)] bg-[var(--surface)] px-4 py-3 sm:px-5">
        <button @click="goBack" class="flex h-8 w-8 items-center justify-center rounded-full transition-colors hover:bg-[var(--line)]/50"><ArrowLeft class="h-4 w-4 text-[var(--ink-soft)]" /></button>
        <div class="hidden flex-1 truncate font-display text-sm font-bold text-[var(--ink)] sm:block">{{ session.title }}</div>
        <div class="flex flex-1 items-center justify-center gap-2 sm:hidden">
          <span class="text-xs font-bold text-[var(--ink)]">{{ currentQuestionIndex + 1 }} / {{ session.totalQuestions }}</span>
        </div>
        <div class="flex items-center gap-2 sm:gap-3">
          <div class="hidden items-center gap-1.5 rounded-xl bg-[#e8f6ed] px-2.5 py-1.5 text-xs font-bold text-[#1f8f52] sm:flex">
            已答 {{ answeredCount }}/{{ session.totalQuestions }}
          </div>
          <div class="flex items-center gap-1.5 rounded-xl px-2.5 py-1.5 font-display text-xs font-bold transition-colors sm:px-3 sm:text-sm" :class="timerUrgent ? 'bg-[#fdeaef] text-[#f2557a] animate-pulse' : 'bg-[var(--accent-soft)] text-[var(--accent-strong)]'">
            <Clock class="h-3.5 w-3.5 sm:h-4 sm:w-4" />
            <span>{{ timerDisplay }}</span>
          </div>
        </div>
      </div>

      <!-- 单题区域（题号轨道 + 题目卡片） -->
      <div class="relative flex-1 overflow-hidden bg-[var(--surface)]/30">
        <Transition :name="questionSwitchDirection === 'next' ? 'question-next' : 'question-prev'" mode="out-in">
          <div v-if="currentQuestion" :key="currentQuestion.index" class="absolute inset-0 flex flex-col overflow-y-auto px-4 sm:px-6">
            <!-- 题号轨道（固定窗口 9 个，当前居中） -->
            <div class="shrink-0 pt-5 pb-3">
              <div ref="dotNavRef" class="dot-nav-scroll mx-auto flex max-w-sm items-center justify-center gap-0.5" role="navigation" aria-label="题号导航">
                <button v-if="visibleDotOffset > 0" disabled class="question-dot-edge">‹‹</button>
                <button
                  v-for="q in visibleDots"
                  :key="q.index"
                  @click="goToQuestion(q.index)"
                  class="question-dot"
                  :class="[
                    currentQuestionIndex === q.index ? 'question-dot-current' : answeredStatus.get(q.index) ? 'question-dot-answered' : 'question-dot-idle',
                  ]"
                  :aria-label="`第 ${q.index + 1} 题${answeredStatus.get(q.index) ? '，已作答' : '，未作答'}`"
                  :aria-current="currentQuestionIndex === q.index ? 'step' : undefined"
                >
                  <span>{{ q.index + 1 }}</span>
                </button>
                <button v-if="visibleDotOffset + VISIBLE_DOT_COUNT < (session?.questions.length ?? 0)" disabled class="question-dot-edge">››</button>
              </div>
            </div>
            <!-- 题目卡片 -->
            <div class="mx-auto w-full max-w-2xl pb-6">
              <div class="clay clay-glass overflow-hidden shadow-[0_8px_30px_rgba(0,0,0,0.06)]">
                <div class="flex items-center gap-2 bg-[var(--accent-soft)] px-4 py-2.5 sm:px-5">
                  <span class="flex h-6 w-6 items-center justify-center rounded-full bg-[var(--accent)] text-xs font-bold text-white shadow-sm">{{ (currentQuestion?.index ?? 0) + 1 }}</span>
                  <span class="font-display text-xs font-semibold text-[var(--accent-strong)]">{{ { multiple_choice: '选择题', fill_blank: '填空题', true_false: '判断题', short_answer: '简答题' }[currentQuestion?.type ?? 'multiple_choice'] }}</span>
                  <span class="ml-auto text-xs font-medium text-[var(--ink-soft)]">{{ currentQuestion?.points }}分</span>
                </div>
                <div class="space-y-4 px-4 py-4 sm:px-5 sm:py-5">
                  <div v-if="currentQuestion?.passage" class="passage-block md-body text-sm" :class="config.subject === 'chinese' ? 'passage-block-chi' : config.subject === 'english' ? 'passage-block-eng' : ''" v-html="renderMarkdown(currentQuestion.passage)"></div>
                  <div class="md-body text-sm font-medium leading-relaxed text-[var(--ink)]" v-html="renderMarkdown(currentQuestion?.stem ?? '')"></div>

                  <!-- Multiple Choice -->
                  <div v-if="currentQuestion?.type === 'multiple_choice'" class="space-y-2.5">
                    <button v-for="opt in displayOptions(currentQuestion)" :key="opt.key" @click="setMultipleChoiceAnswer(currentQuestion?.index, currentQuestion?.multiSelect, opt.key)"
                      class="exam-opt group"
                      :class="(getAnswer(currentQuestion?.index ?? -1) || []).includes(opt.key) ? 'exam-opt-selected' : 'exam-opt-idle'"
                    >
                      <span class="exam-opt-key" :class="(getAnswer(currentQuestion?.index ?? -1) || []).includes(opt.key) ? 'exam-opt-key-selected' : ''">{{ opt.key }}</span>
                      <div class="md-body min-w-0 flex-1 text-left" v-html="renderMarkdown(opt.text)"></div>
                    </button>
                    <p v-if="currentQuestion?.multiSelect" class="text-xs text-[var(--ink-soft)]">可多选</p>
                  </div>

                  <!-- True/False -->
                  <div v-if="currentQuestion?.type === 'true_false'" class="grid grid-cols-2 gap-3">
                    <button v-for="opt in [{ v: true, l: '正确' }, { v: false, l: '错误' }]" :key="String(opt.v)" @click="setTrueFalseAnswer(currentQuestion?.index, opt.v)" class="exam-tf" :class="getAnswer(currentQuestion?.index ?? -1) === opt.v ? 'exam-tf-selected' : 'exam-tf-idle'">{{ opt.l }}</button>
                  </div>

                  <!-- Fill Blank -->
                  <div v-if="currentQuestion?.type === 'fill_blank'" class="space-y-2.5">
                    <div v-for="i in blankCountForQuestion(currentQuestion)" :key="i" class="flex items-center gap-2" v-motion :initial="{ opacity: 0, x: -12 }" :enter="{ opacity: 1, x: 0, transition: { delay: 80 + i * 50 } }">
                      <span class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--accent-soft)] text-xs font-bold text-[var(--accent-strong)]">{{ i }}</span>
                      <input :value="(getAnswer(currentQuestion?.index ?? -1) || [])[i - 1] || ''" @input="(e) => setFillBlankAnswer(currentQuestion?.index, blankCountForQuestion(currentQuestion), i - 1, (e.target as HTMLInputElement).value)" class="exam-field flex-1" placeholder="填写答案" />
                    </div>
                  </div>

                  <!-- Short Answer -->
                  <div v-if="currentQuestion?.type === 'short_answer'" v-motion :initial="{ opacity: 0, y: 12 }" :enter="{ opacity: 1, y: 0, transition: { delay: 100 } }">
                    <textarea :value="getAnswer(currentQuestion?.index ?? -1) || ''" @input="(e) => setShortAnswerAnswer(currentQuestion?.index, (e.target as HTMLTextAreaElement).value)" rows="4" class="exam-field w-full" placeholder="写下你的答案…" />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </Transition>
      </div>

      <!-- 底部导航（无边沉浸） -->
      <div class="absolute bottom-0 left-0 right-0 z-20 px-4 py-3">
        <div class="mx-auto flex max-w-2xl items-center justify-between gap-3">
          <button @click="prevQuestion" :disabled="isFirstQuestion" class="exam-nav-btn" :class="isFirstQuestion ? 'exam-nav-btn-disabled' : 'exam-nav-btn-secondary'">
            <ArrowLeft class="h-4 w-4" /> 上一题
          </button>
          <div class="hidden flex-1 text-center text-xs text-[var(--ink-soft)] sm:block">
            使用 <kbd class="rounded bg-[var(--line)] px-1.5 py-0.5 font-sans text-[10px]">←</kbd> <kbd class="rounded bg-[var(--line)] px-1.5 py-0.5 font-sans text-[10px]">→</kbd> 切换
          </div>
          <button @click="nextQuestion" class="exam-nav-btn" :class="isLastQuestion ? 'exam-nav-btn-submit' : 'exam-nav-btn-primary'">
            {{ nextButtonLabel }} <component :is="nextButtonIcon" class="h-4 w-4" />
          </button>
        </div>
      </div>

    </div>

    <!-- ═══ GRADING（与 GENERATING 一致布局） ═══ -->
    <div v-if="examState === 'grading'" class="flex h-full flex-col items-center justify-center">
      <div class="flex flex-col items-center gap-6" v-motion :initial="{ opacity: 0, scale: 0.9 }" :enter="{ opacity: 1, scale: 1, transition: { delay: 100, duration: 500 } }">
        <div class="loading-mascot"><Mascot :size="80" state="thinking" /></div>
        <h2 class="brand-text text-xl font-bold tracking-tight">博文正在评分</h2>
        <div class="w-80 space-y-1">
          <div
            v-for="item in gradingSteps"
            :key="item.step"
            class="step-row step-row-timeline"
            :class="[`step-row-${gradingStepState(item.step)}`, gradingStepState(item.step) === 'pending' ? 'opacity-45' : '']"
          >
            <span class="step-dot" :class="gradingDotClass(item.step)"><span class="step-dot-core"></span></span>
            <span class="flex-1 font-display text-sm font-semibold text-[var(--ink)]">{{ item.label }}</span>
            <span v-if="gradingStepState(item.step) === 'active'" class="step-active-dot"></span>
          </div>
          <p class="pt-2 text-center text-xs font-medium text-[var(--ink-soft)]">{{ gradingProgress.step === 'grade' ? '正在批改评分' : gradingProgress.step === 'analyze' ? '正在生成分析' : gradingProgress.step === 'profile' ? '正在写入画像' : gradingProgress.step === 'save' ? '正在保存结果' : '' }}</p>
        </div>
        <div class="h-1.5 w-80 overflow-hidden rounded-full bg-[var(--line)]">
          <div class="progress-fill h-full rounded-full" :style="{ width: gradingProgress.progress + '%' }"></div>
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
        <div class="clay clay-glass p-6 text-center" :class="{ 'score-reveal': scoreRevealed }" v-motion :initial="{ opacity: 0, scale: 0.9 }" :enter="{ opacity: 1, scale: 1, transition: { type: 'spring', stiffness: 260, damping: 20 } }">
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
        <div v-if="results.analysis" class="clay clay-glass overflow-hidden" v-motion :initial="{ opacity: 0, y: 16 }" :enter="{ opacity: 1, y: 0, transition: { delay: 120 } }">
          <div class="flex items-start gap-3 p-4">
            <div class="shrink-0"><Mascot :size="44" state="happy" /></div>
            <div class="min-w-0 flex-1">
              <p class="mb-2 font-display text-xs font-bold text-[var(--accent)]">博文的总结</p>
              <div class="analysis-body text-sm leading-relaxed text-[var(--ink)]" v-html="renderMarkdown(results.analysis)"></div>
            </div>
          </div>
        </div>

        <!-- Tier Breakdown -->
        <div class="clay clay-glass p-4" v-motion :initial="{ opacity: 0, y: 16 }" :enter="{ opacity: 1, y: 0, transition: { delay: 150 } }">
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
        <div class="clay clay-glass p-4" v-motion :initial="{ opacity: 0, y: 16 }" :enter="{ opacity: 1, y: 0, transition: { delay: 200 } }">
          <h3 class="mb-3 font-display text-xs font-bold text-[var(--ink-soft)]">知识点分析</h3>
          <div v-for="kp in results.kpBreakdown" :key="kp.kp" class="mb-2 flex items-center gap-3 last:mb-0">
            <GraduationCap class="h-3.5 w-3.5 shrink-0 text-[var(--accent)]" />
            <span class="flex-1 min-w-0 truncate text-xs font-medium text-[var(--ink)]">{{ kp.kp }}</span>
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

        <!-- 核心素养（主指标，优先展示） -->
        <div class="clay clay-glass p-4" v-motion :initial="{ opacity: 0, y: 16 }" :enter="{ opacity: 1, y: 0, transition: { delay: 180 } }">
          <h3 class="mb-3 font-display text-xs font-bold text-[var(--ink-soft)]">核心素养 <span class="font-normal text-[var(--ink-soft)]/60">— 综合能力评价</span></h3>
          <div class="flex flex-wrap gap-3">
            <div v-for="lit in results.literacyBreakdown" :key="lit.literacy" class="flex flex-1 flex-col items-center gap-1.5 rounded-xl border border-[var(--line)] px-3 py-3 min-w-[100px]">
              <span class="text-xs font-semibold text-[var(--ink)]">{{ lit.literacy }}</span>
              <StarDisplay :score="lit.percentage" />
              <span class="text-[10px] font-semibold text-[var(--ink-soft)]">{{ lit.score }}/{{ lit.maxScore }}</span>
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
        <div class="clay clay-glass overflow-hidden" v-motion :initial="{ opacity: 0, y: 16 }" :enter="{ opacity: 1, y: 0, transition: { delay: 300 } }">
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

/* ── 顶部题号轨道 ── */
.dot-nav-scroll {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.35rem;
  overflow-x: auto;
  scrollbar-width: none;
}
.dot-nav-scroll::-webkit-scrollbar { display: none; }
.question-dot-edge {
  display: grid; place-items: center;
  width: 1.2rem; height: 2.75rem;
  border: none; background: transparent;
  font-size: 0.7rem; color: var(--ink-soft);
  opacity: 0.4; cursor: default;
}
.question-dot {
  position: relative;
  display: grid;
  place-items: center;
  flex: 0 0 2.25rem;
  width: 2.25rem;
  height: 2.25rem;
  border-radius: 999px;
  border: 1.5px solid var(--line);
  background: #fffdf8;
  color: var(--ink-soft);
  cursor: pointer;
  font-family: var(--font-display);
  font-size: 1rem;
  font-weight: 700;
  line-height: 1;
  box-shadow: 0 3px 9px -8px rgba(92, 74, 50, 0.55), inset 0 -1px 0 rgba(92, 74, 50, 0.06);
  transform-origin: center;
  transition:
    transform 0.22s cubic-bezier(0.34, 1.56, 0.64, 1),
    background-color 0.22s ease,
    border-color 0.22s ease,
    color 0.22s ease,
    box-shadow 0.22s ease;
}
.question-dot::after {
  content: '';
  position: absolute;
  inset: -0.28rem;
  border-radius: inherit;
  border: 1px solid transparent;
  opacity: 0;
  transform: scale(0.7);
  transition: opacity 0.22s ease, transform 0.22s cubic-bezier(0.34, 1.56, 0.64, 1), border-color 0.22s ease;
}
.question-dot:hover {
  transform: translateY(-2px);
  border-color: rgba(249, 115, 22, 0.5);
  color: var(--accent-strong);
  box-shadow: 0 9px 18px -14px rgba(92, 74, 50, 0.45), inset 0 -1px 0 rgba(92, 74, 50, 0.06);
}
.question-dot:active { transform: translateY(0) scale(0.93); }
.question-dot:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px rgba(249, 115, 22, 0.24), 0 8px 18px -14px rgba(92, 74, 50, 0.5);
}
.question-dot-idle { background: #fffdf8; }
.question-dot-answered {
  border-color: #bde8c7;
  background: #e8f6ed;
  color: #1f8f52;
  box-shadow: 0 5px 14px -12px rgba(31, 143, 82, 0.55), inset 0 1px 0 rgba(255,255,255,0.8);
}
.question-dot-answered::after {
  opacity: 1;
  transform: scale(0.78);
  border-color: rgba(31, 143, 82, 0.18);
}
.question-dot-current {
  z-index: 3;
  border-color: #f97316;
  background: linear-gradient(145deg, #ffb15d 0%, #f97316 100%);
  color: #fff;
  transform: translateY(-3px) scale(1.12);
  box-shadow:
    0 9px 18px -10px rgba(249, 115, 22, 0.65),
    0 0 0 4px rgba(249, 115, 22, 0.16),
    inset 0 1px 0 rgba(255,255,255,0.38);
}
.question-dot-current::after {
  opacity: 1;
  transform: scale(1);
  border-color: rgba(249, 115, 22, 0.35);
}
.question-dot-current span { animation: dotNumberPop 0.28s cubic-bezier(0.34, 1.56, 0.64, 1); }
@keyframes dotNumberPop {
  from { transform: scale(0.76); opacity: 0.65; }
  to { transform: scale(1); opacity: 1; }
}

/* ── 步骤列表 ── */
.step-row { position: relative; display: flex; min-height: 2rem; align-items: center; gap: 0.75rem; padding: 0.35rem 0; transition: opacity 0.28s ease, transform 0.28s ease; }
.step-row-timeline:not(:last-of-type)::before { content: ''; position: absolute; left: 0.675rem; top: 1.65rem; bottom: -0.42rem; width: 2px; border-radius: 999px; background: var(--line); transform: translateX(-50%); transition: background-color 0.35s ease, box-shadow 0.35s ease; }
.step-row-done::before { background: #bde8c7; box-shadow: 0 0 0 1px rgba(24, 165, 88, 0.08); }
.step-row-active { }
.step-dot { position: relative; display: grid; place-items: center; width: 1.35rem; height: 1.35rem; flex-shrink: 0; border: 1.5px solid var(--line); border-radius: 999px; background: #fffdf8; box-shadow: inset 0 -1px 0 rgba(92, 74, 50, 0.08), 0 5px 12px -12px rgba(92, 74, 50, 0.65); transition: background-color 0.32s ease, border-color 0.32s ease, box-shadow 0.32s ease, transform 0.32s cubic-bezier(0.34, 1.56, 0.64, 1); }
.step-dot-core { width: 0.38rem; height: 0.38rem; border-radius: 999px; background: currentColor; opacity: 0.9; transition: transform 0.32s cubic-bezier(0.34, 1.56, 0.64, 1), background-color 0.32s ease, opacity 0.32s ease; }
.dot-active { border-color: #f97316; background: linear-gradient(145deg, #ffb15d 0%, #f97316 100%); color: #fff; box-shadow: 0 0 0 4px rgba(249, 115, 22, 0.14), 0 10px 20px -14px rgba(249, 115, 22, 0.7); }
.dot-active::after { content: ''; position: absolute; inset: -0.34rem; border-radius: inherit; border: 1px solid rgba(249, 115, 22, 0.38); animation: stepRing 1.5s ease-in-out infinite; }
.dot-active .step-dot-core { background: #fff; transform: scale(0.92); }
.dot-done { border-color: #bde8c7; background: linear-gradient(145deg, #e8f6ed 0%, #c8efd4 100%); color: #18a558; box-shadow: 0 0 0 3px rgba(24, 165, 88, 0.1), inset 0 1px 0 rgba(255,255,255,0.85), 0 9px 18px -14px rgba(24, 165, 88, 0.55); animation: stepDonePop 0.36s cubic-bezier(0.34, 1.56, 0.64, 1) both; }
.dot-done .step-dot-core { width: 0.52rem; height: 0.52rem; background: #18a558; box-shadow: inset 0 1px 0 rgba(255,255,255,0.3); }
.dot-pending { color: var(--accent-strong); background: #fffaf2; }
.dot-pending .step-dot-core { opacity: 0.35; transform: scale(0.72); }
.step-active-dot { width: 0.375rem; height: 0.375rem; border-radius: 999px; background: var(--accent); animation: stepPulse 1.6s ease-in-out infinite; }
@keyframes stepPulse { 0%,100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.4; transform: scale(0.6); } }
@keyframes stepRing { 0%,100% { opacity: 0.35; transform: scale(0.9); } 50% { opacity: 1; transform: scale(1.06); } }
@keyframes stepDonePop { from { transform: scale(0.72); } to { transform: scale(1); } }

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

/* ── 单题考试：选项按钮 ── */
.exam-opt {
  display: flex; align-items: center; gap: 0.75rem;
  width: 100%; padding: 0.75rem 1rem;
  border-radius: 18px; border: 1.5px solid var(--line); background: #fff;
  text-align: left; font-size: 0.95rem;
  cursor: pointer;
  transition: transform 0.16s ease, border-color 0.2s, background-color 0.2s, box-shadow 0.2s;
}
.exam-opt-idle:hover { transform: translateY(-2px); border-color: var(--accent); box-shadow: 0 10px 22px -14px rgba(0,0,0,0.12); }
.exam-opt-selected { border-color: var(--accent); background: var(--accent-soft); box-shadow: 0 0 0 3px var(--accent-soft); }
.exam-opt-key {
  display: grid; place-items: center;
  width: 1.75rem; height: 1.75rem; border-radius: 50%;
  font-weight: 800; font-size: 0.8rem;
  background: var(--accent-soft); color: var(--accent-strong);
  transition: background-color 0.25s, color 0.25s, transform 0.25s cubic-bezier(0.34, 1.56, 0.64, 1);
}
.exam-opt-key-selected { background: var(--accent); color: #fff; transform: scale(1.1); }
.exam-opt :deep(.md-body > :first-child) { margin-top: 0; }
.exam-opt :deep(.md-body > :last-child) { margin-bottom: 0; }

/* ── 单题考试：判断题 ── */
.exam-tf {
  padding: 0.85rem 1rem; border-radius: 18px;
  border: 1.5px solid var(--line); background: #fff;
  font-family: var(--font-display); font-weight: 700; font-size: 0.95rem;
  cursor: pointer; transition: transform 0.16s ease, border-color 0.2s, background-color 0.2s, box-shadow 0.2s;
}
.exam-tf-idle:hover { transform: translateY(-2px); border-color: var(--accent); }
.exam-tf-selected { border-color: var(--accent); background: var(--accent-soft); color: var(--accent-strong); box-shadow: 0 0 0 3px var(--accent-soft); }

/* ── 单题考试：输入框 ── */
.exam-field {
  width: 100%; padding: 0.6rem 0.9rem;
  border-radius: 14px; border: 1.5px solid var(--line); background: #fff;
  font-size: 0.95rem; resize: vertical;
  transition: border-color 0.2s, box-shadow 0.2s, transform 0.2s;
}
.exam-field:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); transform: translateY(-1px); }

/* ── 单题考试：底部导航 ── */
.exam-nav-btn {
  display: inline-flex; align-items: center; gap: 0.4rem;
  padding: 0.65rem 1.1rem; border-radius: 16px;
  font-family: var(--font-display); font-size: 0.9rem; font-weight: 700;
  cursor: pointer; transition: transform 0.16s ease, box-shadow 0.2s, background-color 0.2s, color 0.2s, border-color 0.2s;
}
.exam-nav-btn:active:not(:disabled) { transform: scale(0.96); }
.exam-nav-btn-primary { border: none; background: var(--accent); color: #fff; box-shadow: 0 4px 14px -4px rgba(0,0,0,0.2); }
.exam-nav-btn-primary:hover { background: var(--accent-strong); box-shadow: 0 6px 20px -6px rgba(0,0,0,0.25); }
.exam-nav-btn-submit { border: none; background: linear-gradient(135deg, var(--accent), var(--accent-strong)); color: #fff; box-shadow: 0 4px 16px -4px rgba(0,0,0,0.25); }
.exam-nav-btn-submit:hover { filter: brightness(1.05); box-shadow: 0 6px 22px -6px rgba(0,0,0,0.3); }
.exam-nav-btn-secondary { border: 1.5px solid var(--line); background: #fff; color: var(--ink); }
.exam-nav-btn-secondary:hover { border-color: var(--accent); background: var(--accent-soft); color: var(--accent-strong); }
.exam-nav-btn-disabled { opacity: 0.35; cursor: not-allowed; border: 1.5px solid var(--line); background: #fff; color: var(--ink-soft); }

/* ── 单题切换动画 ── */
.question-next-enter-active, .question-next-leave-active,
.question-prev-enter-active, .question-prev-leave-active {
  transition: all 0.35s cubic-bezier(0.34, 1.56, 0.64, 1);
}
.question-next-enter-from { opacity: 0; transform: translateX(35px) scale(0.98); }
.question-next-leave-to { opacity: 0; transform: translateX(-35px) scale(0.98); }
.question-prev-enter-from { opacity: 0; transform: translateX(-35px) scale(0.98); }
.question-prev-leave-to { opacity: 0; transform: translateX(35px) scale(0.98); }

@media (prefers-reduced-motion: reduce) {
  .exam-opt, .exam-tf, .exam-nav-btn, .question-dot, .question-dot::after, .step-row, .step-dot, .step-dot-core, .step-row-timeline::before { transition: none; }
  .question-next-enter-active, .question-next-leave-active,
  .question-prev-enter-active, .question-prev-leave-active { transition: none; }
  .exam-opt-key-selected { transform: none; }
  .question-dot-current span, .dot-active::after, .dot-done, .step-active-dot { animation: none; }
  .dot-nav-scroll { scroll-behavior: auto; }
}
</style>
