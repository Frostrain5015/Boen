<script setup lang="ts">
import { ref, computed, nextTick, watch, onMounted } from 'vue';
import { Send, Sparkles, LogOut, User, Plus, Trash2, MessageSquare, ChevronLeft, ChevronRight, ChevronDown, PencilLine, Settings, GraduationCap, BrainCircuit, FileText, BookOpen, Target, PenTool } from 'lucide-vue-next';
import { renderMarkdown } from '@/lib/markdown';
import { processTikzDiagrams as runTikz } from '@/lib/tikz';
import type { QuestionPayload, AnswerPayload, GradingResult, SseEvent, Grade, ExamSummary } from '@boen/shared';
import { gradeToBand } from '@boen/shared';
import { streamChat, streamAnswer, getConversations, getConversation, createConversation, deleteConversation, listExams, deleteExam, type Conversation, type ConversationMessage } from '@/services/chat';
import { isAuthenticated, getCurrentUser, logout, type FrostUser } from '@/services/auth';
import QuestionCard from '@/components/QuestionCard.vue';
import KnowledgeProfile from '@/components/KnowledgeProfile.vue';
import ExamView from '@/components/ExamView.vue';
import ExamReview from '@/components/ExamReview.vue';
import UserSetupDialog from '@/components/UserSetupDialog.vue';
import Mascot from '@/components/Mascot.vue';
import TypingDots from '@/components/TypingDots.vue';
import LoginView from '@/components/LoginView.vue';
import OAuthCallback from '@/components/OAuthCallback.vue';
import type { MascotState } from '@/components/Mascot.vue';

type Subject = 'chinese' | 'math' | 'english' | 'science';

type ChatItem =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string; done: boolean }
  | { kind: 'question'; toolCallId: string; question: QuestionPayload; answered: boolean; grading?: GradingResult };

const newAssistant = (text = ''): ChatItem => ({ kind: 'assistant', text, done: false });

const SUBJECT_LABELS: { value: Subject; label: string; emoji: string }[] = [
  { value: 'chinese', label: '语文', emoji: '📖' },
  { value: 'math', label: '数学', emoji: '🔢' },
  { value: 'english', label: '英语', emoji: '🔤' },
  { value: 'science', label: '科学', emoji: '🔬' },
];

