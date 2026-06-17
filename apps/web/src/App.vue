<script setup lang="ts">
import { ref, computed, nextTick, onMounted } from 'vue';
import { Send, Sparkles, LogOut, User, Plus, Trash2, MessageSquare, ChevronLeft, ChevronRight } from 'lucide-vue-next';
import { renderMarkdown } from '@/lib/markdown';
import type { QuestionPayload, AnswerPayload, GradingResult, SseEvent } from '@boen/shared';
import { streamChat, streamAnswer, getConversations, createConversation, deleteConversation, type Conversation } from '@/services/chat';
import { isAuthenticated, getCurrentUser, logout, type FrostUser } from '@/services/auth';
import QuestionCard from '@/components/QuestionCard.vue';
import Mascot from '@/components/Mascot.vue';
import TypingDots from '@/components/TypingDots.vue';
import LoginView from '@/components/LoginView.vue';
import OAuthCallback from '@/components/OAuthCallback.vue';
import type { MascotState } from '@/components/Mascot.vue';

type Subject = 'chinese' | 'math' | 'english' | 'science';

type ChatItem =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string; chunks: string[]; done: boolean }
  | { kind: 'question'; toolCallId: string; question: QuestionPayload; answered: boolean; grading?: GradingResult };

const newAssistant = (text = ''): ChatItem => ({ kind: 'assistant', text, chunks: text ? [text] : [], done: false });

const SUBJECT_LABELS: { value: Subject; label: string; emoji: string }[] = [
  { value: 'chinese', label: '语文', emoji: '📖' },
  { value: 'math', label: '数学', emoji: '🔢' },
  { value: 'english', label: '英语', emoji: '🔤' },
  { value: 'science', label: '科学', emoji: '🔬' },
];
const QUICK_CHIPS = ['考我一道选择题', '出一道判断题', '讲讲三角形的面积', '帮我复习光合作用'];

// ── 认证状态 ──────────────────────────────
const authChecked = ref(false);
const authenticated = ref(false);
const currentUser = ref<FrostUser | null>(null);
const showUserMenu = ref(false);

// 检查当前路径是否是 OAuth 回调
const isOAuthCallback = computed(() => window.location.pathname === '/auth/callback');

// ── 对话管理 ──────────────────────────────
const conversations = ref<Conversation[]>([]);
const currentConversationId = ref<string | null>(null);
const sidebarOpen = ref(true);

// ── 聊天状态 ──────────────────────────────
const items = ref<ChatItem[]>([]);
const input = ref('');
const subject = ref<Subject>('math');
const busy = ref(false);
const threadId = `web-${Date.now()}`;
const scroller = ref<HTMLElement | null>(null);

const hasItems = computed(() => items.value.length > 0);
const subjectIndex = computed(() => SUBJECT_LABELS.findIndex((s) => s.value === subject.value));
const showTyping = computed(() => {
  const last = items.value[items.value.length - 1];
  return busy.value && last?.kind === 'assistant' && !last.text;
});

/** 根据当前状态计算吉祥物动画 */
const mascotState = computed<MascotState>(() => {
  if (busy.value && showTyping.value) return 'thinking';
  if (busy.value) return 'listening';
  const last = items.value[items.value.length - 1];
  if (last?.kind === 'question' && last.grading) {
    return last.grading.correct ? 'happy' : 'surprise';
  }
  return 'idle';
});

function scrollDown() {
  nextTick(() => {
    requestAnimationFrame(() => {
      const el = scroller.value;
      if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    });
  });
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
      cur.chunks.push(e.value);
    }
  } else if (e.type === 'question') {
    const cur = items.value[idx.value];
    if (cur && cur.kind === 'assistant' && !cur.text.trim()) items.value.splice(idx.value, 1);
    items.value.push({ kind: 'question', toolCallId: e.toolCallId, question: e.question, answered: false });
    idx.value = -1;
  } else if (e.type === 'grading') {
    const q = items.value.find((it) => it.kind === 'question' && it.toolCallId === e.toolCallId);
    if (q && q.kind === 'question') q.grading = e.result;
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
}

