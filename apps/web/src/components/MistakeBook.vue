<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  AlertCircle,
  ArrowLeft,
  BookOpenCheck,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  FileImage,
  ImagePlus,
  Loader2,
  NotebookPen,
  RefreshCw,
  ScanText,
  Sparkles,
  Target,
  Trash2,
  UploadCloud,
  WandSparkles,
  X,
} from 'lucide-vue-next';
import type { AnalyzeMistakeEvent, AnalyzeMistakeStep, Grade, MistakeItem } from '@boen/shared';
import {
  createImageMistake,
  createTextMistake,
  deleteMistake,
  fetchMistakeAssetObjectUrl,
  getMistakePracticePrompt,
  listMistakes,
  streamMistakeAnalyze,
} from '@/services/chat';
import Mascot from '@/components/Mascot.vue';
import BoenSelect from '@/components/BoenSelect.vue';
import { renderMarkdown } from '@/lib/markdown';
import { processTikzDiagrams } from '@/lib/tikz';

type Subject = 'chinese' | 'math' | 'english' | 'science';
type IntakeMode = 'image' | 'text';

const props = defineProps<{
  grade: string;
  initialSubject: Subject;
}>();

const emit = defineEmits<{
  (e: 'back'): void;
  (e: 'practice', detail: { prompt: string; subject: Subject; grade: string }): void;
}>();

const SUBJECTS = [
  { value: 'chinese' as const, label: '语文' },
  { value: 'math' as const, label: '数学' },
  { value: 'english' as const, label: '英语' },
  { value: 'science' as const, label: '科学' },
];
const STEP_META: Record<AnalyzeMistakeStep, { label: string; icon: typeof ScanText }> = {
  ocr: { label: '识别题面', icon: ScanText },
  analyze: { label: '分析错因', icon: WandSparkles },
  map: { label: '定位知识点', icon: Target },
  profile: { label: '写入画像', icon: BookOpenCheck },
  style: { label: '沉淀题型', icon: Sparkles },
  complete: { label: '完成', icon: CheckCircle2 },
};
const STEPS: AnalyzeMistakeStep[] = ['ocr', 'analyze', 'map', 'profile', 'style', 'complete'];

const QUESTION_TYPE_OPTIONS = [
  { value: '', label: '自动识别题型' },
  { value: '选择题', label: '选择题' },
  { value: '填空题', label: '填空题' },
  { value: '判断题', label: '判断题' },
  { value: '解答题', label: '解答题' },
];

const mode = ref<IntakeMode>('image');
const textPrompt = ref('');
const studentAnswer = ref('');
const note = ref('');
const imageFile = ref<File | null>(null);
const imagePreview = ref('');
const imageError = ref('');
const dragging = ref(false);
const mistakes = ref<MistakeItem[]>([]);
const selectedMistake = ref<MistakeItem | null>(null);
const loadingList = ref(false);
const busy = ref(false);
const error = ref('');
const correctNotice = ref('');
const progress = ref(0);
const progressMessage = ref('');
const activeStep = ref<AnalyzeMistakeStep | null>(null);
const completedSteps = ref<Set<AnalyzeMistakeStep>>(new Set());
const selectedAssetObjectUrl = ref('');
const batchMistakes = ref<MistakeItem[]>([]);
const currentBatchIndex = ref(0);
const subjectFilter = ref<Subject | 'all'>('all');
const rightView = ref<'idle' | 'create' | 'detail'>('idle');
const questionType = ref('');
const choiceOptions = ref(['', '', '', '']);
const selectedChoice = ref('');
const judgmentAnswer = ref('');
const fillAnswer = ref('');
const detailedAnswer = ref('');

function resetStructuredFields() {
  choiceOptions.value = ['', '', '', ''];
  selectedChoice.value = '';
  judgmentAnswer.value = '';
  fillAnswer.value = '';
  detailedAnswer.value = '';
}

const promptPlaceholder = computed(() => {
  if (questionType.value === '选择题') return '输入题干内容，选项在下方单独填写…';
  if (questionType.value === '判断题') return '输入需要判断的陈述内容…';
  if (questionType.value === '填空题') return '输入题目内容，用 ____ 标记填空位置…';
  if (questionType.value === '解答题') return '输入题目内容，学生作答在下方单独填写…';
  return '粘贴或输入题面、选项、原始作答...';
});

watch(questionType, () => resetStructuredFields());

const mappedScoreDelta = computed(() => selectedMistake.value?.mappings?.filter((m) => m.afterScore !== undefined) ?? []);

function revokeSelectedAssetUrl() {
  if (selectedAssetObjectUrl.value) URL.revokeObjectURL(selectedAssetObjectUrl.value);
  selectedAssetObjectUrl.value = '';
}

function gradeLabel(g: string) {
  const n = Number(g);
  return n <= 6 ? `${'一二三四五六'[n - 1]}年级` : `初${['一', '二', '三'][n - 7]}`;
}

function formatTime(sec: number) {
  return new Date(sec * 1000).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
}

async function refreshMistakes(selectLatest = false) {
  loadingList.value = true;
  try {
    const params: { grade?: string; limit: number; subject?: Subject } = { grade: props.grade ?? undefined, limit: 30 };
    if (subjectFilter.value !== 'all') params.subject = subjectFilter.value;
    const data = await listMistakes(params);
    mistakes.value = data.mistakes;
    if (selectLatest && data.mistakes[0]) {
      selectedMistake.value = data.mistakes[0];
      rightView.value = 'detail';
    } else if (selectedMistake.value) {
      selectedMistake.value = data.mistakes.find((m) => m.id === selectedMistake.value?.id) ?? selectedMistake.value;
    }
  } finally {
    loadingList.value = false;
  }
}

