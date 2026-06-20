<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue';
import Mascot from '@/components/Mascot.vue';
import StarDisplay from '@/components/StarDisplay.vue';
import { ChevronDown, ChevronRight, GraduationCap, BrainCircuit, AlertTriangle, Target, Sparkles, BookOpen, BarChart3, ArrowRight, FileText } from 'lucide-vue-next';
import { renderMarkdown } from '@/lib/markdown';
import { getToken } from '@/services/auth';

interface KpNode {
  title: string;
  weightedScore: number;
  level?: string;
  correctCount: number;
  totalCount: number;
  literacies: string[];
  prerequisites: string[];
}

interface SectionNode {
  title: string;
  weightedScore: number;
  level?: string;
  knowledgePoints: KpNode[];
}

interface ChapterNode {
  title: string;
  weightedScore: number;
  level?: string;
  children: SectionNode[];
}

interface TextbookNode {
  volume: string;
  weightedScore: number;
  level?: string;
  chapters: ChapterNode[];
}

interface OutlineData {
  subject: string;
  grade: string;
  overall: { weightedScore: number; weakCount: number; goodCount: number; masteredCount: number; totalKps: number };
  textbooks: TextbookNode[];
}

const subject = ref<'chinese' | 'math' | 'english' | 'science'>('math');
const grade = ref<string>('7');
const outline = ref<OutlineData | null>(null);
const loading = ref(true);
const expandedSections = ref<Set<string>>(new Set());
const selectedKp = ref<KpNode & { sectionTitle: string } | null>(null);
const animatingNumbers = ref(false);
const report = ref<string | null>(null);
const reportLoading = ref(false);

function authHeaders(): Record<string, string> {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function generateReport() {
  reportLoading.value = true;
  report.value = null;
  try {
    const res = await fetch(`/api/profile/report?subject=${subject.value}&grade=${grade.value}`, { headers: authHeaders() });
    const data = await res.json();
    report.value = data.report || '生成失败';
  } catch { report.value = '报告生成失败，请稍后再试。'; }
  reportLoading.value = false;
}

const emit = defineEmits<{
  (e: 'back'): void;
  (e: 'practice', detail: { kp?: string; subject: 'chinese' | 'math' | 'english' | 'science'; grade: string; mode?: string }): void;
  (e: 'exam', detail: { subject: 'chinese' | 'math' | 'english' | 'science'; grade: string; durationMinutes: number; notes: string }): void;
}>();

const SUBJECTS = [
  { value: 'chinese' as const, label: '语文', emoji: '📖' },
  { value: 'math' as const, label: '数学', emoji: '🔢' },
  { value: 'english' as const, label: '英语', emoji: '🔤' },
  { value: 'science' as const, label: '科学', emoji: '🔬' },
];

const GRADES = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];

const subjectIndex = computed(() => SUBJECTS.findIndex((s) => s.value === subject.value));

function gradeLabel(g: string): string {
  const n = Number(g);
  return n <= 6 ? `小${'一二三四五六'[n - 1]}` : `初${['一', '二', '三'][n - 7]}`;
}

function toggleSection(key: string) {
  const s = new Set(expandedSections.value);
  if (s.has(key)) s.delete(key); else s.add(key);
  expandedSections.value = s;
}

/** 非线性星映射（与 StarDisplay.vue 保持一致） */
function starVal(ws: number): number {
  if (ws < 0) return 0;
  return Math.round(5 * Math.pow(ws / 100, 0.7) * 2) / 2;
}

function masteryColor(ws: number): string {
  if (ws < 0) return 'var(--line)';
  if (ws < 40) return '#f2557a';
  if (ws < 60) return '#f59e42';
  if (ws < 80) return '#e0a92e';
  return '#d4a053';
}

function masteryBg(ws: number): string {
  if (ws < 0) return '#f0ebe3';
  if (ws < 40) return '#fdeaef';
  if (ws < 60) return '#fef3e2';
  if (ws < 80) return '#fef7e6';
  return '#fdf3e0';
}