async function send(text: string) {
  const t = text.trim();
  if (!t || busy.value) return;
  input.value = '';
  busy.value = true;
  items.value.push({ kind: 'user', text: t });
  items.value.push(newAssistant());
  const idx = { value: items.value.length - 1 };
  scrollDown();
  try {
    await streamChat(
      { threadId, message: t, gradeBand: 'middle', subject: subject.value, conversationId: currentConversationId.value ?? undefined },
      (e) => handleEvent(e, idx),
    );
  } catch (err) {
    items.value.push(newAssistant(`⚠️ 请求失败：${err instanceof Error ? err.message : String(err)}`));
  } finally {
    finalizeAssistants();
    busy.value = false;
  }
}

async function onAnswer(item: Extract<ChatItem, { kind: 'question' }>, answer: AnswerPayload) {
  if (item.answered || busy.value) return;
  item.answered = true;
  busy.value = true;
  const idx = { value: -1 };
  try {
    await streamAnswer({ threadId, toolCallId: item.toolCallId, answer }, (e) => handleEvent(e, idx));
  } catch (err) {
    items.value.push(newAssistant(`⚠️ 提交失败：${err instanceof Error ? err.message : String(err)}`));
  } finally {
    finalizeAssistants();
    busy.value = false;
  }
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send(input.value);
  }
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

async function handleNewConversation() {
  try {
    const { conversation } = await createConversation('新对话', subject.value);
    conversations.value.unshift(conversation);
    currentConversationId.value = conversation.id;
    items.value = [];
  } catch {
    // 忽略创建失败
  }
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
}

function selectConversation(id: string) {
  currentConversationId.value = id;
  items.value = [];
}

// ── 认证相关 ──────────────────────────────
async function checkAuth() {
  if (isOAuthCallback.value) return;
  const auth = isAuthenticated();
  authenticated.value = auth;
  if (auth) {
    currentUser.value = await getCurrentUser();
    await loadConversations();
  }
  authChecked.value = true;
}

function handleOAuthSuccess() {
  authenticated.value = true;
  getCurrentUser().then((user) => {
    currentUser.value = user;
  });
  loadConversations();
}

function handleLogout() {
  logout();
}

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
});
</script>

