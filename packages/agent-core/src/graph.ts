import {
  StateGraph,
  MessagesAnnotation,
  Annotation,
  MemorySaver,
} from '@langchain/langgraph';
import { SystemMessage, isToolMessage, isHumanMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { GradeBand, BoenMode } from '@boen/shared';
import type { Grade } from '@boen/shared';
import { systemPromptForQa } from './prompts.js';
import { quizTools } from './quiz/index.js';

/** 全图共享状态：消息历史 + 用户画像 + 当前模式 + 出题控制 */
export const BoenState = Annotation.Root({
  ...MessagesAnnotation.spec,
  gradeBand: Annotation<GradeBand>(),
  /** 具体年级（1–9 / high / college），用于按年级加载课程知识库 */
  grade: Annotation<Grade | undefined>(),
  subject: Annotation<string>(),
  userName: Annotation<string>(),
  mode: Annotation<BoenMode>(),
  /** 本轮是否强制出题 */
  forceQuiz: Annotation<boolean>(),
  /** 强制出题时使用的题型工具名 */
  quizTool: Annotation<string | undefined>(),
  /** RAG：按年级+学科检索到的课程知识库上下文，注入 qa 系统提示 */
  curriculum: Annotation<string | undefined>(),
});

type State = typeof BoenState.State;

/** 外部依赖（由 server 注入，使 agent-core 与具体存储/检索解耦） */
export interface BoenGraphDeps {
  /** RAG 检索器：按年级+学科召回课程编排与相关知识点 */
  retrieveCurriculum?: (args: { grade?: string; subject?: string; query?: string }) => Promise<string>;
}

/** 从用户话语里识别「要被出题」的意图及题型 */
function detectQuizIntent(text: string): { force: boolean; tool: string } {
  const wantsQuiz = /考我|考考|出一?[道题]|来一?[道题]|测验|测试|测一测|练习|出题|quiz/i.test(text);
  let tool = 'ask_multiple_choice';
  if (/判断/.test(text)) tool = 'ask_true_false';
  else if (/填空/.test(text)) tool = 'ask_fill_blank';
  else if (/简答|问答|论述|解答/.test(text)) tool = 'ask_short_answer';
  return { force: wantsQuiz, tool };
}

/**
 * 构建博文主图。
 * 阶段 0/工具层：router 判定是否出题；qa 节点据此决定绑定/强制出题工具或纯文本反馈。
 * 后续阶段在 router 后扩展 review / ai-learning 子图。
 */
export function buildBoenGraph(model: BaseChatModel, deps: BoenGraphDeps = {}) {
  const router = (state: State): Partial<State> => {
    const last = state.messages[state.messages.length - 1];
    if (last && isHumanMessage(last)) {
      const { force, tool } = detectQuizIntent(String(last.content));
      return { mode: state.mode ?? 'qa', forceQuiz: force, quizTool: tool };
    }
    // 非用户消息（如作答回灌的 ToolMessage）不触发出题
    return { mode: state.mode ?? 'qa', forceQuiz: false };
  };

  // RAG 检索节点：按年级+学科召回课程知识库上下文，写入 state.curriculum
  const loadCurriculum = async (state: State): Promise<Partial<State>> => {
    if (!deps.retrieveCurriculum) return {};
    // 用最近一条用户消息作检索 query（反馈轮没有则只取编排概览）
    const lastHuman = [...state.messages].reverse().find(isHumanMessage);
    const query = lastHuman ? String(lastHuman.content) : '';
    try {
      const curriculum = await deps.retrieveCurriculum({ grade: state.grade, subject: state.subject, query });
      return { curriculum: curriculum || undefined };
    } catch {
      return {}; // 检索失败不阻断主流程
    }
  };

  const qaNode = async (state: State): Promise<Partial<State>> => {
    const system = new SystemMessage(systemPromptForQa(state.gradeBand ?? 'middle', state.subject ?? 'math', state.userName, state.grade));
    const last = state.messages[state.messages.length - 1];

    let llm;
    if (last && isToolMessage(last)) {
      // 作答判分后的反馈轮：纯文本点评，不再出题
      llm = model;
    } else if (state.forceQuiz && model.bindTools) {
      // 明确要被出题：强制调用指定题型工具
      llm = model.bindTools(quizTools, {
        tool_choice: { type: 'function', function: { name: state.quizTool ?? 'ask_multiple_choice' } },
      });
    } else if (model.bindTools) {
      llm = model.bindTools(quizTools);
    } else {
      llm = model;
    }

    // RAG：把检索到的课程上下文作为附加系统消息注入
    const messages = state.curriculum
      ? [system, new SystemMessage(state.curriculum), ...state.messages]
      : [system, ...state.messages];
    const response = await llm.invoke(messages);
    return { messages: [response] };
  };

  const graph = new StateGraph(BoenState)
    .addNode('router', router)
    .addNode('loadCurriculum', loadCurriculum)
    .addNode('qa', qaNode)
    .addEdge('__start__', 'router')
    .addEdge('router', 'loadCurriculum')
    .addEdge('loadCurriculum', 'qa')
    .addEdge('qa', '__end__');

  return graph.compile({ checkpointer: new MemorySaver() });
}
