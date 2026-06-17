// 博文 Boen —— 前后端共享类型

/** 三个面向的年龄段 */
export type GradeBand = 'primary' | 'middle' | 'undergrad';

/** 智能体工作模式（阶段 0 只用到 qa，其余为后续阶段预留） */
export type BoenMode = 'qa' | 'review' | 'ai-learning';

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

/** POST /api/chat 请求体 */
export interface ChatRequest {
  /** 会话 id，用于续接多轮对话（checkpointer thread） */
  threadId: string;
  /** 本轮用户输入 */
  message: string;
  /** 用户画像：年龄段，驱动用词/难度适配 */
  gradeBand: GradeBand;
  /** 用户名（用于智能体个性化称呼） */
  userName?: string;
  /** 期望模式，缺省时由 Router 自动判定 */
  mode?: BoenMode;
}

// ─────────────────────────────────────────────────────────────
// 测评（answer card）模块 —— 对话内嵌入式答题，可被各功能高频复用
// ─────────────────────────────────────────────────────────────

export type QuestionType = 'multiple_choice' | 'fill_blank' | 'true_false' | 'short_answer';
export type Difficulty = 'easy' | 'medium' | 'hard';

interface BaseQuestion {
  type: QuestionType;
  /** 题干（填空题用 ____ 表示每个空） */
  stem: string;
  /** 阅读材料（语文/英语阅读理解题专用），渲染为特殊字体块 */
  passage?: string;
  knowledgePoint?: string;
  difficulty?: Difficulty;
}

/** 发给前端渲染的题目（已剥离标准答案） */
export type QuestionPayload =
  | (BaseQuestion & {
      type: 'multiple_choice';
      options: { key: string; text: string }[];
      /** 是否多选 */
      multiSelect: boolean;
    })
  | (BaseQuestion & { type: 'fill_blank'; blankCount: number })
  | (BaseQuestion & { type: 'true_false' })
  | (BaseQuestion & { type: 'short_answer' });

/** 前端回传的用户作答 */
export type AnswerPayload =
  | { type: 'multiple_choice'; selectedKeys: string[] }
  | { type: 'fill_blank'; answers: string[] }
  | { type: 'true_false'; value: boolean }
  | { type: 'short_answer'; text: string };

/** 判分结果（short_answer 的 correct 为 null，由模型定性反馈） */
export interface GradingResult {
  correct: boolean | null;
  score: number;
  maxScore: number;
  /** 可读的标准答案 */
  reference: string;
  explanation: string;
  /** 填空题逐空对错 */
  perBlank?: boolean[];
}

/** POST /api/answer 请求体 */
export interface AnswerRequest {
  threadId: string;
  /** 对应 question 事件里的 toolCallId */
  toolCallId: string;
  answer: AnswerPayload;
  /** 所属对话 ID，用于持久化判分结果（可选，兼容旧客户端） */
  conversationId?: string;
}

/** SSE 事件：服务端推送给前端的流式事件 */
export type SseEvent =
  | { type: 'token'; value: string }
  | { type: 'mode'; value: BoenMode }
  | { type: 'question'; toolCallId: string; question: QuestionPayload }
  | { type: 'grading'; toolCallId: string; result: GradingResult }
  | { type: 'title_updated'; conversationId: string; title: string }
  | { type: 'done' }
  | { type: 'error'; message: string };