<template>
  <!-- OAuth 回调页面 -->
  <OAuthCallback
    v-if="isOAuthCallback"
    @success="handleOAuthSuccess"
    @error="() => { authChecked = true; authenticated = false; }"
  />

  <!-- 登录页面 -->
  <LoginView v-else-if="authChecked && !authenticated" />

  <!-- 主应用 -->
  <div v-else class="relative flex h-full flex-col">
    <div class="app-bg"></div>
    <div class="app-grain"></div>

    <div class="relative z-10 flex h-full">
      <!-- 侧边栏：对话列表 -->
      <aside
        class="flex h-full flex-col border-r border-[var(--line)] bg-[var(--surface)]/80 backdrop-blur-sm transition-all duration-300"
        :class="sidebarOpen ? 'w-64' : 'w-0 overflow-hidden'"
      >
        <!-- 侧边栏头部 -->
        <div class="flex items-center justify-between border-b border-[var(--line)] p-3">
          <h2 class="font-display text-sm font-bold text-[var(--ink)]">对话历史</h2>
          <button
            @click="handleNewConversation"
            class="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--accent)] text-white transition-transform hover:scale-105"
            title="新建对话"
          >
            <Plus class="h-4 w-4" />
          </button>
        </div>

        <!-- 对话列表 -->
        <div class="flex-1 overflow-y-auto p-2">
          <div v-if="conversations.length === 0" class="py-8 text-center text-sm text-[var(--ink-soft)]">
            <MessageSquare class="mx-auto mb-2 h-8 w-8 opacity-40" />
            <p>还没有对话</p>
            <p class="mt-1 text-xs">点击上方 + 开始新对话</p>
          </div>
          <div v-else class="flex flex-col gap-1">
            <button
              v-for="conv in conversations"
              :key="conv.id"
              @click="selectConversation(conv.id)"
              class="group flex items-center gap-2 rounded-xl px-3 py-2.5 text-left text-sm transition-all"
              :class="
                currentConversationId === conv.id
                  ? 'bg-[var(--accent-soft)] text-[var(--accent-strong)]'
                  : 'text-[var(--ink)] hover:bg-[var(--line)]/50'
              "
            >
              <MessageSquare class="h-4 w-4 shrink-0" />
              <div class="min-w-0 flex-1">
                <p class="truncate font-medium">{{ conv.title }}</p>
                <p class="text-xs text-[var(--ink-soft)]">{{ formatDate(conv.updatedAt) }}</p>
              </div>
              <button
                @click="(e) => handleDeleteConversation(conv.id, e)"
                class="opacity-0 rounded-md p-1 text-[var(--ink-soft)] transition-opacity hover:bg-[var(--error)]/10 hover:text-[var(--error)] group-hover:opacity-100"
                title="删除对话"
              >
                <Trash2 class="h-3.5 w-3.5" />
              </button>
            </button>
          </div>
        </div>
      </aside>

      <!-- 主内容区 -->
      <div class="flex flex-1 flex-col" :data-subject="subject">
        <!-- 顶栏 -->
        <header
          class="flex items-center gap-3 px-5 py-3.5"
          v-motion
          :initial="{ opacity: 0, y: -20 }"
          :enter="{ opacity: 1, y: 0, transition: { duration: 500 } }"
        >
          <!-- 侧边栏切换 -->
          <button
            @click="sidebarOpen = !sidebarOpen"
            class="flex h-9 w-9 items-center justify-center rounded-full transition-colors hover:bg-[var(--line)]/50"
          >
            <ChevronLeft v-if="sidebarOpen" class="h-5 w-5 text-[var(--ink-soft)]" />
            <ChevronRight v-else class="h-5 w-5 text-[var(--ink-soft)]" />
          </button>

          <Mascot :size="46" :state="mascotState" />
          <div class="leading-tight">
            <h1 class="brand-text text-2xl font-bold tracking-tight">博文 Boen</h1>
            <p class="text-xs font-semibold text-[var(--ink-soft)]">你的学习小伙伴</p>
          </div>

          <!-- 学科切换 -->
          <div class="ml-auto flex items-center gap-3">
            <div class="clay-sm relative flex bg-[var(--surface)] p-1">
              <span
                class="absolute top-1 bottom-1 rounded-[14px] bg-accent transition-transform duration-400"
                :style="{ width: 'calc((100% - 0.75rem) / 4)', transform: `translateX(calc(${subjectIndex} * 100%))` }"
                style="transition-timing-function: cubic-bezier(0.34, 1.56, 0.64, 1)"
              ></span>
              <button
                v-for="s in SUBJECT_LABELS"
                :key="s.value"
                @click="subject = s.value"
                class="relative z-10 flex w-14 items-center justify-center gap-1 rounded-[14px] py-1.5 font-display text-sm font-semibold transition-colors duration-300 cursor-pointer"
                :class="subject === s.value ? 'text-white' : 'text-[var(--ink-soft)] hover:text-[var(--ink)]'"
              >
                <span>{{ s.emoji }}</span>{{ s.label }}
              </button>
            </div>

            <!-- 用户头像 / 菜单 -->
            <div class="user-menu relative">
              <button
                @click="showUserMenu = !showUserMenu"
                class="flex h-9 w-9 items-center justify-center overflow-hidden rounded-full border-2 border-[var(--line)] bg-[var(--surface)] transition-all hover:border-[var(--accent)]"
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
                class="absolute right-0 top-10 z-50 w-56 origin-top-right overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--surface)] shadow-xl"
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
        <main ref="scroller" class="flex-1 overflow-y-auto px-4">
          <div class="mx-auto w-full max-w-2xl py-5">
            <!-- 欢迎页 -->
            <div v-if="!hasItems" class="flex flex-col items-center gap-5 pt-[8vh] text-center anim-fadeUp">
              <Mascot :size="120" :state="mascotState" />
              <div>
                <h2 class="font-display text-2xl font-bold">嗨，我是博文！👋</h2>
                <p class="mt-1.5 text-[var(--ink-soft)]">问我问题，或者说一句「考我一道题」来练习吧～</p>
              </div>
              <div class="flex max-w-md flex-wrap justify-center gap-2.5">
                <button
                  v-for="(chip, i) in QUICK_CHIPS"
                  :key="chip"
                  @click="send(chip)"
                  class="clay-sm cursor-pointer bg-[var(--surface)] px-4 py-2 text-sm font-semibold transition-transform hover:-translate-y-1"
                  v-motion
                  :initial="{ opacity: 0, y: 14 }"
                  :enter="{ opacity: 1, y: 0, transition: { delay: 200 + i * 90 } }"
                >
                  {{ chip }}
                </button>
              </div>
            </div>

            <!-- 消息列表：Hermes Agent 式文字墙 -->
            <div v-auto-animate class="flex flex-col gap-6">
              <template v-for="(m, i) in items" :key="i">
                <!-- 题目卡片 -->
                <QuestionCard
                  v-if="m.kind === 'question'"
                  :question="m.question"
                  :answered="m.answered"
                  :grading="m.grading"
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
                    <Mascot :size="24" :float="false" :state="mascotState" />
                    <span class="text-xs font-semibold text-[var(--accent)]">博文</span>
                  </div>
                  <!-- 内容 -->
                  <div class="pl-8">
                    <TypingDots v-if="i === items.length - 1 && showTyping" />
                    <div v-else-if="!m.done" class="md-body stream-text text-[15px] leading-relaxed">
                      <span v-for="(c, ci) in m.chunks" :key="ci" class="tok">{{ c }}</span>
                    </div>
                    <div v-else class="md-body text-[15px] leading-relaxed" v-html="renderMarkdown(m.text || '…')"></div>
                  </div>
                </div>
              </template>
            </div>
          </div>
        </main>

        <!-- 输入区 -->
        <footer class="px-4 pb-4 pt-1">
          <div class="mx-auto w-full max-w-2xl">
            <div v-if="hasItems" class="mb-2.5 flex gap-2 overflow-x-auto pb-1">
              <button
                v-for="chip in QUICK_CHIPS"
                :key="chip"
                @click="send(chip)"
                :disabled="busy"
                class="shrink-0 cursor-pointer rounded-full border border-[var(--line)] bg-[var(--surface)]/80 px-3.5 py-1.5 text-xs font-semibold text-[var(--ink-soft)] backdrop-blur transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
              >
                {{ chip }}
              </button>
            </div>

            <div class="clay flex items-end gap-2 p-2">
              <textarea
                v-model="input"
                @keydown="onKeydown"
                rows="1"
                placeholder="输入问题，或说「考我一道选择题」…"
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
      </div>
    </div>

    <!-- 常驻吉祥物（右下角浮动） -->
    <div
      v-if="hasItems"
      class="fixed bottom-20 right-4 z-20 transition-all duration-500"
      :class="busy ? 'opacity-100 translate-y-0' : 'opacity-60 translate-y-2'"
    >
      <div class="relative">
        <Mascot :size="48" :float="true" :state="mascotState" />
        <!-- 状态指示器小点 -->
        <span
          class="absolute -top-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-[var(--paper)]"
          :class="busy ? 'bg-accent animate-pulse' : 'bg-[var(--success)]'"
        ></span>
      </div>
    </div>
  </div>
</template>
