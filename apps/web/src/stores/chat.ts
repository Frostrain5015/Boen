import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type { AnswerPayload, GradingResult, SseEvent, Grade } from '@boen/shared';
import { gradeToBand } from '@boen/shared';
import {
  streamChat,
  streamAnswer,
  getConversations,
  getConversation,
  createConversation as apiCreateConversation,
  deleteConversation as apiDeleteConversation,
  type Conversation,
} from '@/services/chat';
import { processTikzDiagrams as runTikz } from '@/lib/tikz';
import { useToast } from '@/composables/useToast';
import { useConfirm } from '@/composables/useConfirm';
import { nextTick } from 'vue';
import type { MascotState } from '@/components/Mascot.vue';
import { useAuthStore } from './auth';
import { useUiStore } from './ui';

// ── Types ───────────────────────────────────────────────────
export type Subject = 'chinese' | 'math' | 'english' | 'science';

export type ChatItem =
  | { kind: 'user'; text: string; modeTag?: string }
  | { kind: 'assistant'; text: string; done: boolean }
  | { kind: 'question'; toolCallId: string; question: import('@boen/shared').QuestionPayload; answered: boolean; grading?: GradingResult; userAnswer?: import('@boen/shared').AnswerPayload };

const newAssistant = (text = ''): ChatItem => ({ kind: 'assistant', text, done: false });

export const SUBJECT_MAP: Record<string, { label: string; emoji: string }> = {
  chinese: { label: '\u8bed\u6587', emoji: '\ud83d\udcd6' },
  math: { label: '\u6570\u5b66', emoji: '\ud83d\udd22' },
  english: { label: '\u82f1\u8bed', emoji: '\ud83d\udd24' },
  science: { label: '\u79d1\u5b66', emoji: '\ud83d\udd2c' },
};

