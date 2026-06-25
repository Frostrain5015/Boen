/**
 * 长期对话记忆（跨会话）模块。
 *
 * 功能：
 * 1. 会话结束时：LLM 生成结构化摘要 → 向量化存储
 * 2. 会话开始时：检索最近 K 条相关历史摘要 → 注入 system prompt
 */

import db from './db.js';
import { embedTexts, embedQuery, cosineSim, vectorToBlob, blobToVector } from './embeddings.js';
import { getMessages } from './conversation.js';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { SystemMessage, HumanMessage } from '@langchain/core/messages';

// ── 常量 ───────────────────────────────────────
/** 每个用户最多保留的摘要条数（超出删除最旧） */
const MAX_SUMMARIES_PER_USER = 50;
/** 记忆检索时间窗口（天） */
const MEMORY_WINDOW_DAYS = 30;
/** 最大注入摘要条数 */
const MAX_INJECT_MEMORIES = 3;
/** 摘要相关度阈值（低于此值跳过注入）。bge-small-zh 区分度有限，基线 ~0.63，需 ≥0.70 才有实质语义相关。 */
const SIMILARITY_THRESHOLD = 0.70;

// ── Prompt ─────────────────────────────────────
const SUMMARY_SYSTEM = `你是一个教育助手的对话摘要器。分析以下一段师生对话，生成结构化的摘要。

输出格式（严格按以下格式，纯文本）：

知识点：<本段涉及的知识点，最多 5 个，用顿号分隔>
学生水平：<beginner|developing|proficient|advanced>
主题标签：<主题词，逗号分隔，如"分数乘法, 通分, 约分">
未解决问题：<学生表示困惑或没有答上来的点，没有则写"无">
摘要：<2-4 句话概括对话内容、学生表现和教学进度>`;

// ── 类型 ───────────────────────────────────────
interface ParsedSummary {
  summary: string;
  topics: string;
  proficiencyLevel: string;
  unresolvedQuestions: string;
}

/** 解析模型输出的结构化摘要 */
function parseSummary(text: string): ParsedSummary {
  const result: ParsedSummary = {
    summary: '',
    topics: '',
    proficiencyLevel: 'unknown',
    unresolvedQuestions: '无',
  };

  const lines = text.split('\n');
  let currentKey = '';
  const sections: Record<string, string[]> = {};

  for (const line of lines) {
    const trimmed = line.trim();
    const keyMatch = trimmed.match(/^(知识点|学生水平|主题标签|未解决问题|摘要)[：:]\s*(.*)/);
    if (keyMatch) {
      currentKey = keyMatch[1];
      sections[currentKey] = [keyMatch[2]];
    } else if (currentKey && trimmed) {
      sections[currentKey]?.push(trimmed);
    }
  }

  if (sections['摘要']) result.summary = sections['摘要'].join(' ');
  if (sections['主题标签']) result.topics = sections['主题标签'].join(' ');
  if (sections['学生水平']) result.proficiencyLevel = sections['学生水平'][0].trim().toLowerCase();
  if (sections['未解决问题']) result.unresolvedQuestions = sections['未解决问题'].join(' ');

  return result;
}

/**
 * 使用 LLM 从对话消息生成结构化摘要。
 */
export async function generateConversationSummary(
  model: BaseChatModel,
  messages: { role: string; content: string }[],
  subject: string,
): Promise<ParsedSummary> {
  // 只取最后 30 条消息，避免超长
  const dialogText = messages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .slice(-30)
    .map(m => `${m.role === 'user' ? '学生' : '老师'}：${String(m.content).slice(0, 500)}`)
    .join('\n');

  if (!dialogText.trim()) {
    return { summary: '（对话内容为空）', topics: subject, proficiencyLevel: 'unknown', unresolvedQuestions: '无' };
  }

  try {
    const response = await model.invoke([
      new SystemMessage(SUMMARY_SYSTEM),
      new HumanMessage(`学科：${subject}\n\n对话：\n${dialogText}`),
    ]);
    return parseSummary(String(response.content));
  } catch (err) {
    console.warn('[memory] summary generation failed:', err);
    return { summary: '（摘要生成失败）', topics: subject, proficiencyLevel: 'unknown', unresolvedQuestions: '无' };
  }
}

/**
 * 存储一条对话摘要到数据库。
 * 同时清理该用户超出上限的旧摘要。
 */