// ── 用户画像（名字 + 年级，localStorage 持久化）──
const PROFILE_KEY = 'boen_user_profile';
type UserProfile = { name: string; grade: Grade };
/** 旧画像（仅 gradeBand）迁移到具体年级的代表值 */
const BAND_TO_GRADE: Record<string, Grade> = { primary: '3', middle: '8', undergrad: 'college' };
function loadProfile(): UserProfile | null {
  try {
    const raw = localStorage.getItem(PROFILE_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (p.name && p.grade) return { name: p.name, grade: p.grade };
    // 兼容旧版：{ name, gradeBand } → 映射到代表年级
    if (p.name && p.gradeBand) return { name: p.name, grade: BAND_TO_GRADE[p.gradeBand] ?? '8' };
  } catch { /* 忽略损坏数据 */ }
  return null;
}
function saveProfile(p: UserProfile) {
  localStorage.setItem(PROFILE_KEY, JSON.stringify(p));
}
const userProfile = ref<UserProfile | null>(loadProfile());
const showSetupDialog = ref(false);

// ── 认证状态 ──────────────────────────────
const authChecked = ref(false);
const authenticated = ref(false);
const currentUser = ref<FrostUser | null>(null);
const showUserMenu = ref(false);

// 是否处于 OAuth 回调页（用 ref，登录成功后手动切回主应用）
const isOAuthCallback = ref(window.location.pathname === '/auth/callback');

// ── 对话管理 ──────────────────────────────
const conversations = ref<Conversation[]>([]);
const currentConversationId = ref<string | null>(null);
const sidebarOpen = ref(true);

// ── 考试历史 ──────────────────────────────
const exams = ref<ExamSummary[]>([]);
const selectedExamId = ref<string | null>(null);
const examViewKey = ref(0); // 递增以强制重挂 ExamView（开始新考试）

// ── 视图切换 ──────────────────────────────
const currentView = ref<'chat' | 'profile' | 'exam' | 'examReview'>('chat');
// 侧栏手风琴：同时只展开一个二级菜单（档案无二级菜单）
const expandedSection = ref<'chat' | 'exam' | null>('chat');
const activeMode = ref<'none' | 'review' | 'preview' | 'weakness' | 'exam'>('none');
const practiceType = ref<string | null>(null);

const SUBJECT_MAP: Record<string, { label: string; emoji: string }> = {
  chinese: { label: '语文', emoji: '📖' }, math: { label: '数学', emoji: '🔢' },
  english: { label: '英语', emoji: '🔤' }, science: { label: '科学', emoji: '🔬' },
};

// ── 聊天状态 ──────────────────────────────
const items = ref<ChatItem[]>([]);
const input = ref('');
const subject = ref<Subject>('math');
const busy = ref(false);
const threadId = `web-${Date.now()}`;
const scroller = ref<HTMLElement | null>(null);

const hasItems = computed(() => items.value.length > 0);
const hasScrollOverflow = ref(false);

function activateMode(mode: 'review' | 'preview' | 'weakness') {
  activeMode.value = activeMode.value === mode ? 'none' : mode;
  currentView.value = 'chat';
  const hints: Record<string, string> = { review: '我想学习 ', preview: '帮我预习 ', weakness: '帮我突破薄弱点 ' };
  if (activeMode.value === mode) input.value = hints[mode];
}

function startPractice(type: string, hint: string) {
  practiceType.value = type;
  input.value = hint;
  activeMode.value = 'none';
  currentView.value = 'chat';
  focusInput();
}

/** 当前学科可用的专项练习菜单 */
const practiceMenu = computed(() => {
  const s = subject.value;
  const all: Record<string, Array<{ type: string; label: string; hint: string }>> = {
    chinese: [
      { type: 'dictation', label: '字词听写', hint: '开始字词听写练习' },
      { type: 'recitation', label: '课文背诵', hint: '开始课文背诵练习' },
      { type: 'reading', label: '阅读理解', hint: '开始阅读理解练习' },
      { type: 'writing', label: '作文指导', hint: '开始作文指导练习' },
    ],
    math: [
      { type: 'mental-arithmetic', label: '口算速练', hint: '开始口算练习' },
    ],
    english: [
      { type: 'vocabulary', label: '单词学习', hint: '开始单词学习' },
    ],
  };
  return all[s] ?? [];
});

let _inputEl: HTMLTextAreaElement | null = null;
function focusInput() { nextTick(() => _inputEl?.focus()); }

function checkScrollOverflow() {
  nextTick(() => {
    const el = scroller.value;
    if (!el) return;
    hasScrollOverflow.value = el.scrollHeight > el.clientHeight + 1;
  });
}
const subjectIndex = computed(() => SUBJECT_LABELS.findIndex((s) => s.value === subject.value));
const showTyping = computed(() => {
  const last = items.value[items.value.length - 1];
  return busy.value && last?.kind === 'assistant' && !last.text;
});

// 「博文正在出题」纯由后端 quiz_generating 事件驱动（模型实际调用出题工具时触发）
const isGeneratingQuiz = ref(false);

// 答题反馈：判分时短暂锁定 happy/surprise，确保反馈清晰可见（即使助手随后接着输出）
const reaction = ref<MascotState | null>(null);
let reactionTimer: ReturnType<typeof setTimeout> | undefined;
function triggerReaction(s: MascotState) {
  reaction.value = s;
  clearTimeout(reactionTimer);
  reactionTimer = setTimeout(() => { reaction.value = null; }, 2600);
}

/** 根据当前状态计算吉祥物动画 */
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

function scrollDown(force = false) {
  nextTick(() => {
    requestAnimationFrame(() => {
      const el = scroller.value;
      if (!el) return;
      // 自动跟踪阈值放宽：只要用户没有明显向上回滚（约半屏内），新内容输出时就辅助聚焦回最新
      const threshold = Math.max(280, el.clientHeight * 0.5);
      const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
      if (force || isNearBottom) el.scrollTo({ top: el.scrollHeight, behavior: force ? 'instant' : 'smooth' });
      hasScrollOverflow.value = el.scrollHeight > el.clientHeight + 1;
    });
  });
}

/**
 * 编译页面内的 TikZ 占位块（流式结束/历史恢复后调用）。
 * 复用 lib/tikz 的共享缓存与逻辑，全站（对话/小测/考试）一致。
 */
async function processTikzDiagrams() {
  await nextTick();
  await runTikz();
}

function handleEvent(e: SseEvent, idx: { value: number }) {
  if (e.type === 'token') {
    let cur = items.value[idx.value];
    if (!cur || cur.kind !== 'assistant') {
      items.value.push(newAssistant());
      idx.value = items.value.length - 1;
      cur = items.value[idx.value];
    }
    if (cur.kind === 'assistant') {
      cur.text += e.value;
      // 流式途中一旦检测到代码块闭合（含 ```），立即编译已完整的 TikZ，
      // 让编译与后续输出并行，结束时直接命中缓存秒显（不必等整段流结束）
      if (e.value.includes('`')) nextTick(() => runTikz(document, { onlyComplete: true }));
    }
  } else if (e.type === 'quiz_generating') {
    isGeneratingQuiz.value = true;
  } else if (e.type === 'question') {
    isGeneratingQuiz.value = false;
    const cur = items.value[idx.value];
    if (cur && cur.kind === 'assistant' && !cur.text.trim()) items.value.splice(idx.value, 1);
    items.value.push({ kind: 'question', toolCallId: e.toolCallId, question: e.question, answered: false });
    idx.value = -1;
  } else if (e.type === 'title_updated') {
    const conv = conversations.value.find((c) => c.id === e.conversationId);
    if (conv) conv.title = e.title;
  } else if (e.type === 'grading') {
    const q = items.value.find((it) => it.kind === 'question' && it.toolCallId === e.toolCallId);
    if (q && q.kind === 'question') q.grading = e.result;
    triggerReaction(e.result.correct ? 'happy' : 'surprise');
  } else if (e.type === 'error') {
    items.value.push(newAssistant(`⚠️ ${e.message}`));
  }
  scrollDown();
}

/** 流结束后把助手消息标记完成，切换到 Markdown 渲染 */
function finalizeAssistants() {
  items.value.forEach((it) => {
    if (it.kind === 'assistant') it.done = true;
  });
  processTikzDiagrams();
  checkScrollOverflow();
}

async function send(text: string) {
  const t = text.trim();
  if (!t || busy.value) return;
  // 发送后清除专项练习标记
  practiceType.value = null;

  // 没有活跃对话时自动创建
  if (!currentConversationId.value) {
    try {
      const { conversation } = await createConversation('新对话', subject.value);
      conversations.value.unshift(conversation);
      currentConversationId.value = conversation.id;
    } catch { /* 静默 */ }
  }

  input.value = '';
  busy.value = true;
  // 未作答的题目卡片视为跳过：禁用之，避免事后再答与服务端「跳过」处理冲突
  items.value.forEach((it) => {
    if (it.kind === 'question' && !it.answered) it.answered = true;
  });
  items.value.push({ kind: 'user', text: t });
  items.value.push(newAssistant());
  const idx = { value: items.value.length - 1 };
  scrollDown(true); // 发送消息时强制滚到底部
  try {
    await streamChat(
      { threadId, message: t, gradeBand: userProfile.value ? gradeToBand(userProfile.value.grade) : 'middle', grade: userProfile.value?.grade, userName: userProfile.value?.name, subject: subject.value, conversationId: currentConversationId.value ?? undefined, practiceType: practiceType.value ?? undefined },
      (e) => handleEvent(e, idx),
    );
  } catch (err) {
    items.value.push(newAssistant(`⚠️ 请求失败：${err instanceof Error ? err.message : String(err)}`));
  } finally {
    finalizeAssistants();
    busy.value = false;
    isGeneratingQuiz.value = false;
  }
}

async function onAnswer(item: Extract<ChatItem, { kind: 'question' }>, answer: AnswerPayload) {
  if (item.answered || busy.value) return;
  item.answered = true;
  busy.value = true;
  const idx = { value: -1 };
  scrollDown(true); // 作答后滚回底部看反馈
  try {
    await streamAnswer({ threadId, toolCallId: item.toolCallId, answer, conversationId: currentConversationId.value ?? undefined }, (e) => handleEvent(e, idx));
  } catch (err) {
    items.value.push(newAssistant(`⚠️ 提交失败：${err instanceof Error ? err.message : String(err)}`));
  } finally {
    finalizeAssistants();
    busy.value = false;
    isGeneratingQuiz.value = false;
  }
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send(input.value);
  }
}

