import {
  StateGraph,
  Annotation,
  MemorySaver,
  BaseCheckpointSaver,
} from '@langchain/langgraph';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import { SystemMessage, isToolMessage, isHumanMessage, isAIMessage, type AIMessage } from '@langchain/core/messages';
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
  lookupKnowledgePointTool,
} from './curriculum-tools.js';

/** 全图共享状态 */
export const BoenState = Annotation.Root({
  messages: Annotation({
    reducer: (a: any[], b: any[]) => a.concat(b),
    default: () => [],
  }),
  gradeBand: Annotation<GradeBand>(),
  grade: Annotation<Grade | undefined>(),
  subject: Annotation<string>(),
  userName: Annotation<string>(),
  mode: Annotation<BoenMode>(),
  forceQuiz: Annotation<boolean>(),
  quizTool: Annotation<string | undefined>(),
  curriculum: Annotation<string | undefined>(),
  reviewPhase: Annotation<string>(),
  weaknessData: Annotation<string | undefined>(),
  styleExamples: Annotation<string | undefined>(),
  practiceType: Annotation<string | undefined>(),
  pendingModeSwitch: Annotation<string | undefined>(),
  /** TODO 状态机 JSON */
  todoState: Annotation<string | undefined>(),
});

type State = typeof BoenState.State;
type ToolCall = { id?: string; name: string; args?: unknown };

export interface BoenGraphDeps {
  retrieveCurriculum?: (args: { grade?: string; subject?: string; query?: string }) => Promise<string>;
  lookupKnowledgePoint?: (args: { grade?: string; subject?: string; query: string; limit?: number }) => Promise<string>;
}

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
/** 步骤规划工具 */
export const PLAN_STEPS_TOOL = 'plan_steps';
/** TODO 步骤推进工具 */
export const ADVANCE_STEP_TOOL = 'advance_step';

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

const advanceStepSchema = z.object({
  stepId: z.number().int().min(1).describe('已完成步骤的编号（如 1 表示第一步已完成）'),
  note: z.string().optional().describe('完成该步骤的备注，如学生表现等'),
});
const advanceStepTool = tool(async ({ stepId }) => {
  return `步骤 ${stepId} 已完成记录。请先询问学生是否准备好进入下一步，等学生明确回复后再继续。不要直接开始下一步内容。`;
}, {
  name: ADVANCE_STEP_TOOL,
  description: '当学生确认准备好进入下一步时调用此工具。调用前必须先征得学生同意。',
  schema: advanceStepSchema,
});

