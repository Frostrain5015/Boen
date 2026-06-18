import type { ChatRequest, AnswerRequest, SseEvent, ExamSummary, ExamReviewDetail } from '@boen/shared';
import { getToken } from './auth';

/** 通用 SSE 流读取：POST body，逐事件回调 */
async function streamSse(
  url: string,
  body: unknown,
  onEvent: (e: SseEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const token = getToken();
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.body) throw new Error('无响应流');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';
    for (const frame of frames) {
      const line = frame.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      try {
        onEvent(JSON.parse(line.slice(5).trim()) as SseEvent);
      } catch {
        /* 忽略心跳/非 JSON 帧 */
      }
    }
  }
}

/** 发起一轮对话 */
export const streamChat = (req: ChatRequest & { conversationId?: string; subject?: string; userName?: string }, onEvent: (e: SseEvent) => void) =>
  streamSse('/api/chat', req, onEvent);

/** 提交一道题的作答 */
export const streamAnswer = (req: AnswerRequest, onEvent: (e: SseEvent) => void) =>
  streamSse('/api/answer', req, onEvent);

/** 生成试卷（流式：实时推送 规划→出题→审核 进度） */
export const streamExamGenerate = (
  config: { subject: string; grade: string; durationMinutes: number; notes?: string },
  onEvent: (e: SseEvent) => void,
) => streamSse('/api/exam/generate', config, onEvent);

// ── 对话管理 API ────────────────────────────

export interface Conversation {
  id: string;
  userId: string;
  title: string;
  subject: string;
  createdAt: number;
  updatedAt: number;
}

export interface ConversationMessage {
  id: number;
  conversationId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: number;
}

async function apiFetch<T>(url: string, options?: RequestInit): Promise<T> {
  const token = getToken();
  const res = await fetch(url, {
    ...options,
    headers: {
      ...(options?.headers ?? {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(err);
  }
  return res.json() as Promise<T>;
}

/** 获取用户的所有对话 */
export async function getConversations(): Promise<{ conversations: Conversation[] }> {
  return apiFetch('/api/conversations');
}

/** 创建新对话 */
export async function createConversation(title?: string, subject?: string): Promise<{ conversation: Conversation }> {
  return apiFetch('/api/conversations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: title ?? '新对话', subject: subject ?? 'math' }),
  });
}

/** 获取单个对话 */
export async function getConversation(id: string): Promise<{ conversation: Conversation; messages: ConversationMessage[] }> {
  return apiFetch(`/api/conversations/${id}`);
}

/** 更新对话标题 */
export async function updateConversationTitle(id: string, title: string): Promise<void> {
  await apiFetch(`/api/conversations/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  });
}

/** 删除对话 */
export async function deleteConversation(id: string): Promise<void> {
  await apiFetch(`/api/conversations/${id}`, { method: 'DELETE' });
}

// ── 考试历史 API ────────────────────────────

/** 获取当前用户的考试历史列表 */
export async function listExams(): Promise<{ exams: ExamSummary[] }> {
  return apiFetch('/api/exams');
}

/** 获取单场考试的回顾详情（含题目、用户作答、评分） */
export async function getExamReview(examId: string): Promise<{ exam: ExamReviewDetail }> {
  return apiFetch(`/api/exam/${examId}`);
}

/** 删除一场考试（任意状态） */
export async function deleteExam(examId: string): Promise<void> {
  await apiFetch(`/api/exam/${examId}`, { method: 'DELETE' });
}