function resetProgress() {
  progress.value = 0;
  progressMessage.value = '';
  activeStep.value = null;
  completedSteps.value = new Set();
}

function handleAnalyzeEvent(event: AnalyzeMistakeEvent) {
  if (event.type === 'mistake_progress') {
    activeStep.value = event.step;
    progress.value = event.progress;
    progressMessage.value = event.message;
    const next = new Set(completedSteps.value);
    for (const step of STEPS) {
      if (STEPS.indexOf(step) < STEPS.indexOf(event.step)) next.add(step);
    }
    completedSteps.value = next;
  } else if (event.type === 'mistake_ready') {
    batchMistakes.value.push(event.mistake);
    currentBatchIndex.value = batchMistakes.value.length - 1;
    selectedMistake.value = event.mistake;
    // 答案匹配度≥阈值：判定为大概率做对，从前端错题列表过滤
    if (event.mistake.isCorrect) {
      const score = Math.round((event.mistake.answerMatchScore ?? 0) * 100);
      correctNotice.value = `该题学生答案与正确答案匹配度 ${score}%，判定为大概率做对，已自动移出错题列表。题型风格特征仍已沉淀，将融入后续出题。`;
      // 从列表移除（重分析场景下可能已存在）
      mistakes.value = mistakes.value.filter((m) => m.id !== event.mistake.id);
    } else {
      correctNotice.value = '';
      // 更新列表
      const index = mistakes.value.findIndex((m) => m.id === event.mistake.id);
      if (index >= 0) mistakes.value[index] = event.mistake;
      else mistakes.value.unshift(event.mistake);
    }
    progress.value = 100;
    activeStep.value = 'complete';
    completedSteps.value = new Set(STEPS);
  } else if (event.type === 'error') {
    error.value = event.message;
  }
}

function prevQuestion() {
  if (currentBatchIndex.value > 0) {
    currentBatchIndex.value--;
    selectedMistake.value = batchMistakes.value[currentBatchIndex.value];
  }
}

function nextQuestion() {
  if (currentBatchIndex.value < batchMistakes.value.length - 1) {
    currentBatchIndex.value++;
    selectedMistake.value = batchMistakes.value[currentBatchIndex.value];
  }
}

async function analyzeCreated(id: string) {
  resetProgress();
  await streamMistakeAnalyze(id, handleAnalyzeEvent);
  await refreshMistakes();
}

function clearImage() {
  imageFile.value = null;
  if (imagePreview.value) URL.revokeObjectURL(imagePreview.value);
  imagePreview.value = '';
}

const MAX_IMAGE_SIZE = 15 * 1024 * 1024; // 15MB（nginx 上限 20MB，前端提前拦截）

function setImage(file?: File | null) {
  if (!file) return;
  if (file.size > MAX_IMAGE_SIZE) {
    imageError.value = '图片大小不符合要求';
    imagePreview.value = '';
    imageFile.value = null;
    return;
  }
  clearImage();
  imageFile.value = file;
  imagePreview.value = URL.createObjectURL(file);
}

function onFileChange(event: Event) {
  const input = event.target as HTMLInputElement;
  setImage(input.files?.[0] ?? null);
  input.value = '';
}

function onDrop(event: DragEvent) {
  dragging.value = false;
  setImage(event.dataTransfer?.files?.[0] ?? null);
}

function buildPromptText(): string {
  if (questionType.value === '选择题') {
    const opts = choiceOptions.value
      .map((t, i) => t.trim() ? `${String.fromCharCode(65 + i)}. ${t.trim()}` : '')
      .filter(Boolean)
      .join('\n');
    return [textPrompt.value.trim(), opts].filter(Boolean).join('\n');
  }
  return textPrompt.value.trim();
}

function buildStudentAnswer(): string {
  if (questionType.value === '选择题') return selectedChoice.value || studentAnswer.value;
  if (questionType.value === '判断题') return judgmentAnswer.value || studentAnswer.value;
  if (questionType.value === '填空题') return fillAnswer.value || studentAnswer.value;
  if (questionType.value === '解答题') return detailedAnswer.value || studentAnswer.value;
  return studentAnswer.value;
}

async function submitMistake() {
  if (busy.value) return;
  error.value = '';
  correctNotice.value = '';
  batchMistakes.value = [];
  currentBatchIndex.value = 0;
  busy.value = true;
  try {
    const subject = (subjectFilter.value !== 'all' ? subjectFilter.value : props.initialSubject) as Subject;
    let created: { mistake: MistakeItem };
    if (mode.value === 'text') {
      if (!textPrompt.value.trim()) throw new Error('请先输入题面');
      created = await createTextMistake({
        sourceType: 'text',
        subject,
        grade: props.grade,
        promptText: buildPromptText(),
        studentAnswer: buildStudentAnswer(),
        note: [questionType.value ? `题型：${questionType.value}` : '', note.value].filter(Boolean).join(' · '),
      });
    } else {
      // 'image' is the default fallback
      if (!imageFile.value) throw new Error('请先上传错题图片');
      created = await createImageMistake({
        sourceType: 'image',
        subject,
        grade: props.grade,
        file: imageFile.value,
        filename: imageFile.value.name,
        studentAnswer: studentAnswer.value,
        note: note.value,
      });
    }
    selectedMistake.value = created.mistake;
    await analyzeCreated(created.mistake.id);
    textPrompt.value = '';
    studentAnswer.value = '';
    note.value = '';
    questionType.value = '';
    resetStructuredFields();
    clearImage();
    rightView.value = 'detail';
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    busy.value = false;
  }
}

