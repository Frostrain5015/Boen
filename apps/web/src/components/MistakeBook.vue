<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
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

const mode = ref<IntakeMode>('image');
const textPrompt = ref('');
const studentAnswer = ref('');
const note = ref('');
const imageFile = ref<File | null>(null);
const imagePreview = ref('');
const dragging = ref(false);
const mistakes = ref<MistakeItem[]>([]);
const selectedMistake = ref<MistakeItem | null>(null);
const loadingList = ref(false);
const busy = ref(false);
const error = ref('');
const progress = ref(0);
const progressMessage = ref('');
const activeStep = ref<AnalyzeMistakeStep | null>(null);
const completedSteps = ref<Set<AnalyzeMistakeStep>>(new Set());
const selectedAssetObjectUrl = ref('');
const batchMistakes = ref<MistakeItem[]>([]);
const currentBatchIndex = ref(0);

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
    const data = await listMistakes({ grade: props.grade ?? undefined, limit: 30 });
    mistakes.value = data.mistakes;
    if (selectLatest && data.mistakes[0]) selectedMistake.value = data.mistakes[0];
    else if (selectedMistake.value) selectedMistake.value = data.mistakes.find((m) => m.id === selectedMistake.value?.id) ?? selectedMistake.value;
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
    // 更新列表
    const index = mistakes.value.findIndex((m) => m.id === event.mistake.id);
    if (index >= 0) mistakes.value[index] = event.mistake;
    else mistakes.value.unshift(event.mistake);
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