export function storeConversationSummary(
  userId: string,
  conversationId: string,
  subject: string,
  summary: string,
  topics: string,
  proficiencyLevel: string,
  unresolvedQuestions: string,
  embedding: number[],
): void {
  const id = `sum-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const now = Math.floor(Date.now() / 1000);

  db.prepare(`
    INSERT INTO conversation_summaries (id, user_id, conversation_id, subject, summary, topics, proficiency_level, unresolved_questions, created_at, embedding)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, userId, conversationId, subject, summary, topics, proficiencyLevel, unresolvedQuestions, now, vectorToBlob(embedding));

  // 限制条数：超出则删除最旧的
  const count = db.prepare(
    `SELECT COUNT(*) as cnt FROM conversation_summaries WHERE user_id = ?`
  ).get(userId) as { cnt: number };
  if (count.cnt > MAX_SUMMARIES_PER_USER) {
    const excess = count.cnt - MAX_SUMMARIES_PER_USER;
    db.prepare(`
      DELETE FROM conversation_summaries WHERE id IN (
        SELECT id FROM conversation_summaries WHERE user_id = ? ORDER BY created_at ASC LIMIT ?
      )
    `).run(userId, excess);
  }
}

/**
 * 异步生成并存储对话摘要（不阻塞响应流）。
 * 在 SSE 流结束后由 server 调用。
 */
export async function generateConversationSummaryAsync(
  userId: string,
  conversationId: string,
  subject: string,
  model: BaseChatModel,
): Promise<void> {
  try {
    const msgs = getMessages(conversationId);
    if (msgs.length < 3) return; // 消息太少，不值得生成摘要

    const parsed = await generateConversationSummary(model, msgs, subject);
    if (!parsed.summary || parsed.summary.length < 5) return;

    // 对摘要做向量化用于后续检索
    const [emb] = await embedTexts([parsed.summary]);
    storeConversationSummary(
      userId, conversationId, subject,
      parsed.summary, parsed.topics, parsed.proficiencyLevel,
      parsed.unresolvedQuestions, emb,
    );
    console.log(`[memory] 已生成摘要 for conversation ${conversationId.slice(0, 12)}…`);
  } catch (err) {
    console.warn('[memory] async summary generation failed:', err);
  }
}

/**
 * 检索与当前查询最相关的历史对话摘要。
 * 按向量相似度排序，取 top-K，低于阈值的跳过。
 */
export async function retrieveRelevantMemories(
  userId: string,
  query: string,
  subject: string,
): Promise<string> {
  if (!userId || !query) return '';

  // 取该用户最近 30 天的摘要
  const cutoff = Date.now() / 1000 - MEMORY_WINDOW_DAYS * 86400;
  const rows = db.prepare(`
    SELECT summary, topics, proficiency_level, unresolved_questions, embedding
    FROM conversation_summaries
    WHERE user_id = ? AND subject = ? AND created_at >= ?
    ORDER BY created_at DESC
    LIMIT 20
  `).all(userId, subject, cutoff) as Array<{
    summary: string;
    topics: string;
    proficiency_level: string;
    unresolved_questions: string;
    embedding: Buffer;
  }>;

  if (!rows.length) return '';

  const qv = await embedQuery(query);

  // 计算相关度并排序
  const scored = rows
    .map(r => ({
      summary: r.summary,
      topics: r.topics,
      proficiencyLevel: r.proficiency_level,
      unresolvedQuestions: r.unresolved_questions,
      score: cosineSim(qv, blobToVector(r.embedding)),
    }))
    .filter(r => r.score >= SIMILARITY_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_INJECT_MEMORIES);

  if (!scored.length) return '';

  const lines = scored.map(r =>
    `- 主题：${r.topics || '未知'} | 水平：${r.proficiencyLevel}
  摘要：${r.summary}
  未解决问题：${r.unresolvedQuestions || '无'}`
  );

  return `\n## 🕐 历史关联\n学生之前讨论过以下内容：\n${lines.join('\n---\n')}\n\n请利用这些历史信息调整教学节奏，避免重复已掌握的内容，并关注上次未解决的问题。\n【⚠ 绝对禁止】不要在回复开头提及、复述或总结上述历史对话内容。直接回答学生当前的问题，历史信息仅用于内部调整教学策略。`;
}