async function fetchOutline() {
  loading.value = true;
  selectedKp.value = null;
  try {
    const res = await fetch(`/api/profile/outline?subject=${subject.value}&grade=${grade.value}`, { headers: authHeaders() });
    const data = await res.json();
    outline.value = data;
    setTimeout(() => { animatingNumbers.value = true; }, 100);
  } catch (e) { console.warn('[profile] load outline failed:', e); }
  loading.value = false;
}

function openKpDetail(kp: KpNode, sectionTitle: string) {
  selectedKp.value = { ...kp, sectionTitle };
}

function closeKpDetail() {
  selectedKp.value = null;
}

/** 推荐练习：仅真正练过的薄弱知识点（排除从未接触的），按掌握度升序，最多 6 个 */
const recommendations = computed(() => {
  if (!outline.value) return [];
  return outline.value.textbooks
    .flatMap((t) => t.chapters)
    .flatMap((c) => c.children)
    .flatMap((s) => s.knowledgePoints)
    .filter((k) => k.weightedScore >= 0 && k.weightedScore < 60)
    .sort((a, b) => a.weightedScore - b.weightedScore)
    .slice(0, 6);
});

function startPractice(kpTitle?: string) {
  // 交由 App：切到对话视图，针对该知识点开始练习
  emit('practice', { kp: kpTitle, subject: subject.value, grade: grade.value });
}

onMounted(fetchOutline);
watch(subject, fetchOutline);
watch(grade, fetchOutline);
</script>

