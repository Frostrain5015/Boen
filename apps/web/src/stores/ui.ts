import { defineStore } from 'pinia';
import { ref, computed, nextTick } from 'vue';
import { createConversation } from '@/services/chat';
import { useToast } from '@/composables/useToast';
import { useChatStore, type Subject } from './chat';

export const SUBJECT_LABELS: { value: Subject; label: string; emoji: string }[] = [
  { value: 'chinese', label: '\u8bed\u6587', emoji: '\ud83d\udcd6' },
  { value: 'math', label: '\u6570\u5b66', emoji: '\ud83d\udd22' },
  { value: 'english', label: '\u82f1\u8bed', emoji: '\ud83d\udd24' },
  { value: 'science', label: '\u79d1\u5b66', emoji: '\ud83d\udd2c' },
];

export type ActiveMode = 'none' | 'review' | 'preview' | 'weakness' | 'practice' | 'exam' | 'explore';

export const useUiStore = defineStore('ui', () => {
  const toast = useToast();

  // ── State ─────────────────────────────────────────────────
  const subject = ref<Subject>('math');
  const mobileMediaQuery = typeof window !== 'undefined' ? window.matchMedia('(max-width: 1023px)') : null;
  const isMobile = ref(mobileMediaQuery?.matches ?? false);
  const sidebarOpen = ref(!isMobile.value);
  mobileMediaQuery?.addEventListener('change', (event) => {
    isMobile.value = event.matches;
    sidebarOpen.value = !event.matches;
  });
  const expandedSection = ref<'chat' | 'exam' | null>('chat');
  const activeMode = ref<ActiveMode>('none');
  const sessionActive = ref(false);
  const practiceType = ref<string | null>(null);
  const practiceMenuOpen = ref(false);
  const modeTagSent = ref(false);
  const showUserMenu = ref(false);

  // ── Getters ───────────────────────────────────────────────
  /** 当前年级过滤后的可选学科列表 */
  const availableSubjects = computed(() => {
    const auth = useAuthStore();
    const grade = auth.userProfile?.grade;
    if (grade === 'high') return SUBJECT_LABELS.filter((s) => s.value !== 'science');
    return SUBJECT_LABELS;
  });

  const subjectIndex = computed(() => availableSubjects.value.findIndex((s) => s.value === subject.value));

  const isCollege = computed(() => useAuthStore().userProfile?.grade === 'college');

  const voiceLocale = computed(() => subject.value === 'english' ? 'en-US' : 'zh-CN');

  const practiceMenu = computed(() => {
    const all: Record<string, Array<{ type: string; label: string; hint: string }>> = {
      chinese: [
        { type: 'dictation', label: '\u5b57\u8bcd\u542c\u5199', hint: '\u5f00\u59cb\u5b57\u8bcd\u542c\u5199\u7ec3\u4e60' },
        { type: 'recitation', label: '\u8bfe\u6587\u80cc\u8bf5', hint: '\u5f00\u59cb\u8bfe\u6587\u80cc\u8bf5\u7ec3\u4e60' },
        { type: 'reading', label: '\u9605\u8bfb\u7406\u89e3', hint: '\u5f00\u59cb\u9605\u8bfb\u7406\u89e3\u7ec3\u4e60' },
        { type: 'writing', label: '\u4f5c\u6587\u6307\u5bfc', hint: '\u5f00\u59cb\u4f5c\u6587\u6307\u5bfc\u7ec3\u4e60' },
      ],
      math: [
        { type: 'mental-arithmetic', label: '\u53e3\u7b97\u901f\u7ec3', hint: '\u5f00\u59cb\u53e3\u7b97\u7ec3\u4e60' },
      ],
      english: [
        { type: 'vocabulary', label: '\u5355\u8bcd\u5b66\u4e60', hint: '\u5f00\u59cb\u5355\u8bcd\u5b66\u4e60' },
      ],
    };
    // \u901a\u7528\u6a21\u5f0f\u4e0b\u663e\u793a\u6240\u6709\u5b66\u79d1\u7684\u5168\u90e8\u4e13\u9879\u7ec3\u4e60
    if (!activeMode.value || activeMode.value === 'none') {
      return Object.values(all).flat();
    }
    return all[subject.value] ?? [];
  });

  // ── Actions ───────────────────────────────────────────────

  /** 开始类课堂会话（锁定模式按钮、播放跑马灯） */
  function startSession() {
    sessionActive.value = true;
    console.log(`[Boen 类课堂] 🔒 会话开始 — 模式: ${activeMode.value} | ${new Date().toLocaleTimeString()}`);
  }

  /** 结束类课堂会话（解锁模式按钮、停止跑马灯） */
  function endSession() {
    sessionActive.value = false;
    console.log(`[Boen 类课堂] ✅ 会话结束 — 耗时: ${new Date().toLocaleTimeString()}`);
    activeMode.value = 'none';
  }

  function activateMode(mode: 'review' | 'preview' | 'weakness') {
    if (sessionActive.value) {
      toast.warning('当前有进行中的学习，结束后可切换模式');
      return;
    }
    if (activeMode.value === mode) { activeMode.value = 'none'; return; }
    activeMode.value = mode;
    modeTagSent.value = false;
    const chatStore = useChatStore();
    const hints: Record<string, string> = { review: '\u5e2e\u6211\u590d\u4e60\u5de9\u56fa ', preview: '\u5e2e\u6211\u9884\u4e60 ', weakness: '\u5e2e\u6211\u96c6\u4e2d\u7ec3\u4e60 ' };
    if (activeMode.value === mode) chatStore.input = hints[mode];
  }

  function togglePracticeMenu() {
    practiceMenuOpen.value = !practiceMenuOpen.value;
    if (!practiceMenuOpen.value) return;
    activeMode.value = 'none';
  }

  function closePracticeMenu() {
    practiceMenuOpen.value = false;
  }

  function startPractice(type: string, hint: string) {
    practiceType.value = type;
    const chatStore = useChatStore();
    chatStore.input = hint;
    activeMode.value = 'practice';
    practiceMenuOpen.value = false;
  }

  async function handleSubjectChange(newSubject: Subject, keepConversation?: boolean) {
    if (subject.value === newSubject) return;
    const chatStore = useChatStore();
    // 仅手动切换时新建对话，模型自适应切换保留现有对话
    if (!keepConversation && chatStore.items.length > 0) {
      try {
        const { conversation } = await createConversation('\u65b0\u5bf9\u8bdd', newSubject);
        chatStore.conversations.unshift(conversation);
        chatStore.currentConversationId = conversation.id;
        chatStore.items = [];
      } catch { toast.error('\u5207\u6362\u5b66\u79d1\u521b\u5efa\u5bf9\u8bdd\u5931\u8d25'); }
    }
    
    await nextTick();
    subject.value = newSubject;
  }

  // Navigate from practice/profile into chat context
  async function handlePractice(detail: { kp?: string; subject: Subject; grade: string; mode?: string }) {
    const chatStore = useChatStore();
    expandedSection.value = 'chat';
    activeMode.value = (detail.mode as ActiveMode) || (detail.kp ? 'weakness' : 'review');
    if (!chatStore.currentConversationId || subject.value !== detail.subject) {
      try {
        const { conversation } = await createConversation('\u65b0\u5bf9\u8bdd', detail.subject);
        chatStore.conversations.unshift(conversation);
        chatStore.currentConversationId = conversation.id;
        chatStore.items = [];
      } catch { toast.error('\u521b\u5efa\u7ec3\u4e60\u5bf9\u8bdd\u5931\u8d25'); }
    }
    subject.value = detail.subject;
    if (detail.kp) {
      chatStore.send(`\u5e2e\u6211\u96c6\u4e2d\u7ec3\u4e60 ${detail.kp}`);
    } else {
      chatStore.send('\u5e2e\u6211\u590d\u4e60\u5de9\u56fa ');
    }
  }

  async function handleMistakePractice(detail: { prompt: string; subject: Subject; grade: string }) {
    const chatStore = useChatStore();
    const authStore = useAuthStore();
    expandedSection.value = 'chat';
    activeMode.value = 'weakness';
    modeTagSent.value = false;
    if (!chatStore.currentConversationId || subject.value !== detail.subject) {
      try {
        const { conversation } = await createConversation('\u9519\u9898\u4e3e\u4e00\u53cd\u4e09', detail.subject);
        chatStore.conversations.unshift(conversation);
        chatStore.currentConversationId = conversation.id;
        chatStore.items = [];
      } catch { toast.error('\u521b\u5efa\u9519\u9898\u7ec3\u4e60\u5bf9\u8bdd\u5931\u8d25'); }
    }
    subject.value = detail.subject;
    if (authStore.userProfile) {
      authStore.userProfile.grade = detail.grade as import('@boen/shared').Grade;
      authStore.saveProfile(authStore.userProfile);
    }
    await chatStore.send(detail.prompt);
  }

  return {
    // state
    subject,
    sidebarOpen,
    isMobile,
    expandedSection,
    activeMode,
    sessionActive,
    practiceType,
    practiceMenuOpen,
    modeTagSent,
    showUserMenu,
    // getters
    subjectIndex,
    availableSubjects,
    voiceLocale,
    isCollege,
    practiceMenu,
    // actions
    startSession,
    endSession,
    activateMode,
    togglePracticeMenu,
    closePracticeMenu,
    startPractice,
    handleSubjectChange,
    handlePractice,
    handleMistakePractice,
  };
});

// Lazy import to avoid circular dependency at module evaluation time
import { useAuthStore } from './auth';
