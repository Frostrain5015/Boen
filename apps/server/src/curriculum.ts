import db from './db.js';
import { embedTexts, embedQuery, cosineSim, vectorToBlob, blobToVector } from './embeddings.js';
import { rewriteQuery } from './query-rewriter.js';
import { searchFts, indexFtsRow } from './fts.js';

// ── 入库数据格式（seed JSON）──────────────────
export interface UnitNode {
  title: string;
  kind?: string;                  // unit | chapter | lesson | section
  children?: UnitNode[];
  knowledgePoints?: string[];     // 关联知识点（按 title 引用）
}
export interface KnowledgePointSeed {
  title: string;
  description?: string;
  code?: string;
}
export interface TextbookSeed {
  subject: string;                // chinese | math | english | science
  grade: string;                  // '1'..'9'
  volume?: string;                // 上册 | 下册 | 全册
  publisher?: string;
  version?: string;
  sourceUrl?: string;
  units: UnitNode[];
  knowledgePoints?: KnowledgePointSeed[];
}

const SUBJECT_LABEL: Record<string, string> = { chinese: '语文', math: '数学', english: '英语', science: '科学' };
function gradeCn(grade: string): string {
  const n = Number(grade);
  return n <= 6 ? `小学${'一二三四五六'[n - 1]}年级` : `初中${['一', '二', '三'][n - 7] ?? grade}`;
}

// ── 入库（idempotent：同一册重灌会先清后写）──────
/** 灌入一册教材：写表 + 计算并存 embedding。返回该册写入的 unit / kp 数量。 */
export async function ingestTextbook(seed: TextbookSeed): Promise<{ units: number; kps: number }> {
  const subject = seed.subject;
  const grade = seed.grade;
  const volume = seed.volume ?? '全册';
  const publisher = seed.publisher ?? '人教版';

  // 1) 清理旧数据（按唯一键定位旧 textbook，连带其 units 的 embedding）
  const existing = db.prepare(
    `SELECT id FROM curriculum_textbooks WHERE subject=? AND grade=? AND volume=? AND publisher=?`,
  ).get(subject, grade, volume, publisher) as { id: number } | undefined;
  if (existing) {
    const oldUnitIds = db.prepare(`SELECT id FROM curriculum_units WHERE textbook_id=?`).all(existing.id) as { id: number }[];
    const delEmb = db.prepare(`DELETE FROM curriculum_embeddings WHERE ref_type='unit' AND ref_id=?`);
    const delMap = db.prepare(`DELETE FROM unit_knowledge_map WHERE unit_id=?`);
    for (const u of oldUnitIds) {
      delEmb.run(u.id);
      delMap.run(u.id);
    }
    db.prepare(`DELETE FROM curriculum_units WHERE textbook_id=?`).run(existing.id);
    db.prepare(`DELETE FROM curriculum_textbooks WHERE id=?`).run(existing.id);
  }

  // 2) 教材
  const tbId = Number(db.prepare(
    `INSERT INTO curriculum_textbooks (subject, grade, volume, publisher, version, source_url) VALUES (?,?,?,?,?,?)`,
  ).run(subject, grade, volume, publisher, seed.version ?? null, seed.sourceUrl ?? null).lastInsertRowid);

  // 3) 知识点（按 subject+title 复用，避免重复）
  const findKp = db.prepare(`SELECT id FROM knowledge_points WHERE subject=? AND title=?`);
  const insKp = db.prepare(`INSERT INTO knowledge_points (subject, grade, code, title, description) VALUES (?,?,?,?,?)`);
  const updKp = db.prepare(`UPDATE knowledge_points SET grade=COALESCE(grade, ?), code=COALESCE(?, code), description=COALESCE(?, description) WHERE id=?`);
  const kpIdByTitle = new Map<string, number>();
  const kpRowsToEmbed: { id: number; content: string }[] = [];
  for (const kp of seed.knowledgePoints ?? []) {
    const hit = findKp.get(subject, kp.title) as { id: number } | undefined;
    const content = kp.description ? `${kp.title}：${kp.description}` : kp.title;
    if (hit) {
      updKp.run(grade, kp.code ?? null, kp.description ?? null, hit.id);
      kpIdByTitle.set(kp.title, hit.id);
      kpRowsToEmbed.push({ id: hit.id, content });
      continue;
    }
    const id = Number(insKp.run(subject, grade, kp.code ?? null, kp.title, kp.description ?? null).lastInsertRowid);
    kpIdByTitle.set(kp.title, id);
    kpRowsToEmbed.push({ id, content });
  }

  // 4) 章节树（递归），收集 breadcrumb 作为 embedding 内容
  const insUnit = db.prepare(`INSERT INTO curriculum_units (textbook_id, parent_id, seq, title, kind) VALUES (?,?,?,?,?)`);
  const insMap = db.prepare(`INSERT OR IGNORE INTO unit_knowledge_map (unit_id, knowledge_point_id) VALUES (?,?)`);
  const head = `${SUBJECT_LABEL[subject] ?? subject}·${gradeCn(grade)}${volume}`;
  const unitRows: { id: number; content: string }[] = [];

  function walk(nodes: UnitNode[], parentId: number | null, trail: string[]) {
    nodes.forEach((node, i) => {
      const uid = Number(insUnit.run(tbId, parentId, i, node.title, node.kind ?? 'unit').lastInsertRowid);
      const crumb = [...trail, node.title];
      unitRows.push({ id: uid, content: `${head} / ${crumb.join(' / ')}` });
      for (const kpTitle of node.knowledgePoints ?? []) {
        const kpId = kpIdByTitle.get(kpTitle);
        if (kpId) insMap.run(uid, kpId);
      }
      if (node.children?.length) walk(node.children, uid, crumb);
    });
  }
  walk(seed.units, null, []);

  // 5) 批量计算 embedding 并存（unit 用 breadcrumb，kp 用 标题：描述）
  const insEmb = db.prepare(
    `INSERT OR REPLACE INTO curriculum_embeddings (ref_type, ref_id, subject, grade, content, embedding) VALUES (?,?,?,?,?,?)`,
  );
  const unitVecs = await embedTexts(unitRows.map((u) => u.content));
  unitRows.forEach((u, i) => insEmb.run('unit', u.id, subject, grade, u.content, vectorToBlob(unitVecs[i])));
  if (kpRowsToEmbed.length) {
    const kpVecs = await embedTexts(kpRowsToEmbed.map((k) => k.content));
    kpRowsToEmbed.forEach((k, i) => insEmb.run('kp', k.id, subject, grade, k.content, vectorToBlob(kpVecs[i])));
  }

  // 同步 FTS5 全文搜索索引
  for (const u of unitRows) {
    indexFtsRow('unit', u.id, subject, grade, u.content);
  }
  for (const k of kpRowsToEmbed) {
    indexFtsRow('kp', k.id, subject, grade, k.content);
  }

  return { units: unitRows.length, kps: kpRowsToEmbed.length };
}