<template>
  <div class="profile-root">
    <!-- Loading -->
    <div v-if="loading" class="flex h-full items-center justify-center">
      <div class="flex flex-col items-center gap-3">
        <Mascot :size="80" state="thinking" />
        <p class="text-sm font-medium text-[var(--ink-soft)]">加载学习画像…</p>
      </div>
    </div>

    <!-- Empty -->
    <div v-else-if="!outline" class="flex h-full items-center justify-center">
      <div class="flex flex-col items-center gap-3 text-center">
        <Mascot :size="80" state="idle" />
        <p class="text-sm text-[var(--ink-soft)]">暂无课程数据</p>
      </div>
    </div>

    <!-- Main layout -->
    <div v-else class="flex h-full gap-4 p-4">
      <!-- ═══ Left panel: Stats + Recommendations ═══ -->
      <div class="panel-scroll flex w-[340px] shrink-0 flex-col gap-4 overflow-y-auto">
        <!-- Subject selector + back button -->
        <div class="clay clay-glass overflow-hidden">
          <div class="flex items-center gap-2 p-3">
            <button
              @click="$emit('back')"
              class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--accent-soft)] text-[var(--accent-strong)] transition-all hover:bg-[var(--accent)] hover:text-white active:scale-90"
              title="返回对话"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5"/><polyline points="12 19 5 12 12 5"/></svg>
            </button>
            <div class="clay-sm relative flex bg-[var(--surface)] p-1">
              <span
                class="absolute top-1 bottom-1 left-1 w-16 rounded-[14px] bg-accent"
                :style="{
                  transform: `translateX(calc(${subjectIndex} * 4rem))`,
                  transition: 'transform 0.4s cubic-bezier(0.34, 1.56, 0.64, 1)',
                }"
              ></span>
              <button
                v-for="s in SUBJECTS" :key="s.value"
                @click="subject = s.value"
                class="relative z-10 flex w-16 items-center justify-center gap-1 rounded-[14px] py-1.5 font-display text-sm font-semibold transition-colors"
                :class="subject === s.value ? 'text-white' : 'text-[var(--ink-soft)] hover:text-[var(--ink)]'"
              ><span>{{ s.emoji }}</span>{{ s.label }}</button>
            </div>
          </div>
        </div>

        <!-- Overall big stars -->
        <div class="clay clay-glass p-5 text-center" v-motion :initial="{ opacity: 0, y: 20 }" :enter="{ opacity: 1, y: 0, transition: { delay: 100 } }">
          <p class="mb-3 font-display text-xs font-semibold text-[var(--ink-soft)]">综合熟练度</p>
          <div class="flex justify-center">
            <span class="inline-flex gap-1">
              <svg v-for="i in 5" :key="i" class="h-10 w-10" viewBox="0 0 24 24">
                <defs>
                  <clipPath :id="'ovr-star-' + i">
                    <rect x="0" y="0" :width="24 * Math.max(0, Math.min(1, starVal(outline.overall.weightedScore) - (i - 1)))" height="24" />
                  </clipPath>
                </defs>
                <path d="M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z" fill="#e0dcd3" stroke="#e0dcd3" stroke-width="0.5" />
                <path :clip-path="'url(#ovr-star-' + i + ')'" d="M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z" fill="#d4a053" stroke="#d4a053" stroke-width="0.5" />
              </svg>
            </span>
          </div>
          <div class="mt-3 grid grid-cols-3 gap-2">
            <div class="rounded-xl bg-[#fdeaef] p-2">
              <p class="text-lg font-bold text-[#f2557a]">{{ outline.overall.weakCount }}</p>
              <p class="text-[10px] font-medium text-[var(--ink-soft)]">待加强</p>
            </div>
            <div class="rounded-xl bg-[#fef7e6] p-2">
              <p class="text-lg font-bold text-[#e0a92e]">{{ outline.overall.goodCount }}</p>
              <p class="text-[10px] font-medium text-[var(--ink-soft)]">良好</p>
            </div>
            <div class="rounded-xl bg-[#fdf3e0] p-2">
              <p class="text-lg font-bold text-[#d4a053]">{{ outline.overall.masteredCount }}</p>
              <p class="text-[10px] font-medium text-[var(--ink-soft)]">优秀</p>
            </div>
          </div>
        </div>

        <!-- 诊断报告 -->
        <button @click="generateReport" class="clay clay-glass flex w-full items-center gap-3 p-3 text-left transition-all hover:opacity-80 active:scale-[0.98]" v-motion :initial="{ opacity: 0, y: 20 }" :enter="{ opacity: 1, y: 0, transition: { delay: 180 } }">
          <div class="flex h-9 w-9 items-center justify-center rounded-xl bg-[var(--accent-soft)]">
            <FileText class="h-4 w-4 text-[var(--accent-strong)]" />
          </div>
          <div class="flex-1">
            <p class="text-xs font-bold text-[var(--ink)]">生成学习诊断报告</p>
            <p class="text-[10px] text-[var(--ink-soft)]">AI 智能分析薄弱点与学习建议</p>
          </div>
          <BarChart3 class="h-4 w-4 text-[var(--ink-soft)]" />
        </button>

        <!-- Recommendations -->
        <div class="clay clay-glass overflow-hidden" v-motion :initial="{ opacity: 0, y: 20 }" :enter="{ opacity: 1, y: 0, transition: { delay: 200 } }">
          <div class="flex items-center gap-2 border-b border-[var(--line)] px-4 py-2.5">
            <Target class="h-4 w-4 text-[var(--accent)]" />
            <span class="font-display text-xs font-bold text-[var(--ink)]">推荐练习</span>
            <span v-if="recommendations.length" class="ml-auto rounded-full bg-[var(--accent-soft)] px-2 py-0.5 text-[10px] font-bold text-[var(--accent-strong)]">{{ recommendations.length }}</span>
          </div>

          <!-- 无薄弱点 -->
          <div v-if="recommendations.length === 0" class="flex flex-col items-center gap-2 px-4 py-7 text-center">
            <Sparkles class="h-8 w-8 text-[var(--accent)] opacity-50" />
            <p class="text-xs text-[var(--ink-soft)]">暂无薄弱知识点，继续加油！✨</p>
          </div>

          <!-- 薄弱点竖向列表，整行点击即开始针对练习 -->
          <div v-else class="p-2">
            <button
              v-for="(kp, i) in recommendations" :key="kp.title"
              @click="startPractice(kp.title)"
              class="group flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition-all hover:bg-[var(--accent-soft)] active:scale-[0.99]"
              v-motion :initial="{ opacity: 0, x: -8 }" :enter="{ opacity: 1, x: 0, transition: { delay: 250 + i * 40 } }"
            >
              <span class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold" :style="{ background: masteryBg(kp.weightedScore), color: masteryColor(kp.weightedScore) }">{{ i + 1 }}</span>
              <div class="min-w-0 flex-1">
                <p class="truncate text-xs font-bold text-[var(--ink)]">{{ kp.title }}</p>
                <span v-if="kp.weightedScore >= 0" class="mt-0.5 inline-block"><StarDisplay :score="kp.weightedScore" /></span>
                <span v-else class="mt-0.5 inline-block"><StarDisplay :score="-1" /></span>
              </div>
              <span class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--accent)] text-white opacity-0 transition-opacity group-hover:opacity-100" title="开始练习">
                <BookOpen class="h-3.5 w-3.5" />
              </span>
            </button>
          </div>
        </div>
      </div>

      <!-- ═══ Right panel: Outline Tree ═══ -->
      <div class="panel-scroll clay flex-1 overflow-y-auto" v-motion :initial="{ opacity: 0, y: 20 }" :enter="{ opacity: 1, y: 0, transition: { delay: 150 } }">
        <div class="border-b border-[var(--line)] px-5 py-3">
          <h2 class="font-display text-sm font-bold text-[var(--ink)]">课程大纲 · {{ SUBJECTS.find(s => s.value === subject)?.label }} {{ gradeLabel(grade) }}</h2>
        </div>
        <div class="p-3">
          <template v-for="tb in outline.textbooks" :key="tb.volume">
            <div class="mb-3 mt-2 flex items-center gap-3 rounded-xl bg-[var(--surface)] px-3 py-2">
              <div class="flex-1">
                <div class="flex items-center justify-between">
                  <span class="font-display text-xs font-bold text-[var(--ink)]">{{ tb.volume }}</span>
                  <div class="flex items-center gap-2">
                    <StarDisplay :score="tb.weightedScore" />
                    <span @click.stop="emit('exam', { subject, grade, durationMinutes: 45, notes: tb.volume + ' 综合测试' })" class="flex cursor-pointer items-center gap-1 rounded-lg border border-[var(--line)] px-2.5 py-1 text-[11px] font-semibold text-[var(--ink)] transition-colors hover:border-[var(--accent)] hover:bg-[var(--accent-soft)] hover:text-[var(--accent-strong)] active:scale-[0.96]">📝 册测试</span>
                  </div>
                </div>
              </div>
            </div>
            <div v-for="ch in tb.chapters" :key="ch.title" class="mb-1 overflow-hidden rounded-2xl border border-[var(--line)]">
              <!-- Chapter header -->
              <button @click="toggleSection('ch-' + ch.title)" class="flex w-full items-center gap-2 bg-white px-4 py-2.5 text-left transition-colors hover:bg-[var(--accent-soft)]/30">
                <component :is="expandedSections.has('ch-' + ch.title) ? ChevronDown : ChevronRight" class="h-4 w-4 shrink-0 text-[var(--ink-soft)]" />
                <span class="flex-1 font-display text-sm font-bold text-[var(--ink)]">{{ ch.title }}</span>
                <span v-if="ch.weightedScore >= 0"><StarDisplay :score="ch.weightedScore" /></span>
                <span v-else><StarDisplay :score="-1" /></span>
                <span @click.stop="emit('exam', { subject, grade, durationMinutes: 15, notes: ch.title + ' 章节测试' })" class="flex h-6 w-6 cursor-pointer items-center justify-center rounded-full text-[11px] text-[var(--ink-soft)] transition-colors hover:bg-[var(--accent-soft)] hover:text-[var(--accent-strong)]" title="章节小测">📝</span>
              </button>

              <!-- Sections -->
              <Transition name="tree-collapse">
                <div v-if="expandedSections.has('ch-' + ch.title)" class="border-t border-[var(--line)] bg-[var(--surface)]">
                  <div v-for="sec in ch.children" :key="sec.title" class="border-b border-[var(--line)] last:border-b-0">
                    <button @click="toggleSection('sec-' + sec.title)" class="flex w-full items-center gap-2 px-6 py-2 text-left transition-colors hover:bg-white/50">
                      <component :is="expandedSections.has('sec-' + sec.title) ? ChevronDown : ChevronRight" class="h-3 w-3 shrink-0 text-[var(--ink-soft)]" />
                      <span class="flex-1 text-xs font-medium text-[var(--ink)]">{{ sec.title }}</span>
                      <span v-if="sec.weightedScore >= 0"><StarDisplay :score="sec.weightedScore" /></span>
                      <span v-else><StarDisplay :score="-1" /></span>
                    </button>

                    <!-- Knowledge points -->
                    <Transition name="tree-collapse">
                      <div v-if="expandedSections.has('sec-' + sec.title)" class="space-y-0.5 px-8 pb-2">
                        <div v-for="kp in sec.knowledgePoints" :key="kp.title"
                          @click="openKpDetail(kp, sec.title)"
                          class="flex cursor-pointer items-center gap-2 rounded-xl px-2.5 py-1.5 transition-all hover:bg-[var(--accent-soft)] active:scale-[0.98]"
                        >
                          <GraduationCap class="h-3 w-3 shrink-0 text-[var(--accent)]" />
                          <span class="flex-1 text-[11px] font-medium text-[var(--ink)]">{{ kp.title }}</span>
                          <div class="flex gap-1">
                            <span v-for="lit in kp.literacies.slice(0, 2)" :key="lit"
                              class="inline-flex items-center gap-0.5 rounded-full bg-[#f0e7fa] px-1.5 py-0.5 text-[9px] font-semibold text-[#7c3aae]"
                            ><BrainCircuit class="h-2 w-2" />{{ lit }}</span>
                          </div>
                          <span v-if="kp.weightedScore >= 0"><StarDisplay :score="kp.weightedScore" /></span>
                          <span v-else><StarDisplay :score="-1" /></span>
                        </div>
                      </div>
                    </Transition>
                  </div>
                </div>
              </Transition>
            </div>
          </template>
        </div>
      </div>
    </div>

    <!-- ═══ 诊断报告 Modal ═══ -->
    <Transition name="panel-scale">
      <div v-if="report !== null || reportLoading" class="fixed inset-0 z-50 flex items-center justify-center bg-black/20 backdrop-blur-sm" @click.self="reportLoading ? null : report = null">
        <div class="clay clay-glass mx-4 w-full max-w-lg max-h-[80vh] overflow-y-auto" v-motion :initial="{ opacity: 0, scale: 0.9, y: 20 }" :enter="{ opacity: 1, scale: 1, y: 0, transition: { type: 'spring', stiffness: 300, damping: 25 } }">
          <div class="flex items-center justify-between border-b border-[var(--line)] px-5 py-3">
            <div class="flex items-center gap-2">
              <FileText class="h-4 w-4 text-[var(--accent)]" />
              <span class="font-display text-sm font-bold text-[var(--ink)]">学习诊断报告</span>
            </div>
            <button @click="report = null" class="flex h-7 w-7 items-center justify-center rounded-full transition-colors hover:bg-[var(--line)]/50">&times;</button>
          </div>
          <div class="px-5 py-4">
            <div v-if="reportLoading" class="flex flex-col items-center gap-3 py-8">
              <Mascot :size="60" state="thinking" />
              <p class="text-sm text-[var(--ink-soft)]">正在分析学习数据…</p>
            </div>
            <div v-else class="md-body text-sm leading-relaxed text-[var(--ink)]" v-html="renderMarkdown(report ?? '')"></div>
          </div>
        </div>
      </div>
    </Transition>

    <!-- ═══ KP Detail Floating Panel ═══ -->
    <Transition name="panel-scale">
      <div v-if="selectedKp" class="fixed inset-0 z-50 flex items-center justify-center bg-black/20 backdrop-blur-sm" @click.self="closeKpDetail">
        <div class="clay clay-glass mx-4 w-full max-w-md overflow-hidden" v-motion :initial="{ opacity: 0, scale: 0.9, y: 20 }" :enter="{ opacity: 1, scale: 1, y: 0, transition: { type: 'spring', stiffness: 300, damping: 25 } }">
          <div class="flex items-center justify-between border-b border-[var(--line)] px-5 py-3">
            <div class="flex items-center gap-2">
              <GraduationCap class="h-4 w-4 text-[var(--accent)]" />
              <span class="font-display text-sm font-bold text-[var(--ink)]">{{ selectedKp.title }}</span>
            </div>
            <button @click="closeKpDetail" class="flex h-7 w-7 items-center justify-center rounded-full transition-colors hover:bg-[var(--line)]/50">&times;</button>
          </div>
          <div class="space-y-3 px-5 py-4">
            <div class="flex items-center gap-2">
              <span class="text-xs font-medium text-[var(--ink-soft)]">熟练度</span>
              <StarDisplay v-if="selectedKp.weightedScore >= 0" :score="selectedKp.weightedScore" />
              <StarDisplay v-else :score="-1" />
            </div>

            <div v-if="selectedKp.literacies.length" class="space-y-1">
              <p class="text-xs font-semibold text-[var(--ink-soft)]">关联的核心素养</p>
              <div class="flex flex-wrap gap-1.5">
                <span v-for="lit in selectedKp.literacies" :key="lit"
                  class="inline-flex items-center gap-1 rounded-full bg-[#f0e7fa] px-2.5 py-1 text-[11px] font-semibold text-[#7c3aae]"
                ><BrainCircuit class="h-3 w-3" />{{ lit }}</span>
              </div>
            </div>

            <div v-if="selectedKp.prerequisites.length" class="space-y-1">
              <p class="text-xs font-semibold text-[var(--ink-soft)]">前置知识</p>
              <div class="flex flex-wrap gap-1.5">
                <span v-for="pre in selectedKp.prerequisites" :key="pre"
                  class="rounded-full bg-[var(--accent-soft)] px-2.5 py-1 text-[11px] font-medium text-[var(--accent-strong)]"
                >{{ pre }}</span>
              </div>
            </div>

            <div class="rounded-xl bg-[var(--accent-soft)] p-3">
              <p class="text-[11px] font-medium text-[var(--ink-soft)]">所属章节</p>
              <p class="text-xs font-semibold text-[var(--ink)]">{{ selectedKp.sectionTitle }}</p>
            </div>

            <div class="flex gap-2">
              <button @click="emit('practice', { kp: selectedKp.title, subject, grade, mode: 'review' }); closeKpDetail()"
                class="flex flex-1 items-center justify-center gap-2 rounded-2xl border-2 border-[var(--accent)] bg-white py-2.5 font-display text-sm font-bold text-[var(--accent)] transition-all hover:bg-[var(--accent-soft)] active:scale-[0.97]"
              ><BookOpen class="h-4 w-4" /> 先去复习</button>
              <button @click="emit('practice', { kp: selectedKp.title, subject, grade, mode: 'weakness' }); closeKpDetail()"
                class="flex flex-1 items-center justify-center gap-2 rounded-2xl bg-[var(--accent)] py-2.5 font-display text-sm font-bold text-white transition-all hover:opacity-90 active:scale-[0.97]"
              ><Target class="h-4 w-4" /> 直接练习</button>
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.profile-root {
  height: 100%;
  background: transparent;
}