const planStepsSchema = z.object({
  steps: z.array(z.object({
    label: z.string().describe('步骤描述，如"了解学员基础"、"核心概念讲解"、"例题演练"'),
  })).min(3).describe('TODO 步骤清单，至少 3 步'),
});
const planStepsTool = tool(async ({ steps }) => {
  return `已规划 ${steps.length} 步学习计划。请开始第一步教学。`;
}, {
  name: PLAN_STEPS_TOOL,
  description: '根据学习内容规划 TODO 步骤清单（至少 3 步）。教学开始前必须先调用此工具设定学习计划。',
  schema: planStepsSchema,
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
function makeSwitchTool(name: string, description: string, hint: string, extraSchema: Record<string, z.ZodType> = {}) {
  return tool(async () => hint, {
    name, description,
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

// ── 工具组合 ────────────────────────────────
const structuredTools: any[] = [advanceStepTool, exitSessionTool, planStepsTool];

/** 格式化 TODO 状态为文字清单 */
function formatTodoState(todoJson: string): string {
  try {
    const todo = JSON.parse(todoJson);
    if (!todo.steps?.length) return '';
    const allDone = todo.steps.every((s: any) => s.status === 'completed');
    const lines = todo.steps.map((s: any) => {
      if (s.status === 'completed') return `✅ 第${s.id}步：${s.label} ✅`;
      if (s.status === 'in_progress') return `▶️ 第${s.id}步：${s.label}（当前步骤）`;
      return `⬜ 第${s.id}步：？？？`;
    });
    if (allDone) {
      return '\n\n## 📋 步骤进度\n' + lines.join('\n') + '\n\n🎉 所有步骤已完成！请调用 exit_session 工具结束学习并提交评分。';
    }
    return '\n\n## 📋 步骤进度\n' + lines.join('\n') + '\n\n【强制】完成当前步骤后调用 advance_step 查看下一步。不调工具看不到下一步内容。';
  } catch { return ''; }
}

/**
 * 构建博文主图。
 *
 * 标准 LangGraph 模式：
 *   router → loadCurriculum → agent
 *   agent → ToolNode(有 tool_calls) → todoUpdater → agent
 *   agent → __end__(无 tool_calls)
 *
 * ToolNode 自动执行所有工具并返回 ToolMessage。
 * todoUpdater 拦截 plan_steps/advance_step 的结果，维护 TODO 状态机。
 */
export function buildBoenGraph(model: BaseChatModel, deps: BoenGraphDeps = {}, checkpointer?: BaseCheckpointSaver) {
  const qaTools: any[] = deps.lookupKnowledgePoint
    ? [...quizTools, lookupKnowledgePointTool, ...switchModeTools]
    : [...quizTools, ...switchModeTools];
  const reviewTools: any[] = [...quizTools, completeReviewTool, ...switchModeTools, ...structuredTools];
  if (deps.lookupKnowledgePoint) reviewTools.push(lookupKnowledgePointTool);

  // ── 获取当前模式所需的工具列表 ──────────────
  function getTools(state: State): any[] {
    const isStructured = ['review', 'preview', 'weakness', 'practice', 'explore'].includes(state.mode ?? '');
    if (state.forceQuiz) return quizTools; // tool_choice 强制只用出题工具
    if (state.mode === 'review' || state.mode === 'weakness') return reviewTools;
    if (state.mode === 'preview' || state.mode === 'explore' || state.practiceType) {
      return [...qaTools, ...structuredTools];
    }
    return qaTools;
  }

  /** 构建当前模式的 system prompt */
  function buildSystem(state: State): SystemMessage {
    const todoAppend = (state.todoState && ['review', 'preview', 'weakness', 'practice', 'explore'].includes(state.mode ?? ''))
      ? formatTodoState(state.todoState) : '';
    const grade = state.gradeBand ?? 'middle';
    const subject = state.subject ?? 'math';
    const user = state.userName;

    if (state.mode === 'review') return new SystemMessage(systemPromptForReview(grade, subject, user, state.grade) + todoAppend);
    if (state.mode === 'preview') return new SystemMessage(systemPromptForPreview(grade, subject, user, state.grade) + todoAppend);
    if (state.practiceType) return new SystemMessage(systemPromptForPractice(state.practiceType as PracticeType, grade, subject, user, state.grade) + todoAppend);
    if (state.mode === 'weakness') return new SystemMessage(systemPromptForWeakness(grade, subject, user, state.grade) + todoAppend);
    if (state.mode === 'explore') return new SystemMessage(systemPromptForQa(grade, subject, user, state.grade) + todoAppend);
    return new SystemMessage(systemPromptForQa(grade, subject, user, state.grade));
  }

  /** 用户确认切换的意图检测 */
  function detectConfirmIntent(text: string): boolean {
    return /^好|^行|^可以|^确定|^确认|^开始|^嗯|^ok|^是的|^对|来吧|切换|同意/i.test(text.trim());
  }

  // ── 节点：意图路由 ──────────────────────────
  const router = (state: State): Partial<State> => {
    const last = state.messages[state.messages.length - 1];
    if (last && isHumanMessage(last)) {
      const text = String(last.content);
      const { force, tool: qTool } = detectQuizIntent(text);

      if (state.pendingModeSwitch && detectConfirmIntent(text)) {
        const pending = state.pendingModeSwitch;
        if (pending.startsWith('practice:')) {
          const type = pending.split(':')[1] ?? 'mental-arithmetic';
          return { mode: 'qa', practiceType: type, forceQuiz: false, pendingModeSwitch: undefined };
        }
        return { mode: pending as BoenMode, forceQuiz: false, quizTool: undefined, reviewPhase: 'teaching', pendingModeSwitch: undefined };
      }
      if (state.pendingModeSwitch && /^不|别|不用|算了|等下/i.test(text.trim())) {
        return { pendingModeSwitch: undefined };
      }

      if (detectPreviewIntent(text)) return { mode: 'preview', forceQuiz: false, quizTool: undefined, reviewPhase: 'teaching', pendingModeSwitch: undefined };
      if (detectReviewIntent(text)) return { mode: 'review', forceQuiz: false, quizTool: undefined, reviewPhase: 'teaching', pendingModeSwitch: undefined };
      if (detectWeaknessIntent(text)) return { mode: 'weakness', forceQuiz: false, quizTool: undefined, reviewPhase: 'teaching', pendingModeSwitch: undefined };
      if (['review', 'preview', 'weakness', 'explore'].includes(state.mode ?? '')) {
        return { mode: state.mode, reviewPhase: 'teaching', forceQuiz: force, quizTool: qTool };
      }
      return { mode: state.mode ?? 'qa', forceQuiz: force, quizTool: qTool };
    }
    return { mode: state.mode ?? 'qa', forceQuiz: false };
  };

  // ── 节点：加载课程资料 ──────────────────────
  const loadCurriculum = async (state: State): Promise<Partial<State>> => {
    let parts: string[] = [];
    if (deps.retrieveCurriculum) {
      const lastHuman = [...state.messages].reverse().find(isHumanMessage);
      const query = lastHuman ? String(lastHuman.content) : '';
      try {
        const curriculum = await deps.retrieveCurriculum({ grade: state.grade, subject: state.subject, query });
        if (curriculum) parts.push(curriculum);
      } catch (err) { console.warn('[agent] curriculum retrieval failed:', err); }
    }
    if (state.mode === 'weakness' && state.weaknessData) parts.push(state.weaknessData);
    if ((state.mode === 'weakness' || state.forceQuiz || state.practiceType) && state.styleExamples) parts.push(state.styleExamples);
    return { curriculum: parts.length > 0 ? parts.join('\n\n') : undefined };
  };

  // ── 节点：调用模型 ──────────────────────────
  const callModel = async (state: State): Promise<Partial<State>> => {
    const system = buildSystem(state);
    const tools = getTools(state);
    const llm = model.bindTools ? model.bindTools(tools, state.forceQuiz ? {
      tool_choice: { type: 'function', function: { name: state.quizTool ?? 'ask_multiple_choice' } },
    } as any : undefined) : model;

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
        [SWITCH_TO_PREVIEW]: 'preview', [SWITCH_TO_REVIEW]: 'review',
        [SWITCH_TO_WEAKNESS]: 'weakness', [SWITCH_TO_PRACTICE]: 'practice',
      };
      const target = modeMap[switchCall.name] ?? 'qa';
      if (target === 'practice') {
        const args = switchCall.args ?? {};
        return { messages: [response], pendingModeSwitch: `practice:${(args as any).type ?? 'mental-arithmetic'}` };
      }
      return { messages: [response], pendingModeSwitch: target };
    }
    return { messages: [response] };
  };

  // ── 路由：判断是否继续工具循环 ──────────────
  function shouldContinue(state: State): 'tools' | '__end__' {
    const last = state.messages[state.messages.length - 1] as AIMessage | undefined;
    if (last && isAIMessage(last) && last.tool_calls?.length) return 'tools';
    return '__end__';
  }

  // ── 节点：TODO 状态更新（在 ToolNode 之后运行）─
  const updateTodoState = async (state: State): Promise<Partial<State>> => {
    // 找到最后一个 AIMessage 的 tool_calls
    let aiMsg: AIMessage | undefined;
    for (let i = state.messages.length - 1; i >= 0; i--) {
      if (isAIMessage(state.messages[i])) { aiMsg = state.messages[i] as AIMessage; break; }
    }
    if (!aiMsg?.tool_calls?.length) return {};

    const planCall = aiMsg.tool_calls.find((c: any) => c.name === PLAN_STEPS_TOOL);
    if (planCall) {
      const args = planCall.args as { steps?: Array<{ label: string }> } | undefined;
      if (args?.steps?.length) {
        return {
          todoState: JSON.stringify({
            steps: args.steps.map((s: any, i: number) => ({
              id: i + 1, label: s.label,
              status: i === 0 ? 'in_progress' : 'pending',
            })),
            currentStep: 1,
          }),
        };
      }
    }

    const advanceCall = aiMsg.tool_calls.find((c: any) => c.name === ADVANCE_STEP_TOOL);
    if (advanceCall && state.todoState) {
      try {
        const todo = JSON.parse(state.todoState);
        const stepId = Number((advanceCall.args as any)?.stepId) || todo.currentStep;
        const step = todo.steps.find((s: any) => s.id === stepId);
        if (step) step.status = 'completed';
        const nextStep = todo.steps.find((s: any) => s.status === 'pending');
        if (nextStep) { nextStep.status = 'in_progress'; todo.currentStep = nextStep.id; }
        else { todo.currentStep = todo.steps.length + 1; }
        return { todoState: JSON.stringify(todo) };
      } catch {}
    }

    return {};
  };

  // ── ToolNode（LangGraph 内置，自动执行所有工具调用）──
  // 需注册所有可能被调用的工具
  const allTools = Array.from(new Set([...reviewTools, ...qaTools, lookupKnowledgePointTool].flat())) as any[];
  const toolNode = new ToolNode(allTools);

  // ── 构建图 ──────────────────────────────────
  const graph = new StateGraph(BoenState)
    .addNode('router', router)
    .addNode('loadCurriculum', loadCurriculum)
    .addNode('agent', callModel)
    .addNode('tools', toolNode)
    .addNode('updateTodo', updateTodoState)
    .addEdge('__start__', 'router')
    .addEdge('router', 'loadCurriculum')
    .addEdge('loadCurriculum', 'agent')
    .addConditionalEdges('agent', shouldContinue, {
      tools: 'tools',
      __end__: '__end__',
    })
    .addEdge('tools', 'updateTodo')
    .addEdge('updateTodo', 'agent');

  return graph.compile({ checkpointer: checkpointer ?? new MemorySaver() });
}
