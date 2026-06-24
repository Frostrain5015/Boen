import { tool } from '@langchain/core/tools';
import { z } from 'zod';

export const LOOKUP_KNOWLEDGE_POINT_TOOL = 'lookup_knowledge_point';

export const lookupKnowledgePointSchema = z.object({
  query: z.string().min(1).describe('要查询的章节、知识点或学生问题关键词'),
  mode: z.enum(['auto', 'semantic', 'keyword', 'hybrid']).optional().default('auto')
    .describe('检索模式：auto 自动选择最佳方式，semantic 语义相似搜索，keyword 关键词精确匹配，hybrid 两者结合（默认 auto）'),
  grade: z.string().nullish().describe('可选年级；不填时使用当前学生年级'),
  subject: z.string().nullish().describe('可选学科；不填时使用当前对话学科'),
  limit: z.number().int().min(1).max(10).nullish().describe('最多返回多少条，默认 5'),
});

export type LookupKnowledgePointArgs = z.infer<typeof lookupKnowledgePointSchema>;

/**
 * 只作为模型可见的工具契约。实际执行在 graph 的 lookupKnowledgePoint 节点中，
 * 这样可以把当前 state.grade/subject 合并进查询，并保持 agent-core 不直连 DB。
 *
 * 模型可根据需要选择 mode：
 * - auto:    由服务端自动选择最佳检索方式（默认）
 * - semantic: 语义向量搜索，适合模糊概念、综合性提问
 * - keyword:  关键词精确匹配（FTS5/BM25），适合精确知识点名称、术语
 * - hybrid:   向量+关键词混合检索（RRF 融合排序），最全面的召回
 */
export const lookupKnowledgePointTool = tool(async () => '', {
  name: LOOKUP_KNOWLEDGE_POINT_TOOL,
  description:
    '查询当前学生年级和学科的人教版课程知识库，返回相关教材章节、知识点和学习上下文。适用于需要精确课程信息的场景。可通过 mode 参数选择检索策略：auto 自动、semantic 语义、keyword 关键词精确、hybrid 混合检索。',
  schema: lookupKnowledgePointSchema,
});