async function reanalyze(mistake: MistakeItem) {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  correctNotice.value = '';
  selectedMistake.value = mistake;
  try {
    await analyzeCreated(mistake.id);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    busy.value = false;
  }
}

async function archive(id: string) {
  await deleteMistake(id);
  if (selectedMistake.value?.id === id) selectedMistake.value = null;
  await refreshMistakes(true);
}

async function startPractice(mistake: MistakeItem) {
  const { prompt } = await getMistakePracticePrompt(mistake.id);
  emit('practice', { prompt, subject: mistake.subject as Subject, grade: mistake.grade });
}

const subjectGrouped = computed(() =>
  SUBJECTS.map(s => ({
    ...s,
    count: mistakes.value.filter(m => m.subject === s.value).length,
  })),
);

const filteredMistakes = computed(() =>
  subjectFilter.value === 'all'
    ? mistakes.value
    : mistakes.value.filter(m => m.subject === subjectFilter.value),
);

function openCreateForm() {
  rightView.value = 'create';
  selectedMistake.value = null;
  error.value = '';
  correctNotice.value = '';
  batchMistakes.value = [];
  currentBatchIndex.value = 0;
  resetProgress();
  resetStructuredFields();
  textPrompt.value = '';
  studentAnswer.value = '';
  note.value = '';
  questionType.value = '';
}

function selectMistake(m: MistakeItem) {
  selectedMistake.value = m;
  rightView.value = 'detail';
}

const tikzTimers = new Set<number>();
function scheduleTikzProcessing() {
  for (const id of tikzTimers) window.clearTimeout(id);
  tikzTimers.clear();
  const run = () => processTikzDiagrams(document).catch(() => {});
  nextTick(() => {
    run();
    requestAnimationFrame(run);
    for (const delay of [150, 600, 1500]) {
      const id = window.setTimeout(run, delay);
      tikzTimers.add(id);
    }
  });
}

onMounted(async () => {
  await refreshMistakes(true);
});

watch(selectedMistake, async (mistake) => {
  // 切换到非做对的题时清空"做对了"提示
  if (!mistake?.isCorrect) correctNotice.value = '';
  revokeSelectedAssetUrl();
  const asset = mistake?.assets?.[0];
  if (!mistake || !asset) {
    scheduleTikzProcessing();
    return;
  }
  try {
    selectedAssetObjectUrl.value = await fetchMistakeAssetObjectUrl(mistake.id, asset.id);
  } catch (e) {
    selectedAssetObjectUrl.value = '';
    console.warn('[mistakes] fetch asset failed:', e);
  }
  scheduleTikzProcessing();
}, { immediate: true });

watch(rightView, (v) => {
  if (v === 'detail') scheduleTikzProcessing();
});

onBeforeUnmount(() => {
  for (const id of tikzTimers) window.clearTimeout(id);
  tikzTimers.clear();
  revokeSelectedAssetUrl();
  clearImage();
});
</script>

