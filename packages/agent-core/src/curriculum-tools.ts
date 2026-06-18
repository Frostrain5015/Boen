import { tool } from '@langchain/core/tools';
import { z } from 'zod';

export const LOOKUP_KNOWLEDGE_POINT_TOOL = 'lookup_knowledge_point';

export const lookupKnowledgePointSchema = z.object({
  query: z.string().min(1).describe('要查询的章节、知识点或学生问题关键词'),
  grade: z.string().nullish().describe('可选年级；不填时使用当前学生年级'),
  subject: z.string().nullish().describe('可选学科；不填时使用当前对话学科'),
  limit: z.number().int().min(1).max(10).nullish().describe('最多返回多少条，默认 5'),
});

export type LookupKnowledgePointArgs = z.infer<typeof lookupKnowledgePointSchema>;

/**
 * 只作为模型可见的工具契约。实际执行在 graph 的 lookupKnowledgePoint 节点中，
 * 这样可以把当前 state.grade/subject 合并进查询，并保持 agent-core 不直连 DB。
 */
export const lookupKnowledgePointTool = tool(async () => '', {
  name: LOOKUP_KNOWLEDGE_POINT_TOOL,
  description:
    '查询当前学生年级和学科的人教版课程知识库，返回相关教材章节、知识点和学习上下文。适合在回答前确认学生正在学什么、相关前置知识或不超纲范围。',
  schema: lookupKnowledgePointSchema,
});
