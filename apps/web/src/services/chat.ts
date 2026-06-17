import type { ChatRequest, AnswerRequest, SseEvent } from '@boen/shared';

/** 通用 SSE 流读取：POST body，逐事件回调 */
async function streamSse(
  url: string,
  body: unknown,
  onEvent: (e: SseEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
export const streamChat = (req: ChatRequest, onEvent: (e: SseEvent) => void) =>
  streamSse('/api/chat', req, onEvent);

/** 提交一道题的作答 */
export const streamAnswer = (req: AnswerRequest, onEvent: (e: SseEvent) => void) =>
  streamSse('/api/answer', req, onEvent);