function subjectLabel(val: string): { label: string; emoji: string } {
  return SUBJECT_LABELS.find((s) => s.value === val) ?? { label: val, emoji: '📁' };
}

function formatTime(date = new Date()) {
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
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

// ── 对话管理 ──────────────────────────────
async function loadConversations() {
  try {
    const { conversations: convs } = await getConversations();
    conversations.value = convs;
  } catch {
    // 忽略加载失败
  }
}

// ── 考试历史 ──────────────────────────────
async function loadExams() {
  try {
    const { exams: list } = await listExams();
    exams.value = list;
  } catch {
    // 忽略加载失败
  }
}

function subjectMeta(s: string) { return SUBJECT_MAP[s] ?? { label: s, emoji: '📁' }; }
function examGradeLabel(g: string): string {
  const n = Number(g);
  if (!n) return g;
  return n <= 6 ? `小${'一二三四五六'[n - 1]}` : `初${'一二三'[n - 7]}`;
}

// 侧栏分区切换（手风琴）：对话/考试展开二级菜单，档案直接进入
function selectSection(section: 'chat' | 'exam' | 'profile') {
  if (section === 'profile') {
    expandedSection.value = null;
    currentView.value = 'profile';
    return;
  }
  expandedSection.value = section;
  // 考试分区：有选中的回顾则保持回顾视图，否则进入出卷/答题视图
  if (section === 'chat') currentView.value = 'chat';
  else currentView.value = selectedExamId.value ? 'examReview' : 'exam';
}

function startNewExam() {
  selectedExamId.value = null;
  examViewKey.value++; // 强制重挂，回到出卷配置页
  currentView.value = 'exam';
  expandedSection.value = 'exam';
}

function openExamReview(examId: string) {
  selectedExamId.value = examId;
  currentView.value = 'examReview';
  expandedSection.value = 'exam';
}

async function handleDeleteExam(examId: string, event: Event) {
  event.stopPropagation();
  if (!confirm('确定要删除这场考试吗？删除后无法恢复。')) return;
  try {
    await deleteExam(examId);
    exams.value = exams.value.filter((e) => e.examId !== examId);
    // 若正在回顾被删的考试，退回聊天视图
    if (selectedExamId.value === examId) {
      selectedExamId.value = null;
      if (currentView.value === 'examReview') currentView.value = 'chat';
    }
  } catch {
    // 忽略删除失败
  }
}

async function handleNewConversation() {
  try {
    const { conversation } = await createConversation('新对话', subject.value);
    conversations.value.unshift(conversation);
    currentConversationId.value = conversation.id;
    items.value = [];
  } catch {
    // 忽略创建失败
  }
  checkScrollOverflow();
}

async function handleDeleteConversation(id: string, event: Event) {
  event.stopPropagation();
  if (!confirm('确定要删除这个对话吗？')) return;
  try {
    await deleteConversation(id);
    conversations.value = conversations.value.filter((c) => c.id !== id);
    if (currentConversationId.value === id) {
      currentConversationId.value = null;
      items.value = [];
    }
  } catch {
    // 忽略删除失败
  }
  checkScrollOverflow();
}

async function selectConversation(id: string) {
  currentConversationId.value = id;
  // 不先清空：保留旧内容直到新内容就绪，避免内容互切时闪过 Welcome 页并触发多余过渡
  try {
    const { conversation: conv, messages: msgs } = await getConversation(id);
    // 把对话的学科还原到学科选择器
    subject.value = conv.subject as Subject;
    // 收集 grading_result 供题目卡片配对
    const gradingByToolCallId = new Map<string, GradingResult>();
    for (const m of msgs) {
      if (m.role === 'system') {
        try {
          const meta = JSON.parse(m.content);
          if (meta.__boen_type === 'grading_result' && meta.toolCallId) {
            gradingByToolCallId.set(meta.toolCallId, meta.result as GradingResult);
          }
        } catch { /* 忽略非结构化消息 */ }
      }
    }
    // 将服务端消息转成 ChatItem（含持久化的题目卡片）
    const restored: ChatItem[] = [];
    for (const m of msgs) {
      if (m.role === 'user') {
        restored.push({ kind: 'user', text: m.content });
      } else if (m.role === 'system') {
        try {
          const meta = JSON.parse(m.content);
          if (meta.__boen_type === 'question') {
            const toolCallId: string = meta.toolCallId ?? '';
            const wasAnswered = !!meta.answered || gradingByToolCallId.has(toolCallId);
            restored.push({
              kind: 'question',
              toolCallId,
              question: meta.payload,
              answered: wasAnswered,
              grading: wasAnswered ? (gradingByToolCallId.get(toolCallId)) : undefined,
            });
          }
          // grading_result 本身不生成 ChatItem，已提前收集配对
        } catch { /* 非结构化 system 消息，忽略 */ }
      } else if (m.role === 'assistant') {
        restored.push({ kind: 'assistant', text: m.content, done: true });
      }
    }
    items.value = restored;
    processTikzDiagrams();
  } catch {
    items.value = [];
  }
  checkScrollOverflow();
}

// ── 认证相关 ──────────────────────────────
async function checkAuth() {
  if (isOAuthCallback.value) return;
  const auth = isAuthenticated();
  authenticated.value = auth;
  if (auth) {
    currentUser.value = await getCurrentUser();
    await Promise.all([loadConversations(), loadExams()]);
  }
  authChecked.value = true;
}

function handleOAuthSuccess() {
  // 还原地址栏并切回主应用（isOAuthCallback 非响应式 URL，需手动置位）
  window.history.replaceState({}, '', '/');
  isOAuthCallback.value = false;
  authenticated.value = true;
  authChecked.value = true;
  getCurrentUser().then((user) => {
    currentUser.value = user;
  });
  loadConversations();
  loadExams();
  // 首次登录弹出画像设置
  if (!userProfile.value) showSetupDialog.value = true;
}

function handleOAuthError() {
  window.history.replaceState({}, '', '/');
  isOAuthCallback.value = false;
  authChecked.value = true;
  authenticated.value = false;
}

function handleSaveProfile(p: UserProfile) {
  userProfile.value = p;
  saveProfile(p);
  showSetupDialog.value = false;
}

// 从「档案」推荐练习发起：切到对话，针对该知识点出题练习
async function handlePractice(detail: { kp?: string; subject: Subject; grade: string }) {
  currentView.value = 'chat';
  expandedSection.value = 'chat';
  activeMode.value = 'review';
  // 学科不同或当前无对话时，新开一个该学科的对话，避免学科串台
  if (!currentConversationId.value || subject.value !== detail.subject) {
    try {
      const { conversation } = await createConversation('新对话', detail.subject);
      conversations.value.unshift(conversation);
      currentConversationId.value = conversation.id;
      items.value = [];
    } catch { /* 静默 */ }
  }
  subject.value = detail.subject;
  const topic = detail.kp ? `「${detail.kp}」` : '这个学科';
  send(`我想练习${topic}，先考我几道题吧`);
}

async function handleSubjectChange(newSubject: Subject) {
  if (subject.value === newSubject) return;
  // 当前对话已有内容时，切换学科强制建新对话
  if (items.value.length > 0) {
    try {
      const { conversation } = await createConversation('新对话', newSubject);
      conversations.value.unshift(conversation);
      currentConversationId.value = conversation.id;
      items.value = [];
    } catch { /* 静默 */ }
  }
  subject.value = newSubject;
  checkScrollOverflow();
}

function handleLogout() {
  logout();
}

// ── 浏览器页签 favicon：跟随学科 accent 变色 ──────
const ACCENT_MAP: Record<string, string> = {
  chinese: '#ff7a4d', math: '#14b48a', english: '#6c5ce7', science: '#3498db',
};
function makeFaviconSvg(accent: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <circle cx="50" cy="55" r="33" fill="${accent}"/>
    <rect x="36" y="18" width="28" height="11" rx="3" fill="#2c2722"/>
    <polygon points="50,8 78,20 50,32 22,20" fill="#37322c"/>
    <polygon points="50,12 72,20 50,28 28,20" fill="#2c2722"/>
    <circle cx="50" cy="20" r="3" fill="${accent}"/>
    <ellipse cx="40" cy="52" rx="8" ry="9" fill="#fffdf9"/>
    <ellipse cx="60" cy="52" rx="8" ry="9" fill="#fffdf9"/>
    <circle cx="42" cy="53" r="4" fill="#2c2722"/><circle cx="62" cy="53" r="4" fill="#2c2722"/>
    <path d="M42 67 Q50 73 58 67" stroke="#2c2722" stroke-width="2.5" fill="none" stroke-linecap="round"/>
  </svg>`;
}
function updateFavicon(subj: string) {
  const color = ACCENT_MAP[subj] ?? '#14b48a';
  const svg = makeFaviconSvg(color);
  const encoded = encodeURIComponent(svg);
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  link.href = `data:image/svg+xml,${encoded}`;
}

// 初始化 favicon 并随学科切换变色
watch(subject, updateFavicon, { immediate: true });

// 点击外部关闭用户菜单
function onClickOutside(e: MouseEvent) {
  const target = e.target as HTMLElement;
  if (!target.closest('.user-menu')) {
    showUserMenu.value = false;
  }
}

onMounted(() => {
  checkAuth();
  document.addEventListener('click', onClickOutside);

  // ═══ 监听滚动容器尺寸变化（侧栏折叠/窗口resize），更新顶部淡出态 ═══
  let overflowObserver: ResizeObserver | undefined;
  nextTick(() => {
    if (scroller.value) {
      overflowObserver = new ResizeObserver(() => checkScrollOverflow());
      overflowObserver.observe(scroller.value);
    }
  });

  // ═══ 关键：等 Vue 第一帧完全渲染后再移除加载器 ═══
  // Vue 在后台默默挂载和渲染，加载器保持可见直到一切就绪
  nextTick().then(() => {
    // 等 Vue 完成 DOM 更新
    requestAnimationFrame(() => {
      // 等浏览器完成第一帧绘制（字体、MathLive 等初始化在后台进行）
      requestAnimationFrame(() => {
        const loader = document.getElementById('boot-loader');
        if (loader) {
          loader.classList.add('hide');
          loader.addEventListener('transitionend', () => loader.remove(), { once: true });
          // 兜底：300ms 后强制移除
          setTimeout(() => { if (loader.parentNode) loader.remove(); }, 400);
        }
      });
    });
  });
});
</script>

<template>
  <!-- OAuth 回调页面 -->
  <OAuthCallback
    v-if="isOAuthCallback"
    @success="handleOAuthSuccess"
    @error="handleOAuthError"
  />

  <!-- 登录页面 -->
  <LoginView v-else-if="authChecked && !authenticated" />

  <!-- 用户画像设置对话框 -->
  <UserSetupDialog
    v-if="showSetupDialog"
    :profile="userProfile"
    @save="handleSaveProfile"
  />

  <!-- 主应用 -->
  <div v-else :data-subject="subject" class="relative flex h-full flex-col">
    <div class="app-bg"></div>
    <div class="app-grain"></div>

    <div class="relative z-10 flex h-full">
      <!-- 侧边栏：对话 / 考试 / 档案（常驻，手风琴二级菜单） -->
      <aside
        class="h-full shrink-0 overflow-hidden transition-[width] duration-300 ease-in-out"
        :class="sidebarOpen ? 'w-64 rounded-r-[26px] shadow-[12px_0_34px_-20px_rgba(86,64,40,0.3)]' : 'w-0'"
      >
        <!-- 内层固定 256px，宽度动画时整体被裁切，内容不重排 -->
        <div class="flex h-full w-64 flex-col bg-[var(--surface)]/80 backdrop-blur-sm">
          <!-- 品牌 + 折叠（聊天模式下与 header logo 重叠，自动淡出） -->
          <div class="flex items-center justify-between overflow-hidden border-b border-[var(--line)] px-3 py-2.5 transition-all duration-400 ease-in-out" :class="currentView === 'chat' ? 'opacity-0 max-h-0 border-transparent py-0' : 'opacity-100 max-h-14'">
            <div class="flex items-center gap-2">
              <Mascot :size="28" :float="false" :animated="false" />
              <span class="brand-text text-lg font-bold tracking-tight">博文 Boen</span>
              <span class="text-[10px] font-medium text-(--ink-soft)/60 ml-0.5 mt-0.5">v0.1.1</span>
            </div>
            <button @click="sidebarOpen = false" class="flex h-7 w-7 items-center justify-center rounded-full transition-colors hover:bg-[var(--line)]/50" title="收起侧栏">
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
              <ChevronDown class="h-4 w-4 shrink-0 transition-transform" :class="expandedSection === 'chat' ? '' : '-rotate-90'" />
            </button>
            <!-- 对话二级菜单 -->
            <div v-if="expandedSection === 'chat'" class="mb-1 mt-1 space-y-0.5 pl-2">
              <button @click="handleNewConversation" class="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs font-semibold text-[var(--accent-strong)] transition-colors hover:bg-[var(--accent-soft)]">
                <Plus class="h-3.5 w-3.5" /> 新建对话
              </button>
              <div v-if="conversations.length === 0" class="px-3 py-3 text-center text-xs text-[var(--ink-soft)]">还没有对话</div>
              <button
                v-for="conv in conversations" :key="conv.id"
                @click="selectConversation(conv.id)"
                class="group flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-all"
                :class="currentView === 'chat' && currentConversationId === conv.id ? 'bg-[var(--accent-soft)] text-[var(--accent-strong)]' : 'text-[var(--ink)] hover:bg-[var(--line)]/50'"
              >
                <MessageSquare class="h-3.5 w-3.5 shrink-0 opacity-60" />
                <div class="min-w-0 flex-1">
                  <p class="truncate font-medium">{{ conv.title }}</p>
                  <div class="flex items-center gap-1.5">
                    <span class="subject-tag">{{ subjectLabel(conv.subject).emoji }}{{ subjectLabel(conv.subject).label }}</span>
                    <span class="text-xs text-[var(--ink-soft)]">{{ formatDate(conv.updatedAt) }}</span>
                  </div>
                </div>
                <button @click="(e) => handleDeleteConversation(conv.id, e)" class="opacity-0 rounded-md p-1 text-[var(--ink-soft)] transition-opacity hover:bg-[var(--error)]/10 hover:text-[var(--error)] group-hover:opacity-100" title="删除对话">
                  <Trash2 class="h-3.5 w-3.5" />
                </button>
              </button>
            </div>

            <!-- ═══ 考试 ═══ -->
            <button
              @click="selectSection('exam')"
              class="mt-1 flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left font-display text-sm font-bold transition-all"
              :class="currentView === 'exam' || currentView === 'examReview' ? 'bg-[#e8e4ff] text-[#5848d6]' : 'text-[var(--ink)] hover:bg-[var(--line)]/50'"
            >
              <FileText class="h-4 w-4 shrink-0" />
              <span class="flex-1">考试</span>
              <ChevronDown class="h-4 w-4 shrink-0 transition-transform" :class="expandedSection === 'exam' ? '' : '-rotate-90'" />
            </button>
            <!-- 考试二级菜单 -->
            <div v-if="expandedSection === 'exam'" class="mb-1 mt-1 space-y-0.5 pl-2">
              <button @click="startNewExam" class="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs font-semibold text-[#5848d6] transition-colors hover:bg-[#e8e4ff]">
                <Plus class="h-3.5 w-3.5" /> 新考试
              </button>
              <div v-if="exams.length === 0" class="px-3 py-3 text-center text-xs text-[var(--ink-soft)]">还没有考试记录</div>
              <button
                v-for="ex in exams" :key="ex.examId"
                @click="ex.status === 'completed' ? openExamReview(ex.examId) : startNewExam()"
                class="group flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-all"
                :class="currentView === 'examReview' && selectedExamId === ex.examId ? 'bg-[#e8e4ff] text-[#5848d6]' : 'text-[var(--ink)] hover:bg-[var(--line)]/50'"
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
                <span v-else class="shrink-0 text-[10px] font-semibold text-[#f59e42] group-hover:hidden">未完成</span>
                <button @click="(e) => handleDeleteExam(ex.examId, e)" class="hidden shrink-0 rounded-md p-1 text-[var(--ink-soft)] transition-colors hover:bg-[var(--error)]/10 hover:text-[var(--error)] group-hover:block" title="删除考试">
                  <Trash2 class="h-3.5 w-3.5" />
                </button>
              </button>
            </div>

            <!-- ═══ 档案（知识图谱，无二级菜单）═══ -->
            <button
              @click="selectSection('profile')"
              class="mt-1 flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left font-display text-sm font-bold transition-all"
              :class="currentView === 'profile' ? 'bg-[#d9f4ec] text-[#0e9b76]' : 'text-[var(--ink)] hover:bg-[var(--line)]/50'"
            >
              <BrainCircuit class="h-4 w-4 shrink-0" />
              <span class="flex-1">档案</span>
            </button>
          </div>
        </div>
      </aside>

      <!-- 折叠态下的展开把手（左下角，避免与博文 logo 冲突） -->
      <button
        v-if="!sidebarOpen"
        @click="sidebarOpen = true"
        class="absolute bottom-3 left-2 z-30 flex h-9 w-9 items-center justify-center rounded-full bg-[var(--surface)] shadow-[0_6px_16px_-8px_rgba(86,64,40,0.4)] transition-colors hover:bg-[var(--accent-soft)]"
        title="展开侧栏"
      >
        <ChevronRight class="h-5 w-5 text-[var(--ink-soft)]" />
      </button>

      <!-- 对话模式下的左上角吉祥物（淡入，播放变色动画） -->
      <div
        v-if="hasItems"
        class="fixed z-30 pointer-events-none transition-all duration-500 ease-[cubic-bezier(0.34,1.56,0.64,1)]"
        :style="{
          top: '14px',
          left: sidebarOpen ? '276px' : '20px',
        }"
      >
        <Mascot :size="46" :state="mascotState" :float="true" :animated="true" class="mascot-corner-cycle" />
      </div>

      <!-- 主内容区（min-h-0 + min-w-0：让内部滚动区真正裁切，页面不被内容撑高） -->
      <div class="flex min-h-0 min-w-0 flex-1 flex-col" :data-subject="subject">
        <!-- 对话视图（聊天模式显示） -->
        <template v-if="currentView === 'chat'">
        <!-- 视图切换（淡入淡出过渡） -->
        <Transition name="view-fade" mode="out-in">
          <div class="flex min-h-0 flex-1 flex-col" key="chat-content">
        <!-- 顶栏 -->
        <header
          class="flex items-center gap-3 px-5 py-3.5"
          :class="hasItems ? 'pl-18' : ''"
        >
          <div class="leading-tight">
            <h1 class="brand-text text-2xl font-bold tracking-tight">博文 Boen</h1>
            <p class="text-xs font-semibold text-[var(--ink-soft)]">你的学习小伙伴</p>
          </div>

          <!-- 学科切换 -->
          <div class="ml-auto flex items-center gap-3">
            <div class="clay-sm relative flex bg-[var(--surface)] p-1">
              <span
                class="absolute top-1 bottom-1 left-1 w-16 rounded-[14px] bg-accent"
                :style="{
                  transform: `translateX(calc(${subjectIndex} * 4rem))`,
                  transition: 'transform 0.5s cubic-bezier(0.34, 1.56, 0.64, 1)',
                }"
              ></span>
              <button
                v-for="s in SUBJECT_LABELS"
                :key="s.value"
                @click="handleSubjectChange(s.value)"
                class="relative z-10 flex w-16 items-center justify-center gap-1 rounded-[14px] py-1.5 font-display text-sm font-semibold transition-colors duration-300 cursor-pointer"
                :class="subject === s.value ? 'text-white' : 'text-[var(--ink-soft)] hover:text-[var(--ink)]'"
              >
                <span>{{ s.emoji }}</span>{{ s.label }}
              </button>
            </div>

            <!-- 用户头像 / 菜单 -->
            <div class="user-menu relative">
              <button
                @click="showUserMenu = !showUserMenu"
                class="flex h-9 w-9 items-center justify-center overflow-hidden rounded-full border-2 border-[var(--line)] bg-[var(--surface)] shadow-[0_6px_16px_-8px_rgba(86,64,40,0.4),inset_0_1.5px_0_rgba(255,255,255,0.8)] transition-all hover:border-[var(--accent)] hover:shadow-[0_9px_22px_-8px_var(--accent-glow),inset_0_1.5px_0_rgba(255,255,255,0.8)]"
              >
                <img
                  v-if="currentUser?.picture"
                  :src="currentUser.picture"
                  :alt="currentUser.username"
                  class="h-full w-full object-cover"
                />
                <User v-else class="h-4 w-4 text-[var(--ink-soft)]" />
              </button>

              <!-- 下拉菜单 -->
              <div
                v-if="showUserMenu"
                class="absolute right-0 top-10 z-50 w-56 origin-top-right overflow-hidden rounded-2xl border border-white bg-[var(--surface)] shadow-[0_22px_48px_-22px_rgba(86,64,40,0.5),0_8px_20px_-12px_rgba(86,64,40,0.3),inset_0_2px_0_rgba(255,255,255,0.9)]"
                v-motion
                :initial="{ opacity: 0, scale: 0.95, y: -8 }"
                :enter="{ opacity: 1, scale: 1, y: 0, transition: { duration: 200 } }"
              >
                <div class="px-4 py-3">
                  <p class="text-sm font-semibold text-[var(--ink)]">{{ currentUser?.username ?? '用户' }}</p>
                  <p class="text-xs text-[var(--ink-soft)]">{{ currentUser?.email ?? '' }}</p>
                </div>
                <div class="border-t border-[var(--line)]">
                  <button
                    @click="showSetupDialog = true; showUserMenu = false"
                    class="flex w-full items-center gap-2 px-4 py-2.5 text-sm text-[var(--ink)] transition-colors hover:bg-[var(--accent-soft)]"
                  >
                    <Settings class="h-4 w-4" />
                    <span>设置</span>
                  </button>
                  <button
                    @click="handleLogout"
                    class="flex w-full items-center gap-2 px-4 py-2.5 text-sm text-[var(--error)] transition-colors hover:bg-[var(--error)]/5"
                  >
                    <LogOut class="h-4 w-4" />
                    <span>退出登录</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </header>

        <!-- 消息区域 -->
        <main ref="scroller" class="chat-scroller min-h-0 flex-1 overflow-y-auto px-4" :class="{ 'chat-scroll-fade': hasScrollOverflow }">
          <div class="mx-auto w-full max-w-2xl py-5">
            <!-- 欢迎页 / 消息列表：整块淡入淡出切换，避免逐条 auto-animate 掉帧 -->
            <Transition name="panel" mode="out-in">
            <!-- 欢迎页 -->
            <div v-if="!hasItems" key="welcome" class="flex flex-col items-center gap-5 pt-[8vh] text-center">
              <Mascot :size="120" :state="mascotState" />
              <div>
                <h2 class="font-display text-2xl font-bold">嗨，我是博文！👋</h2>
                <p class="mt-1.5 text-[var(--ink-soft)]">想问什么？开始学习吧～</p>
              </div>
            </div>

            <!-- 消息列表：Hermes Agent 式文字墙 -->
            <div v-else key="list" v-auto-animate class="flex flex-col gap-6">
              <template v-for="(m, i) in items" :key="i">
                <!-- 题目卡片 -->
                <QuestionCard
                  v-if="m.kind === 'question'"
                  :question="m.question"
                  :answered="m.answered"
                  :grading="m.grading"
                  :subject="subject"
                  @submit="(a) => onAnswer(m, a)"
                />

                <!-- 用户消息：无边框文字墙风格 -->
                <div v-else-if="m.kind === 'user'" class="flex flex-col items-end gap-1 anim-fadeUp">
                  <div class="max-w-[85%] text-right">
                    <p class="text-[15px] leading-relaxed text-[var(--ink)]" style="white-space: pre-wrap; word-break: break-word;">
                      {{ m.text }}
                    </p>
                    <span class="mt-1 inline-block text-[10px] text-[var(--ink-soft)]/60">{{ formatTime() }}</span>
                  </div>
                </div>

                <!-- 助手消息：无边框文字墙风格 -->
                <div v-else class="flex flex-col gap-1 anim-fadeUp">
                  <!-- 助手身份标识 -->
                  <div class="flex items-center gap-2">
                    <Mascot :size="24" :float="false" :animated="false" />
                    <span class="text-xs font-semibold text-[var(--accent)]">博文</span>
                  </div>
                  <!-- 内容（严格 timeline：文本在上→出题指示/打字态在下） -->
                  <div class="pl-8">
                    <div v-if="m.text" class="stream-wrap" :class="{ 'is-streaming': !m.done }">
                      <div class="md-body text-[15px] leading-relaxed" v-html="renderMarkdown(m.text)"></div>
                    </div>
                    <!-- 正在出题提示（出题信号触发即显示，无需等流结束） -->
                    <div v-if="i === items.length - 1 && isGeneratingQuiz" class="quiz-gen clay-sm">
                      <div class="quiz-gen-inner">
                        <span class="quiz-gen-icon">
                          <PencilLine class="h-4 w-4" />
                        </span>
                        <span class="quiz-gen-label">博文正在出题</span>
                        <span class="quiz-gen-dots"><span></span><span></span><span></span></span>
                      </div>
                    </div>
                    <TypingDots v-else-if="i === items.length - 1 && showTyping && !m.text" />
                  </div>
                </div>
              </template>
            </div>
            </Transition>
          </div>
        </main>
      </div>
    </Transition>

        <!-- 输入区 -->
        <footer class="px-4 pb-4 pt-1">
          <div class="mx-auto w-full max-w-2xl">
            <!-- 学习模式（聊天内子模式：预填「我想学习」引导）。考试/档案已移至侧栏 -->
            <div class="mb-2 flex items-center gap-1.5 px-1">
              <button @click="activateMode('review')" class="flex items-center gap-1.5 rounded-2xl border px-3.5 py-1.5 text-xs font-semibold shadow-[0_4px_10px_-6px_rgba(86,64,40,0.2)] transition-all active:scale-[0.96]" :class="activeMode === 'review' ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent-strong)]' : 'border-[var(--line)] bg-white/70 text-[var(--ink)] hover:border-[var(--accent)] hover:bg-[var(--accent-soft)] hover:text-[var(--accent-strong)]'"><GraduationCap class="h-3.5 w-3.5" /><span>学习模式</span></button>
              <button @click="activateMode('preview')" class="flex items-center gap-1.5 rounded-2xl border px-3.5 py-1.5 text-xs font-semibold shadow-[0_4px_10px_-6px_rgba(86,64,40,0.2)] transition-all active:scale-[0.96]" :class="activeMode === 'preview' ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent-strong)]' : 'border-[var(--line)] bg-white/70 text-[var(--ink)] hover:border-[var(--accent)] hover:bg-[var(--accent-soft)] hover:text-[var(--accent-strong)]'"><BookOpen class="h-3.5 w-3.5" /><span>预习模式</span></button>
              <button @click="activateMode('weakness')" class="flex items-center gap-1.5 rounded-2xl border px-3.5 py-1.5 text-xs font-semibold shadow-[0_4px_10px_-6px_rgba(86,64,40,0.2)] transition-all active:scale-[0.96]" :class="activeMode === 'weakness' ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent-strong)]' : 'border-[var(--line)] bg-white/70 text-[var(--ink)] hover:border-[var(--accent)] hover:bg-[var(--accent-soft)] hover:text-[var(--accent-strong)]'"><Target class="h-3.5 w-3.5" /><span>突破模式</span></button>
              <!-- 专项练习（hover 展开二级菜单） -->
              <div v-if="practiceMenu.length" class="relative inline-block group">
                <button class="flex items-center gap-1.5 rounded-2xl border border-[var(--line)] bg-white/70 px-3.5 py-1.5 text-xs font-semibold text-[var(--ink)] shadow-[0_4px_10px_-6px_rgba(86,64,40,0.2)] transition-all hover:border-[var(--accent)] hover:bg-[var(--accent-soft)] hover:text-[var(--accent-strong)] active:scale-[0.96]"><PenTool class="h-3.5 w-3.5" /><span>专项练习</span></button>
                <div class="absolute left-0 top-full z-50 mt-1 min-w-[140px] origin-top scale-95 opacity-0 transition-all duration-150 ease-out group-hover:scale-100 group-hover:opacity-100 pointer-events-none group-hover:pointer-events-auto">
                  <div class="clay-sm flex flex-col gap-0.5 p-1.5 shadow-lg">
                    <button v-for="p in practiceMenu" :key="p.type" @click="startPractice(p.type, p.hint)" class="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-xs font-medium text-[var(--ink)] transition-colors hover:bg-[var(--accent-soft)] hover:text-[var(--accent-strong)] whitespace-nowrap">{{ p.label }}</button>
                  </div>
                </div>
              </div>
            </div>
            <div class="clay flex items-end gap-2 p-2">
              <textarea
                v-model="input"
                @keydown="onKeydown"
                rows="1"
                placeholder="今天想学习什么？"
                class="max-h-32 flex-1 resize-none bg-transparent px-3 py-2.5 text-[15px] placeholder:text-[var(--ink-soft)]/70 focus:outline-none"
              />
              <button
                @click="send(input)"
                :disabled="busy || !input.trim()"
                class="btn-accent grid h-11 w-11 shrink-0 place-items-center rounded-[18px]"
                aria-label="发送"
              >
                <Sparkles v-if="busy" class="h-5 w-5 animate-spin" />
                <Send v-else class="h-5 w-5" />
              </button>
            </div>
          </div>
        </footer>
        </template>

        <!-- 档案（学习画像 / 知识图谱）视图 -->
        <KnowledgeProfile v-else-if="currentView === 'profile'" key="profile" class="flex-1" @back="currentView = 'chat'" @practice="handlePractice" />

        <!-- 考试视图（出卷 / 答题），:key 递增可重挂以开始新考试 -->
        <ExamView v-else-if="currentView === 'exam'" :key="`exam-${examViewKey}`" class="flex-1" @back="currentView = 'chat'" @refresh="loadExams" />

        <!-- 考试回顾视图 -->
        <ExamReview v-else-if="currentView === 'examReview'" key="examReview" class="flex-1" :exam-id="selectedExamId" @back="currentView = 'chat'" />
      </div>
    </div>

    <!-- 常驻吉祥物（右下角浮动） -->
    <div
      v-if="hasItems"
      class="fixed bottom-16 right-5 z-20 transition-all duration-500"
      :class="busy ? 'opacity-100 translate-y-0' : 'opacity-90 translate-y-1'"
    >
      <div class="relative drop-shadow-[0_12px_20px_rgba(86,64,40,0.28)]">
        <Mascot :size="96" :float="true" :limbs="true" :state="mascotState" />
      </div>
    </div>
  </div>
</template>