/* Tree collapse transition */
.tree-collapse-enter-active {
  transition: all 0.3s cubic-bezier(0.22, 1, 0.36, 1);
  overflow: hidden;
}
.tree-collapse-leave-active {
  transition: all 0.2s ease;
  overflow: hidden;
}
.tree-collapse-enter-from { opacity: 0; max-height: 0; }
.tree-collapse-leave-to { opacity: 0; max-height: 0; }

/* Panel scale transition */
.panel-scale-enter-active { transition: opacity 0.25s ease; }
.panel-scale-leave-active { transition: opacity 0.2s ease; }
.panel-scale-enter-from, .panel-scale-leave-to { opacity: 0; }

/* Pulse animation for weak nodes */
@keyframes pulseGlow {
  0%, 100% { box-shadow: 0 0 0 0 rgba(242, 85, 122, 0.3); }
  50% { box-shadow: 0 0 0 6px transparent; }
}

/* 固定滚动条宽度防止容器抖动 */
.panel-scroll { scrollbar-gutter: stable; }

/* Scrollbar styling for tree */
.clay.flex-1::-webkit-scrollbar { width: 6px; }
.clay.flex-1::-webkit-scrollbar-thumb { background: var(--line); border-radius: 99px; }
.panel-scroll { scrollbar-gutter: stable; overflow-y: scroll; }

/* Scrollbar for recommendations */
.flex.gap-3.overflow-x-auto::-webkit-scrollbar { height: 3px; }
.flex.gap-3.overflow-x-auto::-webkit-scrollbar-thumb { background: var(--line); border-radius: 99px; }
</style>