<template>
  <div class="mistake-root flex h-full min-h-0 flex-col">
    <header class="flex shrink-0 items-center gap-3 px-5 py-3.5">
      <button
        @click="$emit('back')"
        class="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-[var(--surface)] text-[var(--ink-soft)] shadow-[0_8px_18px_-12px_rgba(86,64,40,0.4)] transition-all hover:bg-[var(--accent-soft)] hover:text-[var(--accent-strong)] active:scale-95"
        aria-label="返回对话"
      >
        <ArrowLeft class="h-5 w-5" />
      </button>
      <div>
        <h1 class="font-display text-2xl font-bold text-[var(--ink)]">错题本</h1>
        <p class="text-xs font-semibold text-[var(--ink-soft)]">真实作业错题，自动归因到知识画像</p>
      </div>
    </header>

    <main class="grid min-h-0 flex-1 grid-cols-1 gap-4 px-4 pb-4 lg:grid-cols-[360px_minmax(0,1fr)]">
      <aside class="panel-scroll flex min-h-0 flex-col gap-4 overflow-y-auto">
        <section class="clay clay-glass min-h-[220px] overflow-hidden" v-motion :initial="{ opacity: 0, y: 14 }" :enter="{ opacity: 1, y: 0, transition: { delay: 80 } }">
          <div class="flex items-center gap-2 border-b border-[var(--line)] px-4 py-3">
            <FileImage class="h-4 w-4 text-[var(--accent)]" />
            <h2 class="font-display text-sm font-bold text-[var(--ink)]">错题列表</h2>
            <button @click="openCreateForm" class="ml-auto grid h-8 w-8 place-items-center rounded-full bg-[var(--accent)] text-white shadow-sm transition-all hover:bg-[var(--accent-strong)] hover:scale-110 active:scale-95" aria-label="新增错题" title="新增错题">
              <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            </button>
            <button @click="refreshMistakes(true)" class="grid h-8 w-8 place-items-center rounded-full text-[var(--ink-soft)] transition-colors hover:bg-[var(--accent-soft)] hover:text-[var(--accent-strong)]" aria-label="刷新错题列表"><RefreshCw class="h-4 w-4" :class="{ 'animate-spin': loadingList }" /></button>
          </div>

          <div class="flex gap-1 overflow-x-auto border-b border-[var(--line)] px-3 py-2" style="scrollbar-width:none">
            <button
              v-for="s in [{ value: 'all' as const, label: '全部', count: mistakes.length }, ...subjectGrouped]"
              :key="s.value"
              @click="subjectFilter = s.value"
              class="flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-bold transition-all"
              :class="subjectFilter === s.value
                ? 'bg-[var(--accent)] text-white shadow-sm'
                : 'bg-[var(--paper)] text-[var(--ink-soft)] hover:bg-[var(--accent-soft)] hover:text-[var(--accent-strong)]'"
            >
              <span class="h-1.5 w-1.5 rounded-full" :style="{ background: s.value === 'all' ? 'var(--accent)' : s.value === 'chinese' ? '#e74c3c' : s.value === 'math' ? '#3498db' : s.value === 'english' ? '#f59e42' : '#2ecc71' }"></span>
              {{ s.label }}
              <span class="text-[10px] opacity-70">{{ s.count }}</span>
            </button>
          </div>

          <div v-if="filteredMistakes.length === 0" class="flex flex-col items-center gap-2 px-4 py-10 text-center">
            <Mascot :size="54" state="thinking" />
            <p class="text-xs font-semibold text-[var(--ink-soft)]">
              {{ subjectFilter === 'all' ? '还没有错题记录' : '该学科暂无错题' }}
            </p>
          </div>
          <div v-else v-auto-animate class="space-y-1 p-2">
            <button
              v-for="m in filteredMistakes"
              :key="m.id"
              @click="selectMistake(m)"
              class="group flex w-full items-center gap-2 rounded-2xl px-3 py-2.5 text-left transition-all hover:bg-[var(--accent-soft)] active:scale-[0.99]"
              :class="selectedMistake?.id === m.id && rightView === 'detail' ? 'bg-[var(--accent-soft)] text-[var(--accent-strong)]' : 'text-[var(--ink)]'"
            >
              <span class="grid h-9 w-9 shrink-0 place-items-center rounded-2xl bg-white shadow-sm">
                <NotebookPen class="h-4 w-4" :class="m.subject === 'chinese' ? 'text-[#e74c3c]' : m.subject === 'math' ? 'text-[#3498db]' : m.subject === 'english' ? 'text-[#f59e42]' : 'text-[#2ecc71]'" />
              </span>
              <span class="min-w-0 flex-1">
                <span class="block truncate text-sm font-bold">{{ m.title || '未命名错题' }}</span>
                <span class="mt-0.5 flex items-center gap-1.5 text-[11px] text-[var(--ink-soft)]">
                  <span>{{ SUBJECTS.find(s => s.value === m.subject)?.label }}</span>
                  <span>{{ formatTime(m.updatedAt) }}</span>
                  <span class="rounded-full px-1.5 py-0.5" :class="m.status === 'analyzed' ? 'bg-[#e7f7ee] text-[#18a558]' : 'bg-[#fef3e2] text-[#f59e42]'">{{ m.status === 'analyzed' ? '已归档' : '待确认' }}</span>
                </span>
              </span>
              <button @click.stop="archive(m.id)" class="grid h-8 w-8 shrink-0 place-items-center rounded-xl text-[var(--ink-soft)] opacity-100 transition-all hover:bg-[var(--error)]/10 hover:text-[var(--error)] sm:opacity-0 sm:group-hover:opacity-100" aria-label="归档错题"><Trash2 class="h-4 w-4" /></button>
            </button>
          </div>
        </section>
      </aside>

      <section class="clay clay-glass relative min-h-0 overflow-hidden" v-motion :initial="{ opacity: 0, y: 16 }" :enter="{ opacity: 1, y: 0, transition: { delay: 180 } }">
        <div v-if="busy || progress > 0" class="border-b border-[var(--line)] px-5 py-4">
          <div class="mb-3 flex items-center gap-2">
            <ScanText class="h-4 w-4 text-[var(--accent)]" />
            <span class="font-display text-sm font-bold text-[var(--ink)]">{{ progressMessage || '准备分析错题' }}</span>
            <span class="ml-auto text-xs font-bold text-[var(--accent-strong)]">{{ progress }}%</span>
          </div>
          <div class="h-2 overflow-hidden rounded-full bg-[var(--paper)]">
            <div class="h-full rounded-full bg-accent transition-all duration-300" :style="{ width: `${progress}%` }"></div>
          </div>
          <div class="mt-3 grid grid-cols-3 gap-2 md:grid-cols-6">
            <div v-for="step in STEPS" :key="step" class="flex items-center gap-1.5 rounded-2xl px-2 py-2 text-xs font-bold transition-all" :class="completedSteps.has(step) || activeStep === step ? 'bg-[var(--accent-soft)] text-[var(--accent-strong)]' : 'bg-white/60 text-[var(--ink-soft)]'">
              <component :is="STEP_META[step].icon" class="h-3.5 w-3.5" :class="{ 'animate-pulse': activeStep === step && !completedSteps.has(step) }" />
              <span class="truncate">{{ STEP_META[step].label }}</span>
            </div>
          </div>
        </div>

        <div v-if="correctNotice" class="mx-5 mt-4 flex items-start gap-2 rounded-2xl bg-[#e7f7ee] px-4 py-3 text-xs font-semibold text-[#18a558]">
          <CheckCircle2 class="mt-0.5 h-4 w-4 shrink-0" />
          <span class="leading-relaxed">{{ correctNotice }}</span>
        </div>

        <div v-if="rightView === 'idle'" class="flex h-full min-h-[520px] flex-col items-center justify-center gap-4 p-8 text-center">
          <Mascot :size="110" state="idle" />
          <div>
            <h2 class="font-display text-2xl font-bold text-[var(--ink)]">把真实错题放进来</h2>
            <p class="mt-2 max-w-md text-sm leading-relaxed text-[var(--ink-soft)]">点击左侧 <span class="inline-flex h-5 w-5 items-center justify-center rounded-full bg-[var(--accent)] text-[10px] font-bold text-white">+</span> 按钮新增错题，支持拍照上传和手动录入。</p>
          </div>
        </div>

        <div v-else-if="rightView === 'create'" class="panel-scroll h-full overflow-y-auto p-5">
          <div class="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
            <article class="space-y-4">
              <div class="rounded-[24px] bg-[var(--paper)]/70 p-4">
                <div class="mb-3 flex items-start gap-3">
                  <div class="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-[var(--accent-soft)] text-[var(--accent-strong)]"><NotebookPen class="h-5 w-5" /></div>
                  <div class="min-w-0 flex-1">
                    <h2 class="font-display text-xl font-bold text-[var(--ink)]">新增错题</h2>
                    <p class="text-xs font-semibold text-[var(--ink-soft)]">拍照或手动录入，系统自动分析错因并归入知识画像</p>
                  </div>
                </div>

                <div class="space-y-4">
                  <section v-if="mode === 'image'">
                    <p class="mb-1 text-xs font-bold text-[var(--ink-soft)]">题面图片</p>
                    <label
                      class="group flex min-h-[240px] cursor-pointer flex-col items-center justify-center rounded-[20px] border-2 border-dashed p-4 text-center transition-all"
                      :class="dragging ? 'border-[var(--accent)] bg-[var(--accent-soft)]' : 'border-[var(--line)] bg-white/60 hover:border-[var(--accent)] hover:bg-[var(--accent-soft)]/60'"
                      @dragover.prevent="dragging = true"
                      @dragleave.prevent="dragging = false"
                      @drop.prevent="onDrop"
                    >
                      <img v-if="imagePreview" :src="imagePreview" alt="错题图片预览" class="max-h-[300px] rounded-2xl object-contain shadow-sm" />
                      <template v-else>
                        <UploadCloud class="mb-3 h-12 w-12 text-[var(--accent)] transition-transform group-hover:-translate-y-1" />
                        <p class="text-sm font-bold text-[var(--ink)]">上传整页试卷或单题照片</p>
                        <p class="mt-1.5 text-xs text-[var(--ink-soft)]">支持 jpg / png / webp，自动切题识别多道题</p>
                        <p class="mt-0.5 text-[11px] text-[var(--ink-soft)] opacity-60">最大 15MB</p>
                      </template>
                      <input type="file" accept="image/png,image/jpeg,image/webp" class="sr-only" @change="onFileChange" />
                    </label>
                    <div class="mt-2 flex items-center justify-between">
                      <p v-if="imageError" class="text-xs font-semibold" style="color: var(--error)">{{ imageError }}</p>
                      <button v-if="imagePreview" @click="clearImage" class="ml-auto inline-flex h-8 items-center gap-1 rounded-xl bg-white/80 px-2.5 text-xs font-bold text-[var(--ink-soft)] shadow-sm transition-colors hover:bg-[var(--line)]"><X class="h-3 w-3" />移除图片</button>
                    </div>
                  </section>

                  <section>
                    <div class="mb-1 flex items-center gap-2">
                      <p class="text-xs font-bold text-[var(--ink-soft)]">{{ mode === 'image' ? '补充题面（可选）' : '题面' }}</p>
                      <span v-if="mode === 'image'" class="text-[10px] text-[var(--ink-soft)] opacity-60">OCR 识别后自动填入，可手动修正</span>
                    </div>
                    <textarea v-model="textPrompt" rows="5" class="w-full resize-none rounded-2xl border border-[var(--line)] bg-white/75 px-4 py-3 text-sm leading-relaxed text-[var(--ink)] outline-none transition-all focus:border-[var(--accent)] focus:bg-white focus:ring-4 focus:ring-[var(--accent-soft)]" :placeholder="mode === 'image' ? 'OCR 识别后将自动填入，也可在此补充...' : promptPlaceholder" />
                  </section>

                  <!-- ===== 选择题：四个选项输入 + radio 标记学生所选 ===== -->
                  <section v-if="mode === 'text' && questionType === '选择题'" class="space-y-2">
                    <p class="text-xs font-bold text-[var(--ink-soft)]">选项内容 <span class="font-normal opacity-60">（点击圆圈标记学生选择的答案）</span></p>
                    <div v-for="(opt, i) in choiceOptions" :key="i" class="group flex items-center gap-2 rounded-2xl border border-[var(--line)] bg-white/75 px-3 py-2.5 transition-all focus-within:border-[var(--accent)] focus-within:ring-4 focus-within:ring-[var(--accent-soft)]">
                      <button
                        @click="selectedChoice = String.fromCharCode(65 + i)"
                        class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-2 transition-all"
                        :class="selectedChoice === String.fromCharCode(65 + i)
                          ? 'border-[var(--error)] bg-[var(--error)]/10 text-[var(--error)]'
                          : 'border-[var(--line)] text-[var(--ink-soft)] hover:border-[var(--accent)] hover:text-[var(--accent)]'"
                        :title="`标记学生选了 ${String.fromCharCode(65 + i)}`"
                      >
                        <span class="text-xs font-bold">{{ String.fromCharCode(65 + i) }}</span>
                      </button>
                      <input
                        :value="choiceOptions[i]"
                        @input="choiceOptions[i] = ($event.target as HTMLInputElement).value"
                        class="min-w-0 flex-1 border-none bg-transparent text-sm leading-relaxed text-[var(--ink)] outline-none"
                        :placeholder="`选项 ${String.fromCharCode(65 + i)} 的内容`"
                      />
                      <span v-if="selectedChoice === String.fromCharCode(65 + i)" class="shrink-0 text-[10px] font-bold text-[var(--error)]">学生选的</span>
                    </div>
                  </section>

                  <!-- ===== 判断题：正确 / 错误 按钮 ===== -->
                  <section v-else-if="mode === 'text' && questionType === '判断题'" class="space-y-2">
                    <p class="text-xs font-bold text-[var(--ink-soft)]">学生判断</p>
                    <div class="grid grid-cols-2 gap-2">
                      <button
                        @click="judgmentAnswer = '正确'"
                        class="flex h-12 items-center justify-center gap-2 rounded-2xl border-2 text-sm font-bold transition-all active:scale-[0.97]"
                        :class="judgmentAnswer === '正确'
                          ? 'border-[#18a558] bg-[#e7f7ee] text-[#18a558]'
                          : 'border-[var(--line)] bg-white/75 text-[var(--ink-soft)] hover:border-[#18a558]'"
                      >
                        <CheckCircle2 class="h-4 w-4" /> 正确
                      </button>
                      <button
                        @click="judgmentAnswer = '错误'"
                        class="flex h-12 items-center justify-center gap-2 rounded-2xl border-2 text-sm font-bold transition-all active:scale-[0.97]"
                        :class="judgmentAnswer === '错误'
                          ? 'border-[var(--error)] bg-[var(--error)]/10 text-[var(--error)]'
                          : 'border-[var(--line)] bg-white/75 text-[var(--ink-soft)] hover:border-[var(--error)]'"
                      >
                        <X class="h-4 w-4" /> 错误
                      </button>
                    </div>
                  </section>

                  <!-- ===== 填空题：填空答案输入 ===== -->
                  <section v-else-if="mode === 'text' && questionType === '填空题'" class="space-y-2">
                    <p class="text-xs font-bold text-[var(--ink-soft)]">学生填空答案</p>
                    <input v-model="fillAnswer" class="w-full rounded-2xl border border-[var(--line)] bg-white/75 px-4 py-3 text-sm leading-relaxed text-[var(--ink)] outline-none transition-all focus:border-[var(--accent)] focus:bg-white focus:ring-4 focus:ring-[var(--accent-soft)]" placeholder="输入学生填写的答案" />
                  </section>

                  <!-- ===== 解答题：学生作答 textarea ===== -->
                  <section v-else-if="mode === 'text' && questionType === '解答题'" class="space-y-2">
                    <p class="text-xs font-bold text-[var(--ink-soft)]">学生作答</p>
                    <textarea v-model="detailedAnswer" rows="5" class="w-full resize-none rounded-2xl border border-[var(--line)] bg-white/75 px-4 py-3 text-sm leading-relaxed text-[var(--ink)] outline-none transition-all focus:border-[var(--accent)] focus:bg-white focus:ring-4 focus:ring-[var(--accent-soft)]" placeholder="输入学生的完整解答过程" />
                  </section>

                  <!-- ===== 通用：未选择题型 / 图片模式 → 原有简单输入 ===== -->
                  <div v-else class="grid gap-3 md:grid-cols-2">
                    <section class="rounded-2xl bg-white/75 p-4">
                      <p class="mb-1 text-xs font-bold text-[var(--ink-soft)]">学生答案</p>
                      <input v-model="studentAnswer" class="w-full border-none bg-transparent text-sm leading-relaxed text-[var(--ink)] outline-none" placeholder="输入学生的作答（可选）" />
                    </section>
                    <section class="rounded-2xl bg-white/75 p-4">
                      <p class="mb-1 text-xs font-bold text-[var(--ink-soft)]">来源备注</p>
                      <input v-model="note" class="w-full border-none bg-transparent text-sm leading-relaxed text-[var(--ink)] outline-none" placeholder="如：单元测验第 8 题（可选）" />
                    </section>
                  </div>

                  <!-- ===== 来源备注（结构化模式下单独展示） ===== -->
                  <section v-if="mode === 'text' && questionType" class="rounded-2xl bg-white/75 p-4">
                    <p class="mb-1 text-xs font-bold text-[var(--ink-soft)]">来源备注</p>
                    <input v-model="note" class="w-full border-none bg-transparent text-sm leading-relaxed text-[var(--ink)] outline-none" placeholder="如：单元测验第 8 题（可选）" />
                  </section>
                </div>
              </div>
            </article>

            <aside class="space-y-4">
              <div class="rounded-[24px] bg-[var(--accent-soft)] p-4">
                <div class="mb-3 flex items-center gap-2">
                  <ImagePlus class="h-4 w-4 text-[var(--accent-strong)]" />
                  <h3 class="font-display text-sm font-bold text-[var(--ink)]">录入方式</h3>
                </div>
                <div class="grid grid-cols-2 gap-1 rounded-2xl bg-white/60 p-1">
                  <button @click="mode = 'image'" class="flex h-10 items-center justify-center gap-1.5 rounded-xl text-xs font-bold transition-all" :class="mode === 'image' ? 'bg-[var(--surface)] text-[var(--accent-strong)] shadow-sm' : 'text-[var(--ink-soft)] hover:text-[var(--ink)]'"><ImagePlus class="h-3.5 w-3.5" />拍照</button>
                  <button @click="mode = 'text'" class="flex h-10 items-center justify-center gap-1.5 rounded-xl text-xs font-bold transition-all" :class="mode === 'text' ? 'bg-[var(--surface)] text-[var(--accent-strong)] shadow-sm' : 'text-[var(--ink-soft)] hover:text-[var(--ink)]'"><ScanText class="h-3.5 w-3.5" />文本</button>
                </div>
              </div>

              <div class="rounded-[24px] bg-white/75 p-4">
                <div class="mb-3 flex items-center gap-2">
                  <BookOpenCheck class="h-4 w-4 text-[var(--accent-strong)]" />
                  <h3 class="font-display text-sm font-bold text-[var(--ink)]">题目设置</h3>
                </div>
                <div class="space-y-3">
                  <div>
                    <p class="mb-1 text-[11px] font-bold text-[var(--ink-soft)]">题型</p>
                    <BoenSelect v-model="questionType" :options="QUESTION_TYPE_OPTIONS" placeholder="自动识别题型" />
                  </div>
                  <div class="rounded-2xl bg-[var(--paper)] p-3">
                    <p class="text-[11px] leading-relaxed text-[var(--ink-soft)]">
                      <template v-if="mode === 'image'">拍照后系统自动 OCR 识别题面，LLM 分析错因、定位知识点，并写入知识画像。一页照片可包含多道题，系统会逐题归档。</template>
                      <template v-else>手动输入题面文本，系统将调用 LLM 分析错因、匹配知识点，并更新学生的知识画像熟练度。</template>
                    </p>
                  </div>
                </div>
              </div>

              <button @click="submitMistake" :disabled="busy" class="btn-accent flex h-12 w-full items-center justify-center gap-2 rounded-[18px] font-display text-sm font-bold disabled:cursor-not-allowed">
                <Loader2 v-if="busy" class="h-4 w-4 animate-spin" />
                <Sparkles v-else class="h-4 w-4" />
                {{ busy ? '正在分析' : '识别并归档' }}
              </button>

              <p v-if="error" class="flex items-start gap-2 rounded-2xl bg-[var(--error)]/10 px-3 py-2 text-xs font-semibold text-[var(--error)]"><AlertCircle class="mt-0.5 h-4 w-4 shrink-0" />{{ error }}</p>
            </aside>
          </div>
        </div>

        <div v-else-if="rightView === 'detail' && selectedMistake" class="panel-scroll h-full overflow-y-auto p-5">
          <!-- Mobile back button -->
          <button @click="rightView = 'idle'; selectedMistake = null" class="mb-3 flex items-center gap-2 rounded-xl bg-[var(--surface)] px-3 py-2 text-sm font-semibold text-[var(--ink-soft)] shadow-sm transition-colors hover:bg-[var(--accent-soft)] hover:text-[var(--accent-strong)] md:hidden">
            <ArrowLeft class="h-4 w-4" /> 返回列表
          </button>
          <div class="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
            <article class="space-y-4">
              <div class="rounded-[24px] bg-[var(--paper)]/70 p-4">
                <div class="mb-3 flex items-start gap-3">
                  <div class="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-[var(--accent-soft)] text-[var(--accent-strong)]"><NotebookPen class="h-5 w-5" /></div>
                  <div class="min-w-0 flex-1">
                    <h2 class="font-display text-xl font-bold text-[var(--ink)]">{{ selectedMistake.title || '错题详情' }}</h2>
                    <p class="text-xs font-semibold text-[var(--ink-soft)]">
                      <template v-if="batchMistakes.length > 1">
                        <span class="mr-2 rounded-full bg-[var(--accent-soft)] px-2 py-0.5 text-[10px] text-[var(--accent-strong)]">{{ currentBatchIndex + 1 }} / {{ batchMistakes.length }}</span>
                      </template>
                      {{ SUBJECTS.find(s => s.value === selectedMistake?.subject)?.label }} · {{ gradeLabel(selectedMistake.grade) }} · {{ formatTime(selectedMistake.createdAt) }}
                    </p>
                  </div>
                  <div class="flex shrink-0 items-center gap-1">
                    <button v-if="batchMistakes.length > 1" @click="prevQuestion" :disabled="currentBatchIndex <= 0" class="grid h-9 w-9 place-items-center rounded-xl text-[var(--ink-soft)] transition-colors hover:bg-[var(--accent-soft)] hover:text-[var(--accent-strong)] disabled:opacity-30 disabled:hover:bg-transparent"><ChevronLeft class="h-4 w-4" /></button>
                    <button v-if="batchMistakes.length > 1" @click="nextQuestion" :disabled="currentBatchIndex >= batchMistakes.length - 1" class="grid h-9 w-9 place-items-center rounded-xl text-[var(--ink-soft)] transition-colors hover:bg-[var(--accent-soft)] hover:text-[var(--accent-strong)] disabled:opacity-30 disabled:hover:bg-transparent"><ChevronRight class="h-4 w-4" /></button>
                    <button @click="reanalyze(selectedMistake)" :disabled="busy" class="flex h-9 items-center gap-1 rounded-2xl bg-white px-2.5 text-xs font-bold text-[var(--ink-soft)] shadow-sm transition-colors hover:bg-[var(--accent-soft)] hover:text-[var(--accent-strong)] disabled:opacity-50"><RefreshCw class="h-3.5 w-3.5" />重分析</button>
                  </div>
                </div>

                <div v-if="selectedAssetObjectUrl" class="mb-4 overflow-hidden rounded-[20px] border border-white bg-white">
                  <img :src="selectedAssetObjectUrl" alt="错题原图" class="max-h-[360px] w-full object-contain" />
                </div>

                <div class="space-y-4">
                  <section>
                    <p class="mb-1 text-xs font-bold text-[var(--ink-soft)]">识别题面</p>
                    <div class="md-body rounded-2xl bg-white/75 p-4" v-html="renderMarkdown(selectedMistake.promptText || '暂无题面')"></div>
                  </section>
                  <div class="grid gap-3 md:grid-cols-2">
                    <section class="rounded-2xl bg-white/75 p-4">
                      <p class="mb-1 text-xs font-bold text-[var(--ink-soft)]">学生答案</p>
                      <div class="md-body text-sm" v-html="renderMarkdown(selectedMistake.studentAnswer || '未识别到学生答案')"></div>
                    </section>
                    <section class="rounded-2xl bg-white/75 p-4">
                      <p class="mb-1 text-xs font-bold text-[var(--ink-soft)]">正确答案</p>
                      <div class="md-body text-sm" v-html="renderMarkdown(selectedMistake.correctAnswer || '待补充')"></div>
                    </section>
                  </div>
                  <section class="rounded-2xl bg-white/75 p-4">
                    <p class="mb-1 text-xs font-bold text-[var(--ink-soft)]">错因诊断</p>
                    <p class="text-sm font-bold text-[var(--error)]">{{ selectedMistake.errorType || '待确认' }}</p>
                    <div class="md-body mt-2 text-sm" v-html="renderMarkdown(selectedMistake.errorReason || '暂未生成错因')"></div>
                  </section>
                  <section class="rounded-2xl bg-white/75 p-4">
                    <p class="mb-1 text-xs font-bold text-[var(--ink-soft)]">解法提示</p>
                    <div class="md-body text-sm" v-html="renderMarkdown(selectedMistake.explanation || '暂无解法')"></div>
                  </section>
                </div>
              </div>
            </article>

            <aside class="space-y-4">
              <div class="rounded-[24px] bg-[var(--accent-soft)] p-4">
                <div class="mb-3 flex items-center gap-2">
                  <Target class="h-4 w-4 text-[var(--accent-strong)]" />
                  <h3 class="font-display text-sm font-bold text-[var(--ink)]">知识图谱映射</h3>
                </div>
                <div v-if="!selectedMistake.mappings?.length" class="rounded-2xl bg-white/70 p-4 text-sm text-[var(--ink-soft)]">没有找到可信知识点，请补充题面后重分析。</div>
                <div v-else class="space-y-2">
                  <div v-for="m in selectedMistake.mappings" :key="m.kgNodeId" class="rounded-2xl bg-white/80 p-3 shadow-sm">
                    <div class="flex items-start gap-2">
                      <span class="rounded-full px-2 py-0.5 text-[10px] font-bold" :class="m.role === 'primary' ? 'bg-[var(--accent)] text-white' : 'bg-[var(--paper)] text-[var(--ink-soft)]'">{{ m.role === 'primary' ? '主考点' : '关联' }}</span>
                      <div class="min-w-0 flex-1">
                        <p class="text-sm font-bold text-[var(--ink)]">{{ m.title }}</p>
                        <p v-if="m.unitTitle" class="mt-0.5 text-[11px] text-[var(--ink-soft)]">{{ m.unitTitle }}</p>
                      </div>
                    </div>
                    <div class="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--paper)]"><div class="h-full rounded-full bg-accent" :style="{ width: `${Math.round(m.confidence * 100)}%` }"></div></div>
                    <p v-if="m.evidence" class="mt-2 text-[11px] leading-relaxed text-[var(--ink-soft)]">{{ m.evidence }}</p>
                  </div>
                </div>
              </div>

              <div class="rounded-[24px] bg-white/75 p-4">
                <div class="mb-3 flex items-center gap-2">
                  <BookOpenCheck class="h-4 w-4 text-[#18a558]" />
                  <h3 class="font-display text-sm font-bold text-[var(--ink)]">熟练度影响</h3>
                </div>
                <div v-if="!mappedScoreDelta.length" class="text-sm text-[var(--ink-soft)]">暂无画像写入。</div>
                <div v-else class="space-y-2">
                  <div v-for="m in mappedScoreDelta" :key="m.kgNodeId" class="flex items-center gap-2 rounded-2xl bg-[var(--paper)] px-3 py-2">
                    <span class="min-w-0 flex-1 truncate text-xs font-bold text-[var(--ink)]">{{ m.title }}</span>
                    <span class="font-display text-xs font-bold" :class="(m.afterScore ?? 0) < (m.beforeScore ?? 0) ? 'text-[var(--error)]' : 'text-[#18a558]'">{{ Math.round(m.beforeScore ?? 0) }} → {{ Math.round(m.afterScore ?? 0) }}</span>
                  </div>
                </div>
              </div>

              <button @click="startPractice(selectedMistake)" class="btn-accent flex h-12 w-full items-center justify-center gap-2 rounded-[18px] font-display text-sm font-bold">
                <Sparkles class="h-4 w-4" />举一反三练习
              </button>
            </aside>
          </div>
        </div>
      </section>
    </main>
  </div>
</template>

<style scoped>
.mistake-root {
  background: transparent;
}
.panel-scroll {
  scrollbar-gutter: stable;
}
</style>
