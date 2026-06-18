// 博文 Boen —— 前后端共享类型

/** 三个面向的年龄段（驱动语气/深度） */
export type GradeBand = 'primary' | 'middle' | 'undergrad';

/** 具体年级：义务教育 1–9 年级细化 + 高中/大学粗档 */
export type Grade = '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | 'high' | 'college';

/** 具体年级 → 语气年龄段 */
export function gradeToBand(grade: Grade): GradeBand {
  if (grade === 'college') return 'undergrad';
  if (grade === 'high') return 'middle';
  return Number(grade) <= 6 ? 'primary' : 'middle';
}

/** 具体年级 → 中文标签（用于 UI 与 prompt） */
export function gradeLabel(grade: Grade): string {
  if (grade === 'high') return '高中';
  if (grade === 'college') return '大学及以上';
  const n = Number(grade);
  return n <= 6 ? `小学${'一二三四五六'[n - 1]}年级` : `初${['一', '二', '三'][n - 7]}`;
}

/** 智能体工作模式 */
export type BoenMode = 'qa' | 'review' | 'preview' | 'weakness' | 'ai-learning' | 'exam';

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

/** POST /api/chat 请求体 */
export interface ChatRequest {
  threadId: string;
  message: string;
  gradeBand: GradeBand;
  grade?: Grade;
  userName?: string;
  mode?: BoenMode;
}

// ─────────────────────────────────────────────────────────────
// 测评（answer card）模块 —— 对话内嵌入式答题
// ─────────────────────────────────────────────────────────────

export type QuestionType = 'multiple_choice' | 'fill_blank' | 'true_false' | 'short_answer';
export type Difficulty = 'easy' | 'medium' | 'hard';

interface BaseQuestion {
  type: QuestionType;
  stem: string;
  passage?: string;
  knowledgePoint?: string;
  difficulty?: Difficulty;
}

export type QuestionPayload =
  | (BaseQuestion & {
      type: 'multiple_choice';
      options: { key: string; text: string }[];
      multiSelect: boolean;
    })
  | (BaseQuestion & { type: 'fill_blank'; blankCount: number })
  | (BaseQuestion & { type: 'true_false' })
  | (BaseQuestion & { type: 'short_answer' });

export type AnswerPayload =
  | { type: 'multiple_choice'; selectedKeys: string[] }
  | { type: 'fill_blank'; answers: string[] }
  | { type: 'true_false'; value: boolean }
  | { type: 'short_answer'; text: string };

/** 判分结果 */
export interface GradingResult {
  correct: boolean | null;
  score: number;
  maxScore: number;
  reference: string;
  explanation: string;
  perBlank?: boolean[];
  knowledgePoints?: string[];
  literacies?: string[];
}

export interface AnswerRequest {
  threadId: string;
  toolCallId: string;
  answer: AnswerPayload;
  conversationId?: string;
}

// ─────────────────────────────────────────────────────────────
// 知识画像类型
// ─────────────────────────────────────────────────────────────

export type ProficiencyLevel = 'needs_practice' | 'developing' | 'proficient' | 'mastered';

export interface KpProficiency {
  kgNodeId: number;
  title: string;
  correctCount: number;
  totalCount: number;
  weightedScore: number;
  level: ProficiencyLevel;
  lastUpdated: number;
}

export interface LiteracyProficiency {
  literacy: string;
  score: number;
  totalScore: number;
  percentage: number;
}

export interface ProfileRecommendation {
  kgNodeId: number;
  title: string;
  weightedScore: number;
  level: ProficiencyLevel;
  weight: number;
  reason: string;
}

// ─────────────────────────────────────────────────────────────
// 考试类型
// ─────────────────────────────────────────────────────────────

export interface ExamQuestion {
  index: number;
  type: QuestionType;
  points: number;
  stem: string;
  passage?: string;
  options?: { key: string; text: string }[];
  correctKeys?: string[];
  multiSelect?: boolean;
  blanks?: { acceptedAnswers: string[] }[];
  answer?: boolean;
  referenceAnswer?: string;
  keyPoints?: string[];
  knowledgePoint?: string;
  literacies?: string[];
  difficulty?: Difficulty;
  explanation: string;
  /** 分步设问分组 ID：同 groupId 的题目共享 passage/stem，前端合并展示 */
  groupId?: number;
}

export interface ExamQuestionResult {
  index: number;
  correct: boolean | null;
  score: number;
  maxScore: number;
  reference: string;
  explanation: string;
  knowledgePoint?: string;
  literacy?: string[];
}

export interface ProficiencyChange {
  kpTitle: string;
  /** 变化前的 EMA 值 (0-100) */
  before: number;
  /** 变化后的 EMA 值 (0-100) */
  after: number;
  /** 本条得分/满分 */
  score: number;
  maxScore: number;
}

export interface ExamResults {
  totalScore: number;
  maxScore: number;
  percentage: number;
  grade: string;
  questionResults: ExamQuestionResult[];
  tierBreakdown: Array<{ tier: string; correct: number; total: number; percentage: number }>;
  kpBreakdown: Array<{ kp: string; score: number; maxScore: number; percentage: number }>;
  literacyBreakdown: Array<{ literacy: string; score: number; maxScore: number }>;
  /** 博文对本次考试的综合分析总结（Markdown），包括考查知识点、答题情况、失分点与薄弱点 */
  analysis?: string;
  /** 各知识点熟练度变化 */
  proficiencyChanges?: ProficiencyChange[];
}

/** 考试历史列表项（概要） */
export interface ExamSummary {
  examId: string;
  title: string;
  subject: string;
  grade: string;
  totalScore: number;
  status: 'pending' | 'completed';
  createdAt: number;
  submittedAt?: number;
  /** 已完成考试的成绩概要 */
  result?: { totalScore: number; maxScore: number; percentage: number; grade: string };
}

/** 考试回顾详情：已完成考试返回完整题目（含答案）+ 用户作答 + 评分 */
export interface ExamReviewDetail {
  examId: string;
  title: string;
  subject: string;
  grade: string;
  totalScore: number;
  durationMinutes: number;
  status: 'pending' | 'completed';
  createdAt: number;
  submittedAt?: number;
  questions: ExamQuestion[];
  answers?: Array<{ questionIndex: number; answer: AnswerPayload }>;
  results?: ExamResults;
}

// ─────────────────────────────────────────────────────────────
// SSE 事件
// ─────────────────────────────────────────────────────────────

export type SseEvent =
  | { type: 'token'; value: string }
  | { type: 'mode'; value: BoenMode }
  | { type: 'quiz_generating' }
  | { type: 'question'; toolCallId: string; question: QuestionPayload }
  | { type: 'grading'; toolCallId: string; result: GradingResult }
  | { type: 'title_updated'; conversationId: string; title: string }
  | { type: 'review_complete'; summary: string; score: number; totalQuestions: number; correctAnswers: number }
  | { type: 'exam_generating' }
  | { type: 'exam_progress'; step: 'analyze' | 'write' | 'review'; message: string; progress: number }
  | { type: 'exam_ready'; examId: string; title: string; totalQuestions: number; totalScore: number; durationMinutes: number }
  | { type: 'exam_grading_progress'; graded: number; total: number }
  | { type: 'exam_graded'; examId: string; results: ExamResults }
  | { type: 'done' }
  | { type: 'error'; message: string };
