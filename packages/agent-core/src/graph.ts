import {
  StateGraph,
  MessagesAnnotation,
  Annotation,
  MemorySaver,
} from '@langchain/langgraph';
import { SystemMessage, ToolMessage, isToolMessage, isHumanMessage, type AIMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { GradeBand, BoenMode } from '@boen/shared';
import type { Grade } from '@boen/shared';
import { systemPromptForQa, systemPromptForReview } from './prompts.js';
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
  return /^(教我|讲(一?下)|讲解|复习|学习|仔细说说|辅导)/.test(text.trim());
}

/** 复习完成工具 */
export const COMPLETE_REVIEW_TOOL = 'complete_review';

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

/**
 * 构建博文主图。
 */
export function buildBoenGraph(model: BaseChatModel, deps: BoenGraphDeps = {}) {
  const qaTools: any[] = deps.lookupKnowledgePoint ? [...quizTools, lookupKnowledgePointTool] : quizTools;
  const reviewTools: any[] = [...quizTools, completeReviewTool];
  if (deps.lookupKnowledgePoint) reviewTools.push(lookupKnowledgePointTool);

  const router = (state: State): Partial<State> => {
    const last = state.messages[state.messages.length - 1];
    if (last && isHumanMessage(last)) {
      const text = String(last.content);
      const { force, tool: qTool } = detectQuizIntent(text);
      if (detectReviewIntent(text)) {
        return { mode: 'review', forceQuiz: false, quizTool: undefined, reviewPhase: 'teaching' };
      }
      // 复习模式中收到用户消息 → 切回 teaching 阶段（强制讲解，不出题）
      if (state.mode === 'review') {
        return { mode: 'review', reviewPhase: 'teaching', forceQuiz: false };
      }
      return { mode: state.mode ?? 'qa', forceQuiz: force, quizTool: qTool };
    }
    return { mode: state.mode ?? 'qa', forceQuiz: false };
  };

  const loadCurriculum = async (state: State): Promise<Partial<State>> => {
    if (!deps.retrieveCurriculum) return {};
    const lastHuman = [...state.messages].reverse().find(isHumanMessage);
    const query = lastHuman ? String(lastHuman.content) : '';
    try {
      const curriculum = await deps.retrieveCurriculum({ grade: state.grade, subject: state.subject, query });
      return { curriculum: curriculum || undefined };
    } catch {
      return {};
    }
  };

  const qaNode = async (state: State): Promise<Partial<State>> => {
    const last = state.messages[state.messages.length - 1];

    let system: SystemMessage;
    let tools: ReturnType<typeof model.bindTools> | undefined;

    if (state.mode === 'review') {
      system = new SystemMessage(systemPromptForReview(state.gradeBand ?? 'middle', state.subject ?? 'math', state.userName, state.grade));
      if (!model.bindTools) { /* no tool support */ }
      // 交替制：ToolMessage(刚判分完)→quizzing(继续出题)
      //          用户消息→teaching(讲解)
      //          reviewPhase 由 router(用户消息→teaching) 和本节点(判分后→quizzing) 控制
      else if (state.reviewPhase === 'quizzing') {
        tools = model.bindTools(reviewTools as any);
      }
      // teaching 或默认：只绑定完成+查询工具，无出题工具 → 强制讲解
      else {
        const teachTools: any[] = [completeReviewTool];
        if (deps.lookupKnowledgePoint) teachTools.push(lookupKnowledgePointTool);
        tools = model.bindTools(teachTools);
      }
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

    // 复习模式阶段控制
    if (state.mode === 'review') {
      const result: Record<string, unknown> = { messages: [response] };
      // 判分反馈到后 → 切 quizzing，让模型可以继续出题
      if (last && isToolMessage(last)) {
        result.reviewPhase = 'quizzing';
      }
      return result;
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
      if (calls.some((c) => c.name === COMPLETE_REVIEW_TOOL)) return 'end';
      if (calls.every((c) => c.name === LOOKUP_KNOWLEDGE_POINT_TOOL)) return 'lookupKnowledgePoint';
    }
    return 'end';
  };

  const graph = new StateGraph(BoenState)
    .addNode('router', router)
    .addNode('loadCurriculum', loadCurriculum)
    .addNode('qa', qaNode)
    .addNode('lookupKnowledgePoint', lookupKnowledgePointNode)
    .addEdge('__start__', 'router')
    .addEdge('router', 'loadCurriculum')
    .addEdge('loadCurriculum', 'qa')
    .addConditionalEdges('qa', routeAfterQa, {
      lookupKnowledgePoint: 'lookupKnowledgePoint',
      end: '__end__',
    })
    .addEdge('lookupKnowledgePoint', 'qa');

  return graph.compile({ checkpointer: new MemorySaver() });
}
