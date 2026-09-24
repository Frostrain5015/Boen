/**
 * 查询改写（Query Rewriting）模块。
 *
 * 在学生提问后、检索知识库前，用 LLM 将口语化/缺上下文的提问改写为
 * 更清晰、更适合检索的形式，提高向量召回和 BM25 匹配的命中率。
 */

import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { SystemMessage, HumanMessage } from '@langchain/core/messages';

const REWRITE_SYSTEM = `你是一个教育知识库的查询优化器。你的任务是把学生的问题改写成更清晰、更适合检索的形式。

规则：
1. 保持原问题的核心知识点，补充学科、年级相关的术语
2. 去除口语化表达（如"那个"、"就是"）和修辞
3. 如果问题已经很清晰，直接返回原问题不修改
4. 如果问题是问候、简单确认或纯追问，直接返回原问题
5. 只输出改写后的查询文本，前后不要加引号、不要解释`;

/** 短查询、问候、确认、追问不改写（这些查询改写后反而会改变语义方向，误导检索） */
function shouldSkipRewrite(query: string): boolean {
  const t = query.trim();
  if (t.length < 6) return true;
  // 问候
  if (/^(你好|嗨|hi|hello|hey|早|晚上好|谢谢|感谢)/i.test(t)) return true;
  // 简短确认/追问
  if (/^(好[的吧么]?|行[吧]?|可以|嗯嗯|ok|是的|对[的啊]?|没错|继续|明白|知道了?|为什么|然后[呢]?|所以[呢]?|再讲讲|还有[吗]?)/i.test(t)) return true;
  return false;
}

let _model: BaseChatModel | null = null;

/**
 * 在服务启动时注入模型实例（单例，只需调用一次）。
 * 改写复用主对话模型（DeepSeek V4 Flash），不需要专用模型。
 */
export function setRewriteModel(model: BaseChatModel): void {
  _model = model;
}

/**
 * 将学生提问改写为更适合检索的查询。
 *
 * @param originalQuery  用户原始提问
 * @param subject        当前学科（如 "math"）
 * @param grade          当前年级（如 "7"）
 * @returns              改写后的查询（失败时返回原查询）
 */
export async function rewriteQuery(
  originalQuery: string,
  subject: string,
  grade: string,
): Promise<string> {
  if (shouldSkipRewrite(originalQuery) || !_model) return originalQuery;

  try {
    const response = await _model.invoke([
      new SystemMessage(REWRITE_SYSTEM),
      new HumanMessage(`学生问题：${originalQuery}\n学科：${subject}\n年级：${grade}`),
    ]);
    const rewritten = String(response.content).trim();
    // 防止模型返回空或与原文完全无关的内容
    if (!rewritten || rewritten.length > originalQuery.length * 3) return originalQuery;
    return rewritten;
  } catch (e) {
    console.warn('[query-rewriter] 改写失败，fallback 到原文:', e instanceof Error ? e.message : e);
    return originalQuery; // fallback 安全
  }
}
