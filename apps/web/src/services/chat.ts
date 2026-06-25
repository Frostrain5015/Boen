import type {
  AnalyzeMistakeEvent,
  AnswerPayload,
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

export class StreamInterruptedError extends Error {
  constructor(readonly receivedEvents: boolean) {
    super('流式连接在服务端确认完成前中断');
    this.name = 'StreamInterruptedError';
  }
}

// ── 401 未授权回调 ─────────────────────────────
// 由 authStore 在初始化时注册，避免 Pinia ↔ 服务层的循环依赖
let _onUnauthorized: (() => void) | null = null;
export function setOnUnauthorized(cb: () => void) {
  _onUnauthorized = cb;
}

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

  // 非 2xx 响应（如 429 限额、401 未认证）：解析 JSON 错误体并抛出
  if (!res.ok) {
    // 401 → token 过期，触发自动登出
    if (res.status === 401) {
      _onUnauthorized?.();
      throw new Error('认证已过期，请重新登录');
    }
    try {
      const errBody = await res.json() as Record<string, unknown>;
      const err = new Error(errBody.message as string || `请求失败 (${res.status})`);
      (err as any).status = res.status;
      (err as any).body = errBody;
      throw err;
    } catch (e) {
      if ((e as any).status) throw e; // 重新抛出已构造的错误
      throw new Error(`请求失败 (${res.status})`);
    }
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let receivedEvents = false;
  let completed = false;

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
        const event = JSON.parse(line.slice(5).trim()) as SseEvent;
        receivedEvents = true;
        if (event.type === 'done') completed = true;
        onEvent(event);
      } catch {
        /* 忽略心跳/非 JSON 帧 */
      }
    }
  }
  if (!completed) throw new StreamInterruptedError(receivedEvents);
}

/** 发起一轮对话 */
export const streamChat = (req: ChatRequest & { conversationId?: string; subject?: string; userName?: string }, onEvent: (e: SseEvent) => void) =>
  streamSse('/api/chat', req, onEvent);

/** 提交一道题的作答 */
export const streamAnswer = (req: AnswerRequest, onEvent: (e: SseEvent) => void) =>
  streamSse('/api/answer', req, onEvent);

/** 生成试卷（流式：实时推送 规划→出题→审核 进度） */
export const streamExamGenerate = (
  config: { subject: string; grade: string; durationMinutes: number; notes?: string; totalScore?: number; examId?: string },
  onEvent: (e: SseEvent) => void,
  signal?: AbortSignal,
) => streamSse('/api/exam/generate', config, onEvent, signal);

/** 预创建空白考试记录（立即返回 examId，用于断线恢复） */
export async function createEmptyExam(config: { subject: string; grade: string; durationMinutes?: number; notes?: string }): Promise<{ examId: string }> {
  return apiFetch('/api/exam', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
}

export const streamExamSubmit = (
  req: { examId: string; answers: Array<{ questionIndex: number; answer: AnswerPayload }> },
  onEvent: (e: SseEvent) => void,
  signal?: AbortSignal,
) => streamSse('/api/exam/submit/stream', req, onEvent, signal);

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
  // 401 → token 过期，触发自动登出
  if (res.status === 401) {
    _onUnauthorized?.();
    throw new Error('认证已过期，请重新登录');
  }
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
  console.log('[SSE] 开始请求', url);
  const res = await fetch(url, {
    ...options,
    headers: {
      ...(options.headers ?? {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!res.ok) {
    // 401 → token 过期，触发自动登出
    if (res.status === 401) {
      _onUnauthorized?.();
      throw new Error('认证已过期，请重新登录');
    }
    const errText = await res.text();
    console.error('[SSE] HTTP 错误', res.status, errText);
    throw new Error(errText);
  }
  if (!res.body) throw new Error('无响应流');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let eventCount = 0;
  let hasError = false;
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
        const parsed = JSON.parse(line.slice(5).trim());
        eventCount++;
        if (parsed.type === 'error') {
          console.error('[SSE] 服务端错误:', parsed.message);
          hasError = true;
          throw new Error(parsed.message || '分析失败');
        }
        if (parsed.type !== 'mistake_progress' && parsed.type !== 'mistake_ready' && parsed.type !== 'done') {
          console.log('[SSE] 未知事件类型:', parsed.type, parsed);
        }
        onEvent(parsed as AnalyzeMistakeEvent);
      } catch (e) {
        if ((e as any)?.message?.startsWith('分析失败') || (e as any)?.message?.includes('OCR')) throw e;
        /* ignore malformed SSE frame */
      }
    }
  }
  console.log('[SSE] 流结束, 共', eventCount, '个事件, hasError=', hasError);
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

export async function listMistakes(params?: { subject?: string; grade?: string; status?: string; limit?: number; includeCorrect?: boolean }): Promise<MistakeListResponse> {
  const query = new URLSearchParams();
  if (params?.subject) query.set('subject', params.subject);
  if (params?.grade) query.set('grade', params.grade);
  if (params?.status) query.set('status', params.status);
  if (params?.limit) query.set('limit', String(params.limit));
  if (params?.includeCorrect) query.set('includeCorrect', '1');
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