export const useChatStore = defineStore('chat', () => {
  const toast = useToast();
  const { confirm } = useConfirm();

  // ── State ─────────────────────────────────────────────────
  const items = ref<ChatItem[]>([]);
  const input = ref('');
  const busy = ref(false);
  const isGeneratingQuiz = ref(false);
  const learningSettlement = ref<{ summary: string; score: number; stepsCompleted: number; totalSteps: number; updatedKps: number } | null>(null);
  /** 类课堂是否进行中（用于步骤日志检测，避免跨 store 引用） */
  let _sessionActive = false;
  /** 会话开始时间戳（用于日志 elapsed 计算） */
  let _sessionStartTime = 0;
  /** 已记录到的步骤日志位置（防重复） */
  let _lastLoggedStep = 0;
  // 已移除 knowledgeBaseLoading
  const conversations = ref<Conversation[]>([]);
  const currentConversationId = ref<string | null>(null);
  const reaction = ref<MascotState | null>(null);
  const dailyLimitReached = ref(false);
  let reactionTimer: ReturnType<typeof setTimeout> | undefined;

  // ── Getters ───────────────────────────────────────────────
  const hasItems = computed(() => items.value.length > 0);
  const showTyping = computed(() => {
    const last = items.value[items.value.length - 1];
    return busy.value && last?.kind === 'assistant' && !last.text;
  });
  const mascotState = computed<MascotState>(() => {
    if (reaction.value) return reaction.value;
    if (busy.value && showTyping.value) return 'thinking';
    if (busy.value) return 'listening';
    const last = items.value[items.value.length - 1];
    if (last?.kind === 'question') {
      return last.grading ? (last.grading.correct ? 'happy' : 'surprise') : 'quiz';
    }
    return 'idle';
  });

  // ── Internal helpers ──────────────────────────────────────

  function triggerReaction(s: MascotState) {
    reaction.value = s;
    clearTimeout(reactionTimer);
    reactionTimer = setTimeout(() => { reaction.value = null; }, 2600);
  }

  async function processTikzDiagrams() {
    await nextTick();
    await runTikz();
  }

  function scrollDown(force = false) {
    // This will be called by components; the actual DOM scrolling is
    // handled by the useScrollManagement composable. We emit via a
    // callback that ChatMessages.vue sets up.
    scrollDownCallback?.(force);
  }
  let scrollDownCallback: ((force?: boolean) => void) | null = null;
  function setScrollDownCallback(cb: (force?: boolean) => void) {
    scrollDownCallback = cb;
  }

  // ── SSE event handler ────────────────────────────────────
  async function handleEvent(e: SseEvent, idx: { value: number }) {
    if (e.type === 'token') {
      let cur = items.value[idx.value];
      if (!cur || cur.kind !== 'assistant') {
        items.value.push(newAssistant());
        idx.value = items.value.length - 1;
        cur = items.value[idx.value];
      }
      if (cur.kind === 'assistant') {
        cur.text += e.value;
        if (e.value.includes('`')) nextTick(() => runTikz(document));
        // 类课堂 TODO 步骤日志（占位，实际由 todo_step 事件驱动）
        // 此处保留空分支避免后续误会
      }
    } else if (e.type === 'quiz_generating') {
      isGeneratingQuiz.value = true;
    } else if (e.type === 'question') {
      isGeneratingQuiz.value = false;
      const cur = items.value[idx.value];
      if (cur && cur.kind === 'assistant' && !cur.text.trim()) items.value.splice(idx.value, 1);
      items.value.push({ kind: 'question', toolCallId: e.toolCallId, question: e.question, answered: false });
      idx.value = -1;
      scrollDown(true);
    } else if (e.type === 'title_updated') {
      const conv = conversations.value.find((c) => c.id === e.conversationId);
      if (conv) conv.title = e.title;
    } else if (e.type === 'grading') {
      const q = items.value.find((it) => it.kind === 'question' && it.toolCallId === e.toolCallId);
      if (q && q.kind === 'question') q.grading = e.result;
      triggerReaction(e.result.correct ? 'happy' : 'surprise');
    } else if (e.type === 'todo_step') {
      if (e.action === 'advance') {
        const match = e.detail.match(/第(\d+)步完成/);
        const step = match ? parseInt(match[1]) : _lastLoggedStep + 1;
        _lastLoggedStep = step;
        const elapsed = ((Date.now() - _sessionStartTime) / 1000).toFixed(1);
        console.log(`[Boen 类课堂] 🎯 第${step}步完成 — 会话已进行 ${elapsed}s | ${new Date().toLocaleTimeString()}`);
      }
    } else if (e.type === 'usage') {
      const authStore = useAuthStore();
      if (authStore.subscription && !authStore.subscription.isPremium) {
        authStore.subscription = {
          ...authStore.subscription,
          dailyLimit: e.dailyLimit,
          dailyUsed: e.dailyUsed,
          dailyRemaining: e.dailyRemaining,
        };
      }
    } else if (e.type === 'settlement') {
      learningSettlement.value = { summary: e.summary, score: e.score, stepsCompleted: e.stepsCompleted, totalSteps: e.totalSteps, updatedKps: e.updatedKps };
      console.log(`[Boen 类课堂] 📊 结算 — ${e.stepsCompleted}/${e.totalSteps} 步 | ${e.score}分 | 更新${e.updatedKps}条KP | ${new Date().toLocaleTimeString()}`);
      _sessionActive = false;
      const { useUiStore } = await import('@/stores/ui');
      useUiStore().endSession();
    } else if (e.type === 'error') {
      items.value.push(newAssistant(`\u26a0\ufe0f ${e.message}`));
    }
    scrollDown();
  }

  function finalizeAssistants() {
    items.value.forEach((it) => {
      if (it.kind === 'assistant') it.done = true;
    });
    processTikzDiagrams();
  }

  // ── Actions ───────────────────────────────────────────────

  async function send(text: string) {
    const t = text.trim();
    if (!t || busy.value) return;
    const authStore = useAuthStore();
    const uiStore = useUiStore();
    // 发送第一条消息时锁定类课堂模式
    if (uiStore.activeMode !== 'none' && !uiStore.sessionActive) {
      console.log(`[Boen 类课堂] 📤 发送消息 — 主题: "${t.slice(0, 30)}" | ${new Date().toLocaleTimeString()}`);
      _sessionActive = true;
      _sessionStartTime = Date.now();
      _lastLoggedStep = 0;
      uiStore.startSession();
    }

    // Auto-create conversation if none is active
    if (!currentConversationId.value) {
      try {
        const { conversation } = await apiCreateConversation('\u65b0\u5bf9\u8bdd', uiStore.subject);
        conversations.value.unshift(conversation);
        currentConversationId.value = conversation.id;
      } catch { toast.error('\u521b\u5efa\u5bf9\u8bdd\u5931\u8d25'); }
    }

    input.value = '';
    busy.value = true;
    // Mark unanswered question cards as skipped
    items.value.forEach((it) => {
      if (it.kind === 'question' && !it.answered) it.answered = true;
    });
    // Mode tag (first send only)
    const tagMap: Record<string, string> = { review: '\ud83d\udcda\u590d\u4e60\u5de9\u56fa\u00b7', preview: '\ud83d\udcd6\u9884\u4e60\u00b7', weakness: '\ud83c\udfaf\u96c6\u4e2d\u7ec3\u4e60\u00b7' };
    const modeLabel = uiStore.practiceType ? '\u270f\ufe0f\u4e13\u9879\u7ec3\u4e60\u00b7' : (tagMap[uiStore.activeMode] || '');
    const modeTag = !uiStore.modeTagSent && modeLabel ? modeLabel : undefined;
    if (modeTag) uiStore.modeTagSent = true;

    items.value.push({ kind: 'user', text: t, modeTag });
    items.value.push(newAssistant());
    const idx = { value: items.value.length - 1 };
    scrollDown(true);
    try {
      await streamChat(
        {
          threadId: currentConversationId.value!,
          message: t,
          gradeBand: authStore.userProfile ? gradeToBand(authStore.userProfile.grade) : 'middle',
          grade: authStore.userProfile?.grade,
          userName: authStore.userProfile?.name,
          subject: uiStore.subject,
          conversationId: currentConversationId.value ?? undefined,
          practiceType: uiStore.practiceType ?? undefined,
          mode: uiStore.activeMode !== 'none' ? (uiStore.activeMode as any) : undefined,
        },
        (e) => handleEvent(e, idx),
      );
    } catch (err) {
      const status = (err as any)?.status;
      if (status === 429) {
        dailyLimitReached.value = true;
        // 移除乐观添加的空助手消息
        const lastItem = items.value[items.value.length - 1];
        if (lastItem?.kind === 'assistant' && !lastItem.text) {
          items.value.pop();
        }
      } else {
        items.value.push(newAssistant(`\u26a0\ufe0f \u8bf7\u6c42\u5931\u8d25\uff1a${err instanceof Error ? err.message : String(err)}`));
      }
    } finally {
      finalizeAssistants();
      scrollDown(true);
      busy.value = false;
      isGeneratingQuiz.value = false;
    }
  }

  async function onAnswer(item: Extract<ChatItem, { kind: 'question' }>, answer: AnswerPayload) {
    if (item.answered || busy.value) return;
    item.answered = true;
    busy.value = true;
    const idx = { value: -1 };
    scrollDown(true);
    try {
      await streamAnswer({ threadId: currentConversationId.value!, toolCallId: item.toolCallId, answer, conversationId: currentConversationId.value ?? undefined }, (e) => handleEvent(e, idx));
    } catch (err) {
      items.value.push(newAssistant(`\u26a0\ufe0f \u63d0\u4ea4\u5931\u8d25\uff1a${err instanceof Error ? err.message : String(err)}`));
    } finally {
      finalizeAssistants();
      scrollDown(true);
      busy.value = false;
      isGeneratingQuiz.value = false;
    }
  }

  async function loadConversations() {
    try {
      const { conversations: convs } = await getConversations();
      conversations.value = convs;
    } catch (e) {
      console.warn('[boen] loadConversations failed:', e);
    }
  }

  async function handleNewConversation() {
    const uiStore = useUiStore();
    if (uiStore.sessionActive) uiStore.endSession();
    try {
      const { conversation } = await apiCreateConversation('\u65b0\u5bf9\u8bdd', uiStore.subject);
      conversations.value.unshift(conversation);
      currentConversationId.value = conversation.id;
      items.value = [];
    } catch {
      toast.error('\u521b\u5efa\u5bf9\u8bdd\u5931\u8d25\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5');
    }
  }

  async function handleDeleteConversation(id: string, event: Event) {
    event.stopPropagation();
    const ok = await confirm({ title: '\u5220\u9664\u5bf9\u8bdd', message: '\u786e\u5b9a\u8981\u5220\u9664\u8fd9\u4e2a\u5bf9\u8bdd\u5417\uff1f', confirmText: '\u5220\u9664', danger: true });
    if (!ok) return;
    // \u786e\u8ba4\u5220\u9664\u540e\u518d\u9000\u51fa\u7c7b\u8bfe\u5802\uff08\u5426\u5219\u53d6\u6d88\u540e session \u5df2\u7ed3\u675f\uff09
    const uiStore = useUiStore();
    if (currentConversationId.value === id && uiStore.sessionActive) {
      uiStore.endSession();
    }
    try {
      await apiDeleteConversation(id);
      conversations.value = conversations.value.filter((c) => c.id !== id);
      if (currentConversationId.value === id) {
        currentConversationId.value = null;
        items.value = [];
      }
      toast.success('\u5bf9\u8bdd\u5df2\u5220\u9664');
    } catch {
      toast.error('\u5220\u9664\u5bf9\u8bdd\u5931\u8d25\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5');
    }
  }

  async function selectConversation(id: string) {
    const uiStore = useUiStore();
    if (uiStore.sessionActive) uiStore.endSession();
    currentConversationId.value = id;
    try {
      const { conversation: conv, messages: msgs } = await getConversation(id);
      uiStore.subject = conv.subject as Subject;
      const restored: ChatItem[] = [];
      for (const m of msgs) {
        if (m.role === 'user') {
          restored.push({ kind: 'user', text: m.content });
        } else if (m.role === 'system') {
          try {
            const meta = JSON.parse(m.content);
            if (meta.__boen_type === 'question') {
              const toolCallId: string = meta.toolCallId ?? '';
              const wasAnswered = meta.answered === true;
              const grading = wasAnswered ? (meta.grading as GradingResult | undefined) : undefined;
              const userAnswer = wasAnswered ? meta.userAnswer : undefined;
              restored.push({
                kind: 'question',
                toolCallId,
                question: meta.payload,
                answered: wasAnswered,
                grading,
                userAnswer,
              });
            }
          } catch { /* non-structured system message, ignore */ }
        } else if (m.role === 'assistant') {
          restored.push({ kind: 'assistant', text: m.content, done: true });
        }
      }
      items.value = restored;
      processTikzDiagrams();
    } catch (e) {
      items.value = [];
      console.warn('[boen] selectConversation failed:', e);
      toast.error('\u52a0\u8f7d\u5bf9\u8bdd\u5931\u8d25');
    }
  }

  return {
    // state
    items,
    input,
    busy,
    isGeneratingQuiz,
    conversations,
    currentConversationId,
    reaction,
    dailyLimitReached,
    learningSettlement,
    // getters
    hasItems,
    showTyping,
    mascotState,
    // actions
    send,
    onAnswer,
    loadConversations,
    handleNewConversation,
    handleDeleteConversation,
    selectConversation,
    handleEvent,
    finalizeAssistants,
    scrollDown,
    setScrollDownCallback,
    processTikzDiagrams,
  };
});
