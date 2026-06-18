import type {
  AnalyzeMistakeEvent,
  ChatRequest,
  AnswerRequest,
  SseEvent,
  ExamSummary,
  ExamReviewDetail,
  MistakeDetailResponse,
  MistakeItem,
  MistakeListResponse,
  MistakeSourceType,
} from '@boen/shared';
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
  config: { subject: string; grade: string; durationMinutes: number; notes?: string; totalScore?: number },
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

async function streamAuthorizedSse(
  url: string,
  options: RequestInit,
  onEvent: (e: AnalyzeMistakeEvent) => void,
): Promise<void> {
  const token = getToken();
  const res = await fetch(url, {
    ...options,
    headers: {
      ...(options.headers ?? {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!res.ok) throw new Error(await res.text());
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
        onEvent(JSON.parse(line.slice(5).trim()) as AnalyzeMistakeEvent);
      } catch {
        /* ignore malformed SSE frame */
      }
    }
  }
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

// ── 错题本 API ─────────────────────────────────────────────

export async function listMistakes(params?: { subject?: string; grade?: string; status?: string; limit?: number }): Promise<MistakeListResponse> {
  const query = new URLSearchParams();
  if (params?.subject) query.set('subject', params.subject);
  if (params?.grade) query.set('grade', params.grade);
  if (params?.status) query.set('status', params.status);
  if (params?.limit) query.set('limit', String(params.limit));
  const suffix = query.toString() ? `?${query}` : '';
  return apiFetch(`/api/mistakes${suffix}`);
}

export async function createTextMistake(payload: {
  sourceType?: MistakeSourceType;
  subject: string;
  grade: string;
  promptText: string;
  studentAnswer?: string;
  note?: string;
}): Promise<{ mistake: MistakeItem }> {
  return apiFetch('/api/mistakes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, sourceType: payload.sourceType ?? 'text' }),
  });
}

export async function createImageMistake(payload: {
  sourceType: 'image';
  subject: string;
  grade: string;
  file: File | Blob;
  filename?: string;
  studentAnswer?: string;
  note?: string;
}): Promise<{ mistake: MistakeItem }> {
  const form = new FormData();
  form.set('sourceType', payload.sourceType);
  form.set('subject', payload.subject);
  form.set('grade', payload.grade);
  if (payload.studentAnswer) form.set('studentAnswer', payload.studentAnswer);
  if (payload.note) form.set('note', payload.note);
  form.set('image', payload.file, payload.filename ?? 'mistake.png');
  return apiFetch('/api/mistakes', { method: 'POST', body: form });
}

export const streamMistakeAnalyze = (mistakeId: string, onEvent: (e: AnalyzeMistakeEvent) => void) =>
  streamAuthorizedSse(`/api/mistakes/${mistakeId}/analyze`, { method: 'POST' }, onEvent);

export async function getMistake(mistakeId: string): Promise<MistakeDetailResponse> {
  return apiFetch(`/api/mistakes/${mistakeId}`);
}

export async function updateMistake(mistakeId: string, patch: Partial<Pick<MistakeItem, 'promptText' | 'studentAnswer' | 'correctAnswer' | 'errorReason'>>): Promise<{ mistake: MistakeItem }> {
  return apiFetch(`/api/mistakes/${mistakeId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

export async function deleteMistake(mistakeId: string): Promise<void> {
  await apiFetch(`/api/mistakes/${mistakeId}`, { method: 'DELETE' });
}

export async function getMistakePracticePrompt(mistakeId: string): Promise<{ prompt: string }> {
  return apiFetch(`/api/mistakes/${mistakeId}/practice`, { method: 'POST' });
}

export async function fetchMistakeAssetObjectUrl(mistakeId: string, assetId: number): Promise<string> {
  const token = getToken();
  const res = await fetch(`/api/mistakes/${mistakeId}/assets/${assetId}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(await res.text());
  return URL.createObjectURL(await res.blob());
}
