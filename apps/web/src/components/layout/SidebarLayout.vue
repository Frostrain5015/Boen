<script setup lang="ts">
import { computed, watch } from 'vue';
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
  Settings,
  User,
  Crown,
  LogOut,
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

type SidebarView = 'chat' | 'exam' | 'examReview' | 'profile' | 'mistakes' | 'setup';

const currentView = computed<SidebarView>(() => {
  const name = route.name as string;
  if (name === 'examReview') return 'examReview';
  if (name === 'exam') return 'exam';
  if (name === 'profile') return 'profile';
  if (name === 'mistakes') return 'mistakes';
  if (name === 'setup') return 'setup';
  return 'chat';
});

const userGradeLabel = computed(() => {
  const g = authStore.userProfile?.grade;
  if (!g) return '';
  const n = Number(g);
  if (n >= 1 && n <= 6) return `${'一二三四五六'[n - 1]}年级`;
  if (n >= 7 && n <= 9) return `初${'一二三'[n - 7]}`;
  if (g === 'high') return '高中';
  if (g === 'college') return '大学';
  return g;
});

const userModelLabel = computed(() => {
  const p = localStorage.getItem('boen_model_provider') || 'default';
  if (p === 'deepseek') return 'Flash';
  if (p === 'deepseek-pro') return 'Pro';
  return 'Kimi';
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
    router.push('/exam');
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

// Keep the expanded navigation branch aligned with direct links, browser history,
// and programmatic navigation instead of leaving a stale chat accordion open.
watch(() => route.name, (name) => {
  uiStore.expandedSection = name === 'chat'
    ? 'chat'
    : name === 'exam' || name === 'examReview'
      ? 'exam'
      : null;
}, { immediate: true });

// Auto-close sidebar on mobile when route changes
watch(() => route.path, () => {
  if (uiStore.isMobile) uiStore.sidebarOpen = false;
});

// ── 二级菜单展开/收起过渡 ───────────────────────────────
// v-if 直接挂载/卸载会让菜单瞬间跳出/消失，导致切换模块时视觉跳变。
// 用 JS 钩子在 enter/leave 间把 height 从 0 平滑过渡到内容真实高度（再回落到 auto），
// 既保留 height:auto 的自适应，又获得顺滑动画。
const reduceMotion = typeof window !== 'undefined'
  && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

function onSubmenuEnter(el: Element) {
  const e = el as HTMLElement;
  if (reduceMotion) return;
  e.style.height = '0';
  e.style.opacity = '0';
  // 触发重排后再设目标高度，确保过渡生效
  void e.offsetHeight;
  e.style.height = `${e.scrollHeight}px`;
  e.style.opacity = '1';
}
function onSubmenuAfterEnter(el: Element) {
  (el as HTMLElement).style.height = 'auto';
}
function onSubmenuLeave(el: Element) {
  const e = el as HTMLElement;
  if (reduceMotion) return;
  e.style.height = `${e.scrollHeight}px`;
  e.style.opacity = '1';
  void e.offsetHeight;
  e.style.height = '0';
  e.style.opacity = '0';
}
</script>

<template>
  <!-- 侧边栏 -->
  <aside
    class="fixed inset-y-0 left-0 z-40 h-full overflow-hidden transition-[width] duration-300 ease-in-out lg:relative lg:inset-auto lg:z-auto shrink-0"
    :class="uiStore.sidebarOpen ? 'w-64' : 'w-0'"
    :style="{
      borderRadius: uiStore.sidebarOpen ? '0 26px 26px 0' : '0',
      boxShadow: uiStore.sidebarOpen ? '12px 0 34px -20px rgba(86,64,40,0.3)' : 'none',
      transitionProperty: 'width, border-radius, box-shadow',
    }"
  >
    <div class="flex h-full w-64 shrink-0 flex-col bg-[var(--surface)]/80 backdrop-blur-sm">
      <!-- 品牌 + 折叠（常驻显示，不随视图隐藏） -->
      <div class="flex shrink-0 items-center justify-between border-b border-[var(--line)] px-3 py-2.5">
        <div class="flex items-center gap-2">
          <Mascot :size="28" :float="false" :animated="false" />
          <!-- 双层渐变文字：下层固定色，上层随 subject 变化并通过 opacity 交叉淡变 -->
          <span class="relative inline-block text-lg font-bold tracking-tight">
            <span class="brand-text-bg">博文 Boen</span>
            <span class="brand-text-overlay">博文 Boen</span>
          </span>
          <span class="text-[10px] font-medium text-(--ink-soft)/60 ml-0.5 mt-0.5">v0.3.6</span>
        </div>
        <button @click="uiStore.sidebarOpen = false" class="flex h-11 w-11 items-center justify-center rounded-full transition-colors hover:bg-[var(--line)]/50" title="收起侧栏">
          <ChevronLeft class="h-4 w-4 text-[var(--ink-soft)]" />
        </button>
      </div>

      <div class="flex-1 overflow-y-auto px-2 py-2">
        <!-- ═══ 对话 ═══ -->
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
        <Transition name="submenu" @enter="onSubmenuEnter" @after-enter="onSubmenuAfterEnter" @leave="onSubmenuLeave">
        <div v-if="uiStore.expandedSection === 'chat'" class="submenu-panel mb-1 mt-1 space-y-0.5 pl-2">
          <button @click="chatStore.handleNewConversation()" class="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs font-semibold text-[var(--accent-strong)] transition-colors hover:bg-[var(--accent-soft)]">
            <Plus class="h-3.5 w-3.5" /> 新建对话
          </button>
          <div v-if="chatStore.conversations.length === 0" class="px-3 py-3 text-center text-xs text-[var(--ink-soft)]">还没有对话</div>
          <div
            v-for="conv in chatStore.conversations" :key="conv.id"
            class="group flex w-full items-center gap-1 rounded-lg"
          >
            <button
              type="button"
              @click="selectConversation(conv.id)"
              class="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-all"
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
            </button>
            <button @click="(e) => chatStore.handleDeleteConversation(conv.id, e)" class="rounded-md p-1 text-[var(--ink-soft)] transition-opacity hover:bg-[var(--error)]/10 hover:text-[var(--error)] sm:opacity-0 sm:group-hover:opacity-100" title="删除对话">
              <Trash2 class="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
        </Transition>

        <!-- ═══ 考试 ═══ -->
        <button
          @click="selectSection('exam')"
          class="mt-1 flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left font-display text-sm font-bold transition-all"
          :class="currentView === 'exam' || currentView === 'examReview' ? 'bg-[#e8e4ff] text-[#5848d6]' : 'text-[var(--ink)] hover:bg-[var(--line)]/50'"
        >
          <FileText class="h-4 w-4 shrink-0" />
          <span class="flex-1">考试</span>
          <Lock v-if="!authStore.isPremium" class="h-3 w-3 shrink-0" style="color: var(--locked-ink)" />
          <ChevronDown class="h-4 w-4 shrink-0 transition-transform" :class="(uiStore.expandedSection as string) === 'exam' ? '' : '-rotate-90'" />
        </button>
        <!-- 考试二级菜单 -->
        <Transition name="submenu" @enter="onSubmenuEnter" @after-enter="onSubmenuAfterEnter" @leave="onSubmenuLeave">
        <div v-if="(uiStore.expandedSection as string) === 'exam'" class="submenu-panel mb-1 mt-1 space-y-0.5 pl-2">
          <button @click="startNewExam" class="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs font-semibold text-[#5848d6] transition-colors hover:bg-[#e8e4ff]">
            <Plus class="h-3.5 w-3.5" /> 新考试
          </button>
          <div v-if="examStore.exams.length === 0" class="px-3 py-3 text-center text-xs text-[var(--ink-soft)]">还没有考试记录</div>
          <div
            v-for="ex in examStore.exams" :key="ex.examId"
            class="group flex w-full items-center gap-1 rounded-lg"
          >
            <button
              type="button"
              @click="ex.status === 'completed' ? openExamReview(ex.examId) : startNewExam()"
              class="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-all"
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
            <span v-if="ex.result" class="shrink-0 font-display text-sm font-bold text-[#5848d6] hidden sm:inline sm:group-hover:hidden">{{ ex.result.percentage }}</span>
            <span v-else class="shrink-0 text-[10px] font-semibold text-[#f59e42] hidden sm:inline sm:group-hover:hidden">未完成</span>
            </button>
            <button @click="(e) => examStore.handleDeleteExam(ex.examId, e)" class="shrink-0 rounded-md p-1 text-[var(--ink-soft)] transition-colors hover:bg-[var(--error)]/10 hover:text-[var(--error)] sm:hidden sm:group-hover:inline" title="删除考试">
              <Trash2 class="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
        </Transition>

        <!-- ═══ 错题本 ═══ -->
        <button
          @click="selectSection('mistakes')"
          class="mt-1 flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left font-display text-sm font-bold transition-all"
          :class="currentView === 'mistakes' ? 'bg-[#fff1d8] text-[#c76b17]' : 'text-[var(--ink)] hover:bg-[var(--line)]/50'"
        >
          <NotebookPen class="h-4 w-4 shrink-0" />
          <span class="flex-1">错题本</span>
          <Lock v-if="!authStore.isPremium" class="h-3 w-3 shrink-0" style="color: var(--locked-ink)" />
        </button>

        <!-- ═══ 档案 ═══ -->
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

      <!-- 用户设置入口 + 退出登录 -->
      <div class="shrink-0 space-y-0.5 border-t border-[var(--line)] px-3 py-2.5">
        <router-link
          to="/setup"
          class="flex items-center gap-2.5 rounded-xl px-2 py-2 transition-colors hover:bg-[var(--accent-soft)]/60"
        >
          <div class="grid h-7 w-7 shrink-0 place-items-center overflow-hidden rounded-full bg-[var(--accent-soft)]">
            <img
              v-if="authStore.currentUser?.picture"
              :src="authStore.currentUser.picture"
              :alt="authStore.currentUser.username"
              class="h-full w-full object-cover"
            />
            <User v-else class="h-3.5 w-3.5 text-[var(--accent-strong)]" />
          </div>
          <div class="min-w-0 flex-1">
            <p class="flex items-center gap-1.5 truncate text-xs font-bold text-[var(--ink)]">
              <span class="truncate">{{ authStore.userProfile?.name ?? authStore.currentUser?.username ?? '用户' }}</span>
              <span v-if="authStore.isPremium" class="badge-premium shrink-0"><Crown class="h-2.5 w-2.5" /> 会员</span>
            </p>
            <p class="text-[10px] text-[var(--ink-soft)]">{{ userGradeLabel }} · {{ userModelLabel }}</p>
          </div>
          <Settings class="h-3.5 w-3.5 shrink-0 text-[var(--ink-soft)]" />
        </router-link>
        <button
          @click="authStore.doLogout()"
          class="flex w-full items-center gap-2 rounded-xl px-2 py-1.5 text-xs font-semibold text-[var(--ink-soft)] transition-colors hover:bg-[var(--error)]/5 hover:text-[var(--error)]"
        >
          <LogOut class="ml-7 h-3.5 w-3.5" />
          退出登录
        </button>
      </div>

      <!-- ICP 备案 -->
      <div class="shrink-0 border-t border-[var(--line)] px-3 py-2 text-center">
        <a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener noreferrer" class="text-[10px] text-(--ink-soft)/50 hover:text-(--ink-soft)/80 transition-colors">
          浙ICP备2026040257号-1
        </a>
      </div>
    </div>
  </aside>

  <!-- Mobile backdrop overlay -->
  <div
    v-if="uiStore.sidebarOpen"
    class="fixed inset-0 z-30 bg-black/30 backdrop-blur-sm transition-opacity lg:hidden"
    @click="uiStore.sidebarOpen = false"
  />

  <!-- 折叠态下的展开把手 -->
  <button
    v-if="!uiStore.sidebarOpen"
    @click="uiStore.sidebarOpen = true"
    class="fixed bottom-4 left-3 z-30 flex h-11 w-11 items-center justify-center rounded-full bg-[var(--surface)] shadow-[0_6px_16px_-8px_rgba(86,64,40,0.4)] transition-colors hover:bg-[var(--accent-soft)] lg:absolute lg:bottom-3 lg:left-2 lg:h-9 lg:w-9"
    title="展开侧栏"
  >
    <ChevronRight class="h-5 w-5 text-[var(--ink-soft)]" />
  </button>
</template>

<style scoped>
/* ── 二级菜单展开/收起过渡 ── */
.submenu-panel {
  overflow: hidden;
  will-change: height, opacity;
}
.submenu-enter-active,
.submenu-leave-active {
  transition: height 0.28s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.22s ease;
}

@media (prefers-reduced-motion: reduce) {
  .submenu-enter-active,
  .submenu-leave-active {
    transition: opacity 0.15s ease;
  }
}
</style>
