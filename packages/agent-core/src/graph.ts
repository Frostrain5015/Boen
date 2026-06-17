import {
  StateGraph,
  MessagesAnnotation,
  Annotation,
  MemorySaver,
} from '@langchain/langgraph';
import { SystemMessage, isToolMessage, isHumanMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { GradeBand, BoenMode } from '@boen/shared';
import { systemPromptForQa } from './prompts.js';
import { quizTools } from './quiz/index.js';

/** 全图共享状态：消息历史 + 用户画像 + 当前模式 + 出题控制 */
export const BoenState = Annotation.Root({
  ...MessagesAnnotation.spec,
  gradeBand: Annotation<GradeBand>(),
  mode: Annotation<BoenMode>(),
  /** 本轮是否强制出题 */
  forceQuiz: Annotation<boolean>(),
  /** 强制出题时使用的题型工具名 */
  quizTool: Annotation<string | undefined>(),
});

type State = typeof BoenState.State;

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
export function buildBoenGraph(model: BaseChatModel) {
  const router = (state: State): Partial<State> => {
    const last = state.messages[state.messages.length - 1];
    if (last && isHumanMessage(last)) {
      const { force, tool } = detectQuizIntent(String(last.content));
      return { mode: state.mode ?? 'qa', forceQuiz: force, quizTool: tool };
    }
    // 非用户消息（如作答回灌的 ToolMessage）不触发出题
    return { mode: state.mode ?? 'qa', forceQuiz: false };
  };

  const qaNode = async (state: State): Promise<Partial<State>> => {
    const system = new SystemMessage(systemPromptForQa(state.gradeBand ?? 'middle'));
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

    const response = await llm.invoke([system, ...state.messages]);
    return { messages: [response] };
  };

  const graph = new StateGraph(BoenState)
    .addNode('router', router)
    .addNode('qa', qaNode)
    .addEdge('__start__', 'router')
    .addEdge('router', 'qa')
    .addEdge('qa', '__end__');

  return graph.compile({ checkpointer: new MemorySaver() });
}
