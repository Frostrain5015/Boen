<script setup lang="ts">
import { computed } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import {
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Plus,
  Trash2,
  MessageSquare,
  FileText,
  NotebookPen,
  BrainCircuit,
  Lock,
} from 'lucide-vue-next';
import Mascot from '@/components/Mascot.vue';
import { useChatStore } from '@/stores/chat';
import { useExamStore, subjectMeta, examGradeLabel } from '@/stores/exam';
import { useUiStore } from '@/stores/ui';
import { useAuthStore } from '@/stores/auth';

const router = useRouter();
const route = useRoute();
const chatStore = useChatStore();
const examStore = useExamStore();
const uiStore = useUiStore();
const authStore = useAuthStore();

const currentView = computed(() => {
  const name = route.name as string;
  if (name === 'examReview') return 'examReview';
  if (name === 'exam') return 'exam';
  if (name === 'profile') return 'profile';
  if (name === 'mistakes') return 'mistakes';
  return 'chat';
});

function subjectLabel(val: string) {
  const found = [
    { value: 'chinese', label: '语文', emoji: '📖' },
    { value: 'math', label: '数学', emoji: '🔢' },
    { value: 'english', label: '英语', emoji: '🔤' },
    { value: 'science', label: '科学', emoji: '🔬' },
  ].find((s) => s.value === val);
  return found ?? { label: val, emoji: '📁' };
}

function formatDate(timestamp: number) {
  const date = new Date(timestamp * 1000);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  if (diff < 24 * 60 * 60 * 1000) {
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }
  return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
}

function selectSection(section: 'chat' | 'exam' | 'profile' | 'mistakes') {
  if (section === 'profile') {
    uiStore.expandedSection = null;
    router.push('/profile');
    return;
  }
  if (section === 'mistakes') {
    uiStore.expandedSection = null;
    router.push('/mistakes');
    return;
  }
  uiStore.expandedSection = section;
  if (section === 'chat') {
    router.push('/');
  } else {
    if (examStore.selectedExamId) {
      router.push(`/exam/${examStore.selectedExamId}/review`);
    } else {
      router.push('/exam');
    }
  }
}

async function selectConversation(id: string) {
  await chatStore.selectConversation(id);
  router.push('/');
}

function openExamReview(examId: string) {
  examStore.openExamReview(examId);
  router.push(`/exam/${examId}/review`);
}

function startNewExam() {
  examStore.startNewExam();
  router.push('/exam');
}
</script>

