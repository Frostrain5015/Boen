/**
 * Graph-level contract check for interactive questions.
 *
 * This uses a deterministic in-memory model: no API key, database, or network
 * is required. It prevents quiz tools from accidentally being routed through
 * ToolNode again, which would erase the human-in-the-loop pause.
 */
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { Command } from '@langchain/langgraph';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import Database from 'better-sqlite3';
import { buildBoenGraph } from '@boen/agent-core';
let turns = 0;
const questionId = 'interrupt-question-1';
const fakeModel = {
    bindTools() {
        return this;
    },
    async invoke() {
        turns += 1;
        if (turns === 1) {
            return new AIMessage({
                content: '',
                tool_calls: [{
                        id: questionId,
                        name: 'ask_multiple_choice',
                        args: { stem: '验证题', options: [], correctKeys: ['A'], knowledgePointId: 1 },
                    }],
            });
        }
        return new AIMessage({ content: '已收到学生答案，继续讲解。' });
    },
};
const checkpointDb = new Database(':memory:');
const graph = buildBoenGraph(fakeModel, {}, new SqliteSaver(checkpointDb));
const config = { configurable: { thread_id: 'verify-question-interrupt' } };
await graph.invoke({
    messages: [new HumanMessage('请出一道题')],
    gradeBand: 'middle',
    grade: '7',
    subject: 'math',
}, config);
const paused = await graph.getState(config);
const interrupt = paused.tasks.flatMap((task) => task.interrupts).find((item) => item.value?.type === 'question');
if (interrupt?.value?.toolCallId !== questionId) {
    throw new Error('题目工具没有进入可恢复的 LangGraph interrupt');
}
const resumed = await graph.invoke(new Command({
    resume: { type: 'answer', toolCallId: questionId, toolContent: '{"correct":true}' },
}), config);
const messages = resumed.messages;
if (!messages.some((message) => message._getType() === 'tool' && message.tool_call_id === questionId)) {
    throw new Error('Command.resume 没有写入题目对应的 ToolMessage');
}
if (turns !== 2)
    throw new Error(`恢复后模型调用次数异常：${turns}`);
let skippedTurns = 0;
const skipModel = {
    bindTools() {
        return this;
    },
    async invoke() {
        skippedTurns += 1;
        return new AIMessage({
            content: '',
            tool_calls: [{ id: 'interrupt-skip-1', name: 'ask_true_false', args: { stem: '跳过验证题', answer: true, knowledgePointId: 1 } }],
        });
    },
};
const skipDb = new Database(':memory:');
const skipGraph = buildBoenGraph(skipModel, {}, new SqliteSaver(skipDb));
const skipConfig = { configurable: { thread_id: 'verify-question-skip' } };
await skipGraph.invoke({ messages: [new HumanMessage('请出一道题')], gradeBand: 'middle', grade: '7', subject: 'math' }, skipConfig);
await skipGraph.invoke(new Command({
    resume: { type: 'skip', toolCallId: 'interrupt-skip-1', toolContent: '（用户未作答此题，已跳过）' },
}), skipConfig);
if (skippedTurns !== 1)
    throw new Error('跳过题目后不应触发额外的模型回复');
checkpointDb.close();
skipDb.close();
console.log('Question interrupt/resume contract passed');
