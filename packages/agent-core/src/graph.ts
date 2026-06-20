import {
  StateGraph,
  MessagesAnnotation,
  Annotation,
  MemorySaver,
  BaseCheckpointSaver,
} from '@langchain/langgraph';
import { SystemMessage, ToolMessage, isToolMessage, isHumanMessage, type AIMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { GradeBand, BoenMode } from '@boen/shared';
import type { Grade } from '@boen/shared';
import { systemPromptForQa, systemPromptForReview, systemPromptForPreview, systemPromptForWeakness, systemPromptForPractice } from './prompts.js';
import type { PracticeType } from './prompts.js';
import { quizTools } from './quiz/index.js';
import {
  LOOKUP_KNOWLEDGE_POINT_TOOL,
  lookupKnowledgePointSchema,
  lookupKnowledgePointTool,
} from './curriculum-tools.js';

/** 全图共享状态 */
export const BoenState = Annotation.Root({
  ...MessagesAnnotation.spec,
  gradeBand: Annotation<GradeBand>(),
  grade: Annotation<Grade | undefined>(),
  subject: Annotation<string>(),
  userName: Annotation<string>(),
  mode: Annotation<BoenMode>(),
  forceQuiz: Annotation<boolean>(),
  quizTool: Annotation<string | undefined>(),
  curriculum: Annotation<string | undefined>(),
  /** 复习模式阶段：teaching=讲解中 quizzing=出题中 strict=true 时仅在teaching可出题 */
  reviewPhase: Annotation<string>(),
  /** 薄弱点数据（由服务端从知识画像中获取，突破模式注入） */
  weaknessData: Annotation<string | undefined>(),
  styleExamples: Annotation<string | undefined>(),
  /** 专项练习类型 */
  practiceType: Annotation<string | undefined>(),
  /** LLM 发起的模式切换建议，等待用户确认 */
  pendingModeSwitch: Annotation<string | undefined>(),
  /**
   * 类课堂 TODO 状态机（JSON 序列化）
   * 格式：{"steps":[{"id":1,"label":"了解学情","status":"completed"},...],"currentStep":2}
   * status: 'pending' | 'in_progress' | 'completed'
   */
  todoState: Annotation<string | undefined>(),
});

type State = typeof BoenState.State;

export interface BoenGraphDeps {
  retrieveCurriculum?: (args: { grade?: string; subject?: string; query?: string }) => Promise<string>;
  lookupKnowledgePoint?: (args: { grade?: string; subject?: string; query: string; limit?: number }) => Promise<string>;
}

type ToolCall = { id?: string; name: string; args?: unknown };

function detectQuizIntent(text: string): { force: boolean; tool: string } {
  const wantsQuiz = /考我|考考|出一?[道题]|来一?[道题]|测验|测试|测一测|练习|出题|quiz/i.test(text);
  let tool = 'ask_multiple_choice';
  if (/判断/.test(text)) tool = 'ask_true_false';
  else if (/填空/.test(text)) tool = 'ask_fill_blank';
  else if (/简答|问答|论述|解答/.test(text)) tool = 'ask_short_answer';
  return { force: wantsQuiz, tool };
}

function detectReviewIntent(text: string): boolean {
  return /^(教我|讲(一?下)|讲解|复习|学习|仔细说说|辅导|帮我复习)/.test(text.trim());
}

function detectPreviewIntent(text: string): boolean {
  return /预习|提前看|先看看|准备上课|课堂准备/i.test(text.trim());
}

function detectWeaknessIntent(text: string): boolean {
  return /薄弱|总是错|老错|总做错|反复错|突破|提分|集中练习|帮我练习/i.test(text.trim());
}

/** 复习完成工具 */
export const COMPLETE_REVIEW_TOOL = 'complete_review';

/** 类课堂退出工具 */
export const EXIT_SESSION_TOOL = 'exit_session';

const exitSessionSchema = z.object({
  summary: z.string().describe('本次学习的总结评价'),
  score: z.number().min(0).max(100).describe('综合评分(0-100)'),
  stepsCompleted: z.number().min(0).describe('已完成的步数'),
  totalSteps: z.number().min(0).describe('总步数'),
});

const exitSessionTool = tool(async () => '', {
  name: EXIT_SESSION_TOOL,
  description: '结束当前类课堂学习，提交总结和评分。所有步骤完成后或学生要求结束时调用此工具。',
  schema: exitSessionSchema,
});

/** TODO 步骤推进工具 */
export const ADVANCE_STEP_TOOL = 'advance_step';

const advanceStepSchema = z.object({
  stepId: z.number().int().min(1).describe('已完成步骤的编号（如 1 表示第一步已完成）'),
  note: z.string().optional().describe('完成该步骤的备注，如学生表现等'),
});

const advanceStepTool = tool(async ({ stepId }) => {
  return `步骤 ${stepId} 已标记完成。请继续下一步。`;
}, {
  name: ADVANCE_STEP_TOOL,
  description: '完成当前教学步骤后调用此工具，系统会自动推进到下一步。每次只推进一步。',
  schema: advanceStepSchema,
});

const completeReviewSchema = z.object({
  summary: z.string().describe('本次复习总结'),
  overallScore: z.number().min(0).max(100).describe('综合评分(0-100)'),
  totalQuestions: z.number().min(0).describe('复习中出的题目总数'),
  correctAnswers: z.number().min(0).describe('回答正确的题目数'),
  sectionsCovered: z.array(z.string()).describe('已讲解的章节列表'),
});

const completeReviewTool = tool(async () => '', {
  name: COMPLETE_REVIEW_TOOL,
  description: '复习结束时调用，提交总结和评分数据。',
  schema: completeReviewSchema,
});

// ── 模式切换工具 ────────────────────────────

/** 模式切换工具：LLM 根据学习周期感知主动建议，工具返回确认提示 */
function makeSwitchTool(name: string, description: string, hint: string, extraSchema: Record<string, z.ZodType> = {}) {
  return tool(async () => hint, {
    name,
    description,
    schema: z.object({ reason: z.string().describe('向学生说明为什么建议切换到此模式'), ...extraSchema }),
  });
}

const SWITCH_TO_PREVIEW = 'switch_to_preview';
const SWITCH_TO_REVIEW = 'switch_to_review';
const SWITCH_TO_WEAKNESS = 'switch_to_weakness';
const SWITCH_TO_PRACTICE = 'switch_to_practice';

const switchModeTools: any[] = [
  makeSwitchTool(SWITCH_TO_PREVIEW,
    '根据学习周期感知主动建议学生切换到预习模式来预习新章节。当判断学生即将学习或刚刚开始一个新单元时调用此工具发起建议。',
    '切换到预习模式需要你的确认。回复「好」或「开始预习」来确认。'),
  makeSwitchTool(SWITCH_TO_REVIEW,
    '根据学习周期感知主动建议学生切换到复习巩固模式来做系统复习。当判断学生已完成一个单元的学习或练习、需要巩固时调用此工具发起建议。',
    '切换到复习巩固模式需要你的确认。回复「好」或「开始复习」来确认。'),
  makeSwitchTool(SWITCH_TO_WEAKNESS,
    '根据学习周期感知主动建议学生切换到薄弱点突破模式来专项训练薄弱环节。当发现学生反复出现同类错误、或某个知识点掌握度明显偏低时调用此工具发起建议。',
    '切换到突破模式需要你的确认。回复「好」或「开始突破」来确认。'),
  makeSwitchTool(SWITCH_TO_PRACTICE,
    '根据学习周期感知主动建议学生进入专项练习做同步巩固。当学生刚学完新内容、或做题量不足时调用此工具发起建议。',
    '进入专项练习需要你的确认。回复「好」或「开始练习」来确认。',
    { type: z.enum(['mental-arithmetic', 'dictation', 'recitation', 'reading', 'writing', 'vocabulary']).describe('练习类型') }),
];

/**
 * 构建博文主图。
 */
export function buildBoenGraph(model: BaseChatModel, deps: BoenGraphDeps = {}, checkpointer?: BaseCheckpointSaver) {
  const structuredTools: any[] = [advanceStepTool, exitSessionTool];
  const qaTools: any[] = deps.lookupKnowledgePoint ? [...quizTools, lookupKnowledgePointTool, ...switchModeTools] : [...quizTools, ...switchModeTools];
  const reviewTools: any[] = [...quizTools, completeReviewTool, ...switchModeTools, ...structuredTools];
  if (deps.lookupKnowledgePoint) reviewTools.push(lookupKnowledgePointTool);

  /** 用户确认切换的意图检测 */
  function detectConfirmIntent(text: string): boolean {
    return /^好|^行|^可以|^确定|^确认|^开始|^嗯|^ok|^是的|^对|来吧|切换|同意/i.test(text.trim());
  }

  const router = (state: State): Partial<State> => {
    const last = state.messages[state.messages.length - 1];
    if (last && isHumanMessage(last)) {
      const text = String(last.content);
      const { force, tool: qTool } = detectQuizIntent(text);

      // 有挂起的模式切换建议且用户确认了 → 执行切换
      if (state.pendingModeSwitch && detectConfirmIntent(text)) {
        const pending = state.pendingModeSwitch;
        // practice 模式附带类型："practice:dictation"
        if (pending.startsWith('practice:')) {
          const type = pending.split(':')[1] ?? 'mental-arithmetic';
          return { mode: 'qa', practiceType: type, forceQuiz: false, pendingModeSwitch: undefined };
        }
        return { mode: pending as BoenMode, forceQuiz: false, quizTool: undefined, reviewPhase: 'teaching', pendingModeSwitch: undefined };
      }
      // 用户拒绝了切换 → 清除挂起
      if (state.pendingModeSwitch && /^不|别|不用|算了|等下/i.test(text.trim())) {
        return { pendingModeSwitch: undefined };
      }

      if (detectPreviewIntent(text)) {
        return { mode: 'preview', forceQuiz: false, quizTool: undefined, reviewPhase: 'teaching', pendingModeSwitch: undefined };
      }
      if (detectReviewIntent(text)) {
        return { mode: 'review', forceQuiz: false, quizTool: undefined, reviewPhase: 'teaching', pendingModeSwitch: undefined };
      }
      if (detectWeaknessIntent(text)) {
        return { mode: 'weakness', forceQuiz: false, quizTool: undefined, reviewPhase: 'teaching', pendingModeSwitch: undefined };
      }
      // 学习模式中收到用户消息 → 切回讲解阶段
      if (state.mode === 'review' || state.mode === 'preview' || state.mode === 'weakness') {
        return { mode: state.mode, reviewPhase: 'teaching', forceQuiz: false };
      }
      return { mode: state.mode ?? 'qa', forceQuiz: force, quizTool: qTool };
    }
    return { mode: state.mode ?? 'qa', forceQuiz: false };
  };

  const loadCurriculum = async (state: State): Promise<Partial<State>> => {
    let parts: string[] = [];
    if (deps.retrieveCurriculum) {
      const lastHuman = [...state.messages].reverse().find(isHumanMessage);
      const query = lastHuman ? String(lastHuman.content) : '';
      try {
        const curriculum = await deps.retrieveCurriculum({ grade: state.grade, subject: state.subject, query });
        if (curriculum) parts.push(curriculum);
      } catch (err) {
        console.warn('[agent] curriculum retrieval failed:', err);
      }
    }
    // 薄弱点模式：注入知识画像数据
    if (state.mode === 'weakness' && state.weaknessData) {
      parts.push(state.weaknessData);
    }
    if ((state.mode === 'weakness' || state.forceQuiz || state.practiceType) && state.styleExamples) {
      parts.push(state.styleExamples);
    }
    return { curriculum: parts.length > 0 ? parts.join('\n\n') : undefined };
  };

  /** 格式化 TODO 状态为文字清单 */
  function formatTodoState(todoJson: string): string {
    try {
      const todo = JSON.parse(todoJson);
      if (!todo.steps?.length) return '';
      const lines = todo.steps.map((s: any) => {
        const icon = s.status === 'completed' ? '✅' : s.status === 'in_progress' ? '▶️' : '⬜';
        return `${icon} 第${s.id}步：${s.label}${s.status === 'in_progress' ? '（当前步骤）' : ''}`;
      });
      return '\n\n## 📋 教学步骤进度\n' + lines.join('\n') + '\n\n完成当前步骤后，请调用 advance_step 工具推进到下一步。';
    } catch { return ''; }
  }

  const qaNode = async (state: State): Promise<Partial<State>> => {
    const last = state.messages[state.messages.length - 1];

    let system: SystemMessage;
    let tools: ReturnType<NonNullable<typeof model.bindTools>> | undefined;

    // 注入 TODO 步进工具（仅结构化模式）
    const isStructured = ['review', 'preview', 'weakness', 'practice'].includes(state.mode ?? '');
    const todoAppend = (state.todoState && isStructured) ? formatTodoState(state.todoState) : '';

    if (state.mode === 'review') {
      system = new SystemMessage(systemPromptForReview(state.gradeBand ?? 'middle', state.subject ?? 'math', state.userName, state.grade) + todoAppend);
      if (model.bindTools) tools = model.bindTools([...reviewTools, ...structuredTools] as any);
    } else if (state.mode === 'preview') {
      system = new SystemMessage(systemPromptForPreview(state.gradeBand ?? 'middle', state.subject ?? 'math', state.userName, state.grade) + todoAppend);
      if (model.bindTools) tools = model.bindTools([...qaTools, ...structuredTools] as any);
    } else if (state.practiceType) {
      system = new SystemMessage(systemPromptForPractice(state.practiceType as PracticeType, state.gradeBand ?? 'middle', state.subject ?? 'math', state.userName, state.grade) + todoAppend);
      if (model.bindTools) tools = model.bindTools([...qaTools, ...structuredTools] as any);
    } else if (state.mode === 'weakness') {
      system = new SystemMessage(systemPromptForWeakness(state.gradeBand ?? 'middle', state.subject ?? 'math', state.userName, state.grade) + todoAppend);
      if (model.bindTools) tools = model.bindTools([...reviewTools, ...structuredTools] as any);
    } else {
      system = new SystemMessage(systemPromptForQa(state.gradeBand ?? 'middle', state.subject ?? 'math', state.userName, state.grade));
      if (last && isToolMessage(last)) {
        // 反馈轮：纯文本，不出题
        tools = undefined;
      } else if (state.forceQuiz && model.bindTools) {
        tools = model.bindTools(quizTools, {
          tool_choice: { type: 'function', function: { name: state.quizTool ?? 'ask_multiple_choice' } },
        });
      } else if (model.bindTools) {
        tools = model.bindTools(qaTools);
      }
    }

    const llm = tools ?? model;
    const messages = state.curriculum
      ? [system, new SystemMessage(state.curriculum), ...state.messages]
      : [system, ...state.messages];
    const response = await llm.invoke(messages);

    // 检测模式切换工具调用 → 记录待确认状态
    const calls = (response as any)?.tool_calls ?? [];
    const switchCall = calls.find((c: any) =>
      [SWITCH_TO_PREVIEW, SWITCH_TO_REVIEW, SWITCH_TO_WEAKNESS, SWITCH_TO_PRACTICE].includes(c.name)
    );
    if (switchCall) {
      const modeMap: Record<string, string> = {
        [SWITCH_TO_PREVIEW]: 'preview',
        [SWITCH_TO_REVIEW]: 'review',
        [SWITCH_TO_WEAKNESS]: 'weakness',
        // practice 需要从调用参数中提取练习类型，默认 mental-arithmetic
        [SWITCH_TO_PRACTICE]: 'practice',
      };
      const target = modeMap[switchCall.name] ?? 'qa';
      // practice 模式需要附带练习类型
      if (target === 'practice') {
        const args = switchCall.args ?? {};
        return { messages: [response], pendingModeSwitch: `practice:${(args as any).type ?? 'mental-arithmetic'}` };
      }
      return { messages: [response], pendingModeSwitch: target };
    }

    return { messages: [response] };
  };

  const lookupKnowledgePointNode = async (state: State): Promise<Partial<State>> => {
    const last = state.messages[state.messages.length - 1] as AIMessage | undefined;
    const calls = ((last?.tool_calls ?? []) as ToolCall[]).filter((c) => c.name === LOOKUP_KNOWLEDGE_POINT_TOOL && c.id);
    const messages: ToolMessage[] = [];
    for (const call of calls) {
      try {
        const args = lookupKnowledgePointSchema.parse(call.args ?? {});
        const content = deps.lookupKnowledgePoint
          ? await deps.lookupKnowledgePoint({
              grade: args.grade ?? state.grade, subject: args.subject ?? state.subject,
              query: args.query, limit: args.limit ?? undefined,
            })
          : '课程知识库查询工具尚未接入。';
        messages.push(new ToolMessage({ content: content || '没有找到匹配的课程知识点。', tool_call_id: call.id! }));
      } catch (err) {
        messages.push(new ToolMessage({
          content: `课程知识库查询失败：${err instanceof Error ? err.message : String(err)}`,
          tool_call_id: call.id!,
        }));
      }
    }
    return { messages };
  };

  const routeAfterQa = (state: State) => {
    const last = state.messages[state.messages.length - 1] as AIMessage | undefined;
    const calls = ((last?.tool_calls ?? []) as ToolCall[]).filter((c) => c.id);
    if (calls.length > 0) {
      if (calls.some((c) => c.name === EXIT_SESSION_TOOL)) return 'exitSession';
      if (calls.some((c) => c.name === COMPLETE_REVIEW_TOOL)) return 'end';
      if (calls.some((c) => c.name === ADVANCE_STEP_TOOL)) return 'advanceStepTodo';
      if (calls.every((c) => c.name === LOOKUP_KNOWLEDGE_POINT_TOOL)) return 'lookupKnowledgePoint';
    }
    return 'end';
  };

  /** 退出类课堂节点：插入 ToolMessage 后结束 */
  const exitSessionNode = async (state: State): Promise<Partial<State>> => {
    const last = state.messages[state.messages.length - 1] as AIMessage | undefined;
    const calls = ((last?.tool_calls ?? []) as ToolCall[]).filter((c) => c.name === EXIT_SESSION_TOOL && c.id);
    const toolMsgs = calls.map((call) =>
      new ToolMessage({ content: '学习已结束，总结与评分已提交。', tool_call_id: call.id! }),
    );
    return { messages: toolMsgs };
  };

  /** TODO 步进节点：推进到下一步，继续对话 */
  const advanceStepTodoNode = async (state: State): Promise<Partial<State>> => {
    const last = state.messages[state.messages.length - 1] as AIMessage | undefined;
    const calls = ((last?.tool_calls ?? []) as ToolCall[]).filter((c) => c.name === ADVANCE_STEP_TOOL && c.id);
    const toolMsgs: ToolMessage[] = calls.map((call) =>
      new ToolMessage({ content: `步骤 ${calls.indexOf(call) + 1} 已标记完成。`, tool_call_id: call.id! }),
    );
    if (!state.todoState) return { messages: toolMsgs };
    try {
      const todo = JSON.parse(state.todoState);
      const completedId = todo.currentStep;
      const step = todo.steps.find((s: any) => s.id === completedId);
      if (step) step.status = 'completed';
      todo.currentStep = Math.min(todo.currentStep + 1, todo.steps.length + 1);
      const nextStep = todo.steps.find((s: any) => s.status === 'in_progress' || s.status === 'pending');
      if (nextStep) nextStep.status = 'in_progress';
      return { messages: toolMsgs, todoState: JSON.stringify(todo) };
    } catch { return { messages: toolMsgs }; }
  };

  const graph = new StateGraph(BoenState)
    .addNode('router', router)
    .addNode('loadCurriculum', loadCurriculum)
    .addNode('qa', qaNode)
    .addNode('lookupKnowledgePoint', lookupKnowledgePointNode)
    .addNode('advanceStepTodo', advanceStepTodoNode)
    .addNode('exitSession', exitSessionNode)
    .addEdge('__start__', 'router')
    .addEdge('router', 'loadCurriculum')
    .addEdge('loadCurriculum', 'qa')
    .addConditionalEdges('qa', routeAfterQa, {
      lookupKnowledgePoint: 'lookupKnowledgePoint',
      advanceStepTodo: 'advanceStepTodo',
      exitSession: 'exitSession',
      end: '__end__',
    })
    .addEdge('lookupKnowledgePoint', 'qa')
    .addEdge('advanceStepTodo', 'qa')
    .addEdge('exitSession', '__end__');

  return graph.compile({ checkpointer: checkpointer ?? new MemorySaver() });
}
