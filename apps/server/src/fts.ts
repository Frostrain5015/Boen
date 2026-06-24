/**
 * FTS5 全文搜索模块。
 *
 * 基于 SQLite FTS5 实现 BM25 全文搜索，与向量语义搜索互补。
 * 用于「关键词精确匹配」场景（如知识点名称、术语），能找准
 * 向量搜索可能模糊掉的关键信息。
 */

import db from './db.js';

/** FTS5 搜索结果行 */
export interface FtsResult {
  content: string;
  refType: 'unit' | 'kp';
  refId: number;
  /** BM25 相关度分数（越大越相关） */
  score: number;
}

/**
 * 确保 FTS5 虚拟表和触发器存在。
 * 幂等：内部使用 CREATE VIRTUAL TABLE IF NOT EXISTS。
 */
export function ensureFtsTable(): void {
  // 创建 FTS5 虚拟表
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS curriculum_fts USING fts5(
      content,
      ref_type UNINDEXED,
      ref_id UNINDEXED,
      subject UNINDEXED,
      grade UNINDEXED,
      tokenize='unicode61 remove_diacritics 2'
    );
  `);
}

/**
 * 将一条 curriculum_embeddings 记录同步到 FTS 索。
 * 在 seed 阶段每写入一条 embedding 后调用。
 */
export function indexFtsRow(
  refType: 'unit' | 'kp',
  refId: number,
  subject: string,
  grade: string | null,
  content: string,
): void {
  db.prepare(`
    INSERT OR REPLACE INTO curriculum_fts (content, ref_type, ref_id, subject, grade)
    VALUES (?, ?, ?, ?, ?)
  `).run(content, refType, refId, subject, grade ?? '');
}

/**
 * 从现有 curriculum_embeddings 表重建全部 FTS 索引。
 * 用于：首次部署、FTS 表损坏、seed 脚本调用。
 */
export function rebuildFtsIndex(): number {
  ensureFtsTable();
  // 仅在 FTS 表为空时重建（避免每次启动重复删除+插入）
  const count = db.prepare(`SELECT COUNT(*) as cnt FROM curriculum_fts`).get() as { cnt: number } | undefined;
  if (count && count.cnt > 0) return count.cnt;
  // 清空旧索引（幂等安全）
  db.exec(`DELETE FROM curriculum_fts`);

  const rows = db.prepare(
    `SELECT ref_type, ref_id, subject, grade, content FROM curriculum_embeddings`,
  ).all() as { ref_type: string; ref_id: number; subject: string; grade: string | null; content: string }[];

  const insert = db.prepare(`
    INSERT INTO curriculum_fts (content, ref_type, ref_id, subject, grade)
    VALUES (?, ?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    for (const r of rows) {
      insert.run(r.content, r.ref_type, r.ref_id, r.subject, r.grade ?? '');
    }
  });
  tx();
  return rows.length;
}

/**
 * FTS5 + BM25 搜索。
 *
 * @param subject  学科过滤
 * @param grade    年级过
 * @param query    用户查询（将自动分词）
 * @param limit    返回上限
 * @returns        BM25 排序的结果列表
 */
export function searchFts(
  subject: string,
  grade: string,
  query: string,
  limit: number = 10,
): FtsResult[] {
  // 将中文/英文/数字用空格分隔，便于 FTS5 的 unicode61 tokenizer 处理
  // 中文字符已经是单字分割，这里只做基本的清理
  const sanitized = query.replace(/[^一-鿿\w]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!sanitized) return [];

  try {
    const rows = db.prepare(`
      SELECT
        f.content,
        f.ref_type,
        f.ref_id,
        bm25(curriculum_fts, 0.0, 1.0, 1.0, 1.0, 1.0) AS bm25_score
      FROM curriculum_fts f
      WHERE f.subject = ?
        AND f.grade = ?
        AND curriculum_fts MATCH ?
      ORDER BY bm25_score
      LIMIT ?
    `).all(subject, grade, sanitized, limit) as Array<{
      content: string;
      ref_type: string;
      ref_id: number;
      bm25_score: number;
    }>;

    // BM25 返回负数（越接近 0 越相关），转为正数以便 RRF 融合
    return rows.map((r) => ({
      content: r.content,
      refType: r.ref_type as 'unit' | 'kp',
      refId: r.ref_id,
      score: -r.bm25_score,
    }));
  } catch {
    // MATCH 语法错误（如查询包含 FTS5 特殊字符）时安全退化
    return [];
  }
}