function setImage(file?: File | null) {
  if (!file) return;
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

async function submitMistake() {
  if (busy.value) return;
  error.value = '';
  batchMistakes.value = [];
  currentBatchIndex.value = 0;
  busy.value = true;
  try {
    let created: { mistake: MistakeItem };
    if (mode.value === 'text') {
      if (!textPrompt.value.trim()) throw new Error('请先输入题面');
      created = await createTextMistake({
        sourceType: 'text',
        subject: props.initialSubject,
        grade: props.grade,
        promptText: textPrompt.value,
        studentAnswer: studentAnswer.value,
        note: note.value,
      });
    } else {
      // 'image' is the default fallback
      if (!imageFile.value) throw new Error('请先上传错题图片');
      created = await createImageMistake({
        sourceType: 'image',
        subject: props.initialSubject,
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
    clearImage();
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

onMounted(async () => {
  await refreshMistakes(true);
});

watch(selectedMistake, async (mistake) => {
  revokeSelectedAssetUrl();
  const asset = mistake?.assets?.[0];
  if (!mistake || !asset) return;
  try {
    selectedAssetObjectUrl.value = await fetchMistakeAssetObjectUrl(mistake.id, asset.id);
  } catch {
    selectedAssetObjectUrl.value = '';
  }
}, { immediate: true });

onBeforeUnmount(() => {
  revokeSelectedAssetUrl();
  clearImage();
});
</script>

<template>
  <div class="mistake-root flex h-full min-h-0 flex-col" v-motion :initial="{ opacity: 0 }" :enter="{ opacity: 1, transition: { duration: 320 } }">
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
        <section class="clay p-4" v-motion :initial="{ opacity: 0, y: 14 }" :enter="{ opacity: 1, y: 0, transition: { delay: 80 } }">
          <div class="mb-3 flex items-center gap-2">
            <NotebookPen class="h-4 w-4 text-[var(--accent)]" />
            <h2 class="font-display text-sm font-bold text-[var(--ink)]">记录新错题</h2>
          </div>

          <div class="mb-3 grid grid-cols-2 gap-1 rounded-2xl bg-[var(--paper)] p-1">
            <button @click="mode = 'image'" class="flex h-10 items-center justify-center gap-1.5 rounded-xl text-xs font-bold transition-all" :class="mode === 'image' ? 'bg-[var(--surface)] text-[var(--accent-strong)] shadow-sm' : 'text-[var(--ink-soft)] hover:text-[var(--ink)]'"><ImagePlus class="h-3.5 w-3.5" />图片</button>
            <button @click="mode = 'text'" class="flex h-10 items-center justify-center gap-1.5 rounded-xl text-xs font-bold transition-all" :class="mode === 'text' ? 'bg-[var(--surface)] text-[var(--accent-strong)] shadow-sm' : 'text-[var(--ink-soft)] hover:text-[var(--ink)]'"><ScanText class="h-3.5 w-3.5" />文本</button>
          </div>

          <Transition name="panel" mode="out-in">
            <div v-if="mode === 'image'" key="image" class="space-y-3">
              <label
                class="group flex min-h-[150px] cursor-pointer flex-col items-center justify-center rounded-[22px] border-2 border-dashed p-4 text-center transition-all"
                :class="dragging ? 'border-[var(--accent)] bg-[var(--accent-soft)]' : 'border-[var(--line)] bg-white/60 hover:border-[var(--accent)] hover:bg-[var(--accent-soft)]/60'"
                @dragover.prevent="dragging = true"
                @dragleave.prevent="dragging = false"
                @drop.prevent="onDrop"
              >
                <img v-if="imagePreview" :src="imagePreview" alt="错题图片预览" class="max-h-36 rounded-2xl object-contain shadow-sm" />
                <template v-else>
                  <UploadCloud class="mb-2 h-9 w-9 text-[var(--accent)] transition-transform group-hover:-translate-y-1" />
                  <p class="text-sm font-bold text-[var(--ink)]">上传整页试卷或单题照片</p>
                  <p class="mt-1 text-xs text-[var(--ink-soft)]">支持 jpg / png / webp，自动切题识别</p>
                </template>
                <input type="file" accept="image/png,image/jpeg,image/webp" class="sr-only" @change="onFileChange" />
              </label>
              <button v-if="imagePreview" @click="clearImage" class="inline-flex h-9 items-center gap-1.5 rounded-xl bg-[var(--paper)] px-3 text-xs font-bold text-[var(--ink-soft)] transition-colors hover:bg-[var(--line)]"><X class="h-3.5 w-3.5" />移除图片</button>
            </div>

            <div v-else key="text" class="space-y-2">
              <label class="text-xs font-bold text-[var(--ink-soft)]" for="mistake-text">题面</label>
              <textarea id="mistake-text" v-model="textPrompt" rows="7" class="w-full resize-none rounded-[20px] border border-[var(--line)] bg-white/75 px-3 py-3 text-sm leading-relaxed text-[var(--ink)] outline-none transition-all focus:border-[var(--accent)] focus:bg-white focus:ring-4 focus:ring-[var(--accent-soft)]" placeholder="粘贴或输入题面、选项、原始作答..." />
            </div>
          </Transition>

          <div class="mt-3 space-y-2">
            <input v-model="studentAnswer" class="h-11 w-full rounded-2xl border border-[var(--line)] bg-white/75 px-3 text-sm outline-none transition-all focus:border-[var(--accent)] focus:ring-4 focus:ring-[var(--accent-soft)]" placeholder="学生答案/错解（可选）" />
            <input v-model="note" class="h-11 w-full rounded-2xl border border-[var(--line)] bg-white/75 px-3 text-sm outline-none transition-all focus:border-[var(--accent)] focus:ring-4 focus:ring-[var(--accent-soft)]" placeholder="来源备注，如单元测验第 8 题（可选）" />
          </div>

          <button @click="submitMistake" :disabled="busy" class="btn-accent mt-3 flex h-12 w-full items-center justify-center gap-2 rounded-[18px] font-display text-sm font-bold disabled:cursor-not-allowed">
            <Loader2 v-if="busy" class="h-4 w-4 animate-spin" />
            <Sparkles v-else class="h-4 w-4" />
            {{ busy ? '正在分析' : '识别并归档' }}
          </button>
          <p v-if="error" class="mt-3 flex items-start gap-2 rounded-2xl bg-[var(--error)]/10 px-3 py-2 text-xs font-semibold text-[var(--error)]"><AlertCircle class="mt-0.5 h-4 w-4 shrink-0" />{{ error }}</p>
        </section>

        <section class="clay min-h-[220px] overflow-hidden" v-motion :initial="{ opacity: 0, y: 14 }" :enter="{ opacity: 1, y: 0, transition: { delay: 140 } }">
          <div class="flex items-center gap-2 border-b border-[var(--line)] px-4 py-3">
            <FileImage class="h-4 w-4 text-[var(--accent)]" />
            <h2 class="font-display text-sm font-bold text-[var(--ink)]">最近错题</h2>
            <button @click="refreshMistakes(true)" class="ml-auto grid h-8 w-8 place-items-center rounded-full text-[var(--ink-soft)] transition-colors hover:bg-[var(--accent-soft)] hover:text-[var(--accent-strong)]" aria-label="刷新错题列表"><RefreshCw class="h-4 w-4" :class="{ 'animate-spin': loadingList }" /></button>
          </div>
          <div v-if="mistakes.length === 0" class="flex flex-col items-center gap-2 px-4 py-10 text-center">
            <Mascot :size="54" state="thinking" />
            <p class="text-xs font-semibold text-[var(--ink-soft)]">还没有错题记录</p>
          </div>
          <div v-else v-auto-animate class="space-y-1 p-2">
            <button v-for="m in mistakes" :key="m.id" @click="selectedMistake = m" class="group flex w-full items-center gap-2 rounded-2xl px-3 py-2.5 text-left transition-all hover:bg-[var(--accent-soft)] active:scale-[0.99]" :class="selectedMistake?.id === m.id ? 'bg-[var(--accent-soft)] text-[var(--accent-strong)]' : 'text-[var(--ink)]'">
              <span class="grid h-9 w-9 shrink-0 place-items-center rounded-2xl bg-white shadow-sm"><NotebookPen class="h-4 w-4 text-[var(--accent)]" /></span>
              <span class="min-w-0 flex-1">
                <span class="block truncate text-sm font-bold">{{ m.title || '未命名错题' }}</span>
                <span class="mt-0.5 flex items-center gap-1.5 text-[11px] text-[var(--ink-soft)]">
                  <span>{{ formatTime(m.updatedAt) }}</span>
                  <span class="rounded-full px-1.5 py-0.5" :class="m.status === 'analyzed' ? 'bg-[#e7f7ee] text-[#18a558]' : 'bg-[#fef3e2] text-[#f59e42]'">{{ m.status === 'analyzed' ? '已归档' : '待确认' }}</span>
                </span>
              </span>
              <button @click.stop="archive(m.id)" class="grid h-8 w-8 shrink-0 place-items-center rounded-xl text-[var(--ink-soft)] opacity-0 transition-all hover:bg-[var(--error)]/10 hover:text-[var(--error)] group-hover:opacity-100" aria-label="归档错题"><Trash2 class="h-4 w-4" /></button>
            </button>
          </div>
        </section>
      </aside>

      <section class="clay relative min-h-0 overflow-hidden" v-motion :initial="{ opacity: 0, y: 16 }" :enter="{ opacity: 1, y: 0, transition: { delay: 180 } }">
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

        <div v-if="!selectedMistake" class="flex h-full min-h-[520px] flex-col items-center justify-center gap-4 p-8 text-center">
          <Mascot :size="110" state="idle" />
          <div>
            <h2 class="font-display text-2xl font-bold text-[var(--ink)]">把真实错题放进来</h2>
            <p class="mt-2 max-w-md text-sm leading-relaxed text-[var(--ink-soft)]">整页试卷、作业拍照、文本录入都可以。系统会自动识别题面、定位章节和知识点，并把错题证据写入知识画像。</p>
          </div>
        </div>

        <div v-else class="panel-scroll h-full overflow-y-auto p-5">
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
                    <div class="rounded-2xl bg-white/75 p-4 text-sm leading-relaxed text-[var(--ink)] whitespace-pre-wrap">{{ selectedMistake.promptText || '暂无题面' }}</div>
                  </section>
                  <div class="grid gap-3 md:grid-cols-2">
                    <section class="rounded-2xl bg-white/75 p-4">
                      <p class="mb-1 text-xs font-bold text-[var(--ink-soft)]">学生答案</p>
                      <p class="text-sm leading-relaxed text-[var(--ink)] whitespace-pre-wrap">{{ selectedMistake.studentAnswer || '未识别到学生答案' }}</p>
                    </section>
                    <section class="rounded-2xl bg-white/75 p-4">
                      <p class="mb-1 text-xs font-bold text-[var(--ink-soft)]">正确答案</p>
                      <p class="text-sm leading-relaxed text-[var(--ink)] whitespace-pre-wrap">{{ selectedMistake.correctAnswer || '待补充' }}</p>
                    </section>
                  </div>
                  <section class="rounded-2xl bg-white/75 p-4">
                    <p class="mb-1 text-xs font-bold text-[var(--ink-soft)]">错因诊断</p>
                    <p class="text-sm font-bold text-[var(--error)]">{{ selectedMistake.errorType || '待确认' }}</p>
                    <p class="mt-2 text-sm leading-relaxed text-[var(--ink)] whitespace-pre-wrap">{{ selectedMistake.errorReason || '暂未生成错因' }}</p>
                  </section>
                  <section class="rounded-2xl bg-white/75 p-4">
                    <p class="mb-1 text-xs font-bold text-[var(--ink-soft)]">解法提示</p>
                    <p class="text-sm leading-relaxed text-[var(--ink)] whitespace-pre-wrap">{{ selectedMistake.explanation || '暂无解法' }}</p>
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