// ── 检索（供 LangGraph loadCurriculum 节点调用）──────
/** 该年级该学科的教材编排顺序（章节树，缩进文本） */
export function getOutline(grade: string, subject: string): string {
  const books = db.prepare(
    `SELECT id, volume FROM curriculum_textbooks WHERE grade=? AND subject=? ORDER BY volume`,
  ).all(grade, subject) as { id: number; volume: string }[];
  if (books.length === 0) return '';
  const lines: string[] = [];
  const childrenOf = (textbookId: number, parentId: number | null) =>
    db.prepare(
      `SELECT id, title FROM curriculum_units WHERE textbook_id=? AND parent_id IS ? ORDER BY seq`,
    ).all(textbookId, parentId) as { id: number; title: string }[];
  for (const b of books) {
    if (books.length > 1) lines.push(`【${b.volume}】`);
    const render = (parentId: number | null, depth: number) => {
      for (const u of childrenOf(b.id, parentId)) {
        lines.push(`${'  '.repeat(depth)}- ${u.title}`);
        render(u.id, depth + 1);
      }
    };
    render(null, 0);
  }
  return lines.join('\n');
}

/** 与查询最相关的章节/知识点（按 grade+subject 硬过滤后向量召回） */
export async function retrieveRelated(
  grade: string,
  subject: string,
  query: string,
  k = 5,
): Promise<string[]> {
  const rows = db.prepare(
    `SELECT content, embedding FROM curriculum_embeddings WHERE grade=? AND subject=?`,
  ).all(grade, subject) as { content: string; embedding: Buffer }[];
  if (rows.length === 0) return [];
  const qv = await embedQuery(query);
  return rows
    .map((r) => ({ content: r.content, score: cosineSim(qv, blobToVector(r.embedding)) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((r) => r.content);
}

/**
 * 混合检索：向量语义 + BM25 全文搜索，RRF 融合排序。
 * 提供比纯向量检索更鲁棒的召回结果。
 */
async function hybridRetrieve(
  grade: string,
  subject: string,
  query: string,
  k = 5,
): Promise<string[]> {
  // 并行执行向量检索和 FTS5 检索，各取更多候选
  const [vectorResults, ftsResults] = await Promise.all([
    retrieveRelated(grade, subject, query, k * 3),
    searchFts(subject, grade, query, k * 3),
  ]);

  // RRF 融合：对每个结果在各列表中的排名取倒数
  const scores = new Map<string, number>();

  vectorResults.forEach((content, i) => {
    scores.set(content, (scores.get(content) ?? 0) + 1 / (60 + i));
  });
  ftsResults.forEach((r, i) => {
    scores.set(r.content, (scores.get(r.content) ?? 0) + 1 / (60 + i));
  });

  return Array.from(scores.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, k)
    .map(([content]) => content);
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/** LangGraph 工具：查询当前年级/学科下的相关知识点与教材章节（支持多模式检索）。 */
export async function lookupKnowledgePoint(args: {
  grade?: string;
  subject?: string;
  query: string;
  mode?: 'auto' | 'semantic' | 'keyword' | 'hybrid';
  limit?: number;
}): Promise<string> {
  const { grade, subject } = args;
  const query = args.query.trim();
  const limit = Math.min(Math.max(args.limit ?? 5, 1), 10);
  const mode = args.mode ?? 'auto';
  if (!grade || !subject || !/^[1-9]$/.test(grade)) return '当前年级或学科不在课程知识库范围内。';
  if (!query) return '查询词为空，无法检索课程知识点。';

  const parts: string[] = [];

  // mode: keyword / auto(含精确匹配倾向) → 执行 FTS5 关键词搜索 + LIKE 查找
  if (mode === 'keyword' || mode === 'hybrid' || mode === 'auto') {
    const like = `%${escapeLike(query)}%`;
    const matches = db.prepare(
      `SELECT title, description, code
       FROM knowledge_points
       WHERE subject=?
         AND (grade=? OR grade IS NULL)
         AND (title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' OR code LIKE ? ESCAPE '\\')
       ORDER BY title
       LIMIT ?`,
    ).all(subject, grade, like, like, like, limit) as { title: string; description: string | null; code: string | null }[];

    if (matches.length) {
      parts.push(
        '标题/描述匹配的知识点：\n' +
          matches
            .map((m) => `- ${m.code ? `[${m.code}] ` : ''}${m.title}${m.description ? `：${m.description}` : ''}`)
            .join('\n'),
      );
    }

    // keyword 模式下如果已经有关键词命中，直接返回
    if (mode === 'keyword' && matches.length > 0) {
      return parts.join('\n\n');
    }
  }

  // mode: semantic / hybrid / auto → 执行向量语义检索
  if (mode === 'semantic' || mode === 'hybrid' || (mode === 'auto' && parts.length === 0)) {
    const related = mode === 'hybrid'
      ? await hybridRetrieve(grade, subject, query, limit)
      : await retrieveRelated(grade, subject, query, limit);

    if (related.length) {
      parts.push('向量召回的相关章节/知识点：\n' + related.map((r) => `- ${r}`).join('\n'));
    }
  }

  if (parts.length === 0) return `没有在${gradeCn(grade)}·${SUBJECT_LABEL[subject] ?? subject}课程知识库中找到「${query}」。`;
  return parts.join('\n\n');
}

/**
 * 课程上下文：编排顺序 + 与本轮问题最相关的章节/知识点。
 * 供 LangGraph loadCurriculum 节点注入系统提示。高中/大学无教材库 → 返回空串。
 */
export async function retrieveCurriculum(args: { grade?: string; subject?: string; query?: string }): Promise<string> {
  const { grade, subject, query } = args;
  if (!grade || !subject || !/^[1-9]$/.test(grade)) return '';
  const outline = getOutline(grade, subject);
  if (!outline) return '';
  const parts = [`【当前学情】学生正在学「${gradeCn(grade)}·${SUBJECT_LABEL[subject] ?? subject}」，本学期教材编排如下：`, outline];
  if (query) {
    // 查询改写：将口语化提问改写为更适合检索的形式
    const rewritten = await rewriteQuery(query, subject, grade);
    const searchQuery = rewritten !== query ? rewritten : query;

    // 混合检索：向量语义 + BM25 全文搜索
    const related = await hybridRetrieve(grade, subject, searchQuery, 5);
    if (related.length) {
      const label = rewritten !== query ? `（检索优化："${query}" → "${rewritten}"）` : '';
      parts.push(`\n与学生当前问题最相关的章节/知识点：${label}\n` + related.map((c) => `- ${c}`).join('\n'));
    }
  }
  parts.push('\n讲解时贴合该教材的编排与进度，不超纲；可据此判断学生处于哪个章节、需要哪些前置知识。');
  parts.push('\n【学习周期提示】一个单元完整的闭环是：预习 → 同步练习 → 错题追练 → 单元复习 → 考前巩固。根据学生的提问和行为判断当前阶段，主动引导到下一步。');

  // 注入本年级知识点列表（含 ID，供 LLM 出题时精确引用 knowledgePointId）
  const kpList = db.prepare(
    `SELECT n.id, n.title FROM kg_nodes n
     JOIN curriculum_kg_map m ON m.node_id = n.id
     JOIN curriculum_units u ON u.id = m.unit_id
     JOIN curriculum_textbooks t ON t.id = u.textbook_id
     WHERE t.subject=? AND t.grade=? AND n.type='knowledge_point'
     GROUP BY n.id ORDER BY n.title`
  ).all(subject, grade) as { id: number; title: string }[];
  if (kpList.length > 0) {
    parts.push('\n【本年级已有知识点（出题时务必填写 knowledgePointId 字段，值为下方列表中的 ID；knowledgePoint 文本也要填但仅用于显示）】');
    const shown = kpList.slice(0, 50);
    for (const k of shown) {
      parts.push(`- [${k.id}] ${k.title}`);
    }
    if (kpList.length > 50) parts.push(`- ……（共 ${kpList.length} 个，仅列出前 50）`);
  }

  return parts.join('\n');
}