<template>
  <!-- 侧边�?-->
  <aside
    class="h-full shrink-0 overflow-hidden transition-[width] duration-300 ease-in-out"
    :class="uiStore.sidebarOpen ? 'w-64 rounded-r-[26px] shadow-[12px_0_34px_-20px_rgba(86,64,40,0.3)]' : 'w-0'"
  >
    <div class="flex h-full w-64 flex-col bg-[var(--surface)]/80 backdrop-blur-sm">
      <!-- 品牌 + 折叠 -->
      <div class="flex items-center justify-between overflow-hidden border-b border-[var(--line)] px-3 py-2.5 transition-all duration-400 ease-in-out" :class="currentView === 'chat' ? 'opacity-0 max-h-0 border-transparent py-0' : 'opacity-100 max-h-14'">
        <div class="flex items-center gap-2">
          <Mascot :size="28" :float="false" :animated="false" />
          <span class="brand-text text-lg font-bold tracking-tight">博文 Boen</span>
          <span class="text-[10px] font-medium text-(--ink-soft)/60 ml-0.5 mt-0.5">v0.2.1</span>
        </div>
        <button @click="uiStore.sidebarOpen = false" class="flex h-7 w-7 items-center justify-center rounded-full transition-colors hover:bg-[var(--line)]/50" title="收起侧栏">
          <ChevronLeft class="h-4 w-4 text-[var(--ink-soft)]" />
        </button>
      </div>

      <div class="flex-1 overflow-y-auto px-2 py-2">
        <!-- ══�?对话 ══�?-->
        <button
          @click="selectSection('chat')"
          class="flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left font-display text-sm font-bold transition-all"
          :class="currentView === 'chat' ? 'bg-[var(--accent-soft)] text-[var(--accent-strong)]' : 'text-[var(--ink)] hover:bg-[var(--line)]/50'"
        >
          <MessageSquare class="h-4 w-4 shrink-0" />
          <span class="flex-1">对话</span>
          <ChevronDown class="h-4 w-4 shrink-0 transition-transform" :class="uiStore.expandedSection === 'chat' ? '' : '-rotate-90'" />
        </button>
        <!-- 对话二级菜单 -->
        <div v-if="uiStore.expandedSection === 'chat'" class="mb-1 mt-1 space-y-0.5 pl-2">
          <button @click="chatStore.handleNewConversation()" class="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs font-semibold text-[var(--accent-strong)] transition-colors hover:bg-[var(--accent-soft)]">
            <Plus class="h-3.5 w-3.5" /> 新建对话
          </button>
          <div v-if="chatStore.conversations.length === 0" class="px-3 py-3 text-center text-xs text-[var(--ink-soft)]">还没有对�?/div>
          <button
            v-for="conv in chatStore.conversations" :key="conv.id"
            @click="selectConversation(conv.id)"
            class="group flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-all"
            :class="currentView === 'chat' && chatStore.currentConversationId === conv.id ? 'bg-[var(--accent-soft)] text-[var(--accent-strong)]' : 'text-[var(--ink)] hover:bg-[var(--line)]/50'"
          >
            <MessageSquare class="h-3.5 w-3.5 shrink-0 opacity-60" />
            <div class="min-w-0 flex-1">
              <p class="truncate font-medium">{{ conv.title }}</p>
              <div class="flex items-center gap-1.5">
                <span class="subject-tag">{{ subjectLabel(conv.subject).emoji }}{{ subjectLabel(conv.subject).label }}</span>
                <span class="text-xs text-[var(--ink-soft)]">{{ formatDate(conv.updatedAt) }}</span>
              </div>
            </div>
            <button @click="(e) => chatStore.handleDeleteConversation(conv.id, e)" class="opacity-0 rounded-md p-1 text-[var(--ink-soft)] transition-opacity hover:bg-[var(--error)]/10 hover:text-[var(--error)] group-hover:opacity-100" title="删除对话">
              <Trash2 class="h-3.5 w-3.5" />
            </button>
          </button>
        </div>

        <!-- ══�?考试 ══�?-->
        <button
          @click="selectSection('exam')"
          class="mt-1 flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left font-display text-sm font-bold transition-all"
          :class="currentView === 'exam' || currentView === 'examReview' ? 'bg-[#e8e4ff] text-[#5848d6]' : 'text-[var(--ink)] hover:bg-[var(--line)]/50'"
        >
          <FileText class="h-4 w-4 shrink-0" />
          <span class="flex-1">考试</span>
          <Lock v-if="!authStore.isPremium" class="h-3 w-3 shrink-0" style="color: var(--locked-ink)" />
          <ChevronDown class="h-4 w-4 shrink-0 transition-transform" :class="uiStore.expandedSection === 'exam' ? '' : '-rotate-90'" />
        </button>
        <!-- 考试二级菜单 -->
        <div v-if="uiStore.expandedSection === 'exam'" class="mb-1 mt-1 space-y-0.5 pl-2">
          <button @click="startNewExam" class="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs font-semibold text-[#5848d6] transition-colors hover:bg-[#e8e4ff]">
            <Plus class="h-3.5 w-3.5" /> 新考试
          </button>
          <div v-if="examStore.exams.length === 0" class="px-3 py-3 text-center text-xs text-[var(--ink-soft)]">还没有考试记录</div>
          <button
            v-for="ex in examStore.exams" :key="ex.examId"
            @click="ex.status === 'completed' ? openExamReview(ex.examId) : startNewExam()"
            class="group flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-all"
            :class="currentView === 'examReview' && examStore.selectedExamId === ex.examId ? 'bg-[#e8e4ff] text-[#5848d6]' : 'text-[var(--ink)] hover:bg-[var(--line)]/50'"
          >
            <span class="shrink-0 text-base">{{ subjectMeta(ex.subject).emoji }}</span>
            <div class="min-w-0 flex-1">
              <p class="truncate font-medium">{{ ex.title }}</p>
              <div class="flex items-center gap-1.5 text-xs text-[var(--ink-soft)]">
                <span>{{ subjectMeta(ex.subject).label }}·{{ examGradeLabel(ex.grade) }}</span>
                <span>{{ formatDate(ex.submittedAt ?? ex.createdAt) }}</span>
              </div>
            </div>
            <span v-if="ex.result" class="shrink-0 font-display text-sm font-bold text-[#5848d6] group-hover:hidden">{{ ex.result.percentage }}</span>
            <span v-else class="shrink-0 text-[10px] font-semibold text-[#f59e42] group-hover:hidden">未完�?/span>
            <button @click="(e) => examStore.handleDeleteExam(ex.examId, e)" class="hidden shrink-0 rounded-md p-1 text-[var(--ink-soft)] transition-colors hover:bg-[var(--error)]/10 hover:text-[var(--error)] group-hover:block" title="删除考试">
              <Trash2 class="h-3.5 w-3.5" />
            </button>
          </button>
        </div>

        <!-- ══�?错题�?══�?-->
        <button
          @click="selectSection('mistakes')"
          class="mt-1 flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left font-display text-sm font-bold transition-all"
          :class="currentView === 'mistakes' ? 'bg-[#fff1d8] text-[#c76b17]' : 'text-[var(--ink)] hover:bg-[var(--line)]/50'"
        >
          <NotebookPen class="h-4 w-4 shrink-0" />
          <span class="flex-1">错题�?/span>
          <Lock v-if="!authStore.isPremium" class="h-3 w-3 shrink-0" style="color: var(--locked-ink)" />
        </button>

        <!-- ══�?档案 ══�?-->
        <button
          @click="selectSection('profile')"
          class="mt-1 flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left font-display text-sm font-bold transition-all"
          :class="currentView === 'profile' ? 'bg-[#d9f4ec] text-[#0e9b76]' : 'text-[var(--ink)] hover:bg-[var(--line)]/50'"
        >
          <BrainCircuit class="h-4 w-4 shrink-0" />
          <span class="flex-1">档案</span>
          <Lock v-if="!authStore.isPremium" class="h-3 w-3 shrink-0" style="color: var(--locked-ink)" />
        </button>
      </div>

      <!-- ICP 备案 -->
      <div class="shrink-0 border-t border-[var(--line)] px-3 py-2 text-center">
        <a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener noreferrer" class="text-[10px] text-(--ink-soft)/50 hover:text-(--ink-soft)/80 transition-colors">
          浙ICP�?026040257�?1
        </a>
      </div>
    </div>
  </aside>

  <!-- 折叠态下的展开把手 -->
  <button
    v-if="!uiStore.sidebarOpen"
    @click="uiStore.sidebarOpen = true"
    class="absolute bottom-3 left-2 z-30 flex h-9 w-9 items-center justify-center rounded-full bg-[var(--surface)] shadow-[0_6px_16px_-8px_rgba(86,64,40,0.4)] transition-colors hover:bg-[var(--accent-soft)]"
    title="展开侧栏"
  >
    <ChevronRight class="h-5 w-5 text-[var(--ink-soft)]" />
  </button>
</template>
