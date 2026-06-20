/**
 * 生产知识图谱灌入与验收。
 *
 * 本模块是唯一允许把课程库知识点批量同步到 KG 的入口：
 *   1. 所有教材知识点都有 kg_nodes 节点和 curriculum_kg_map 关系；
 *   2. 每个已发布节点都有主题、核心素养、Bloom 层级与权重；
 *   3. 映射 JSON 的旧格式先归一化，再安全写入；
 *   4. 不删除用户画像或既有人工边，整个过程可重复执行。
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import db from './db.js';
import { CURRICULUM_DIR } from './paths.js';
import {
  BLOOM_LEVELS,
  ensureKnowledgeGraphTables,
  literaciesForSubject,
  seedKnowledgeGraph,
  themesForSubject,
} from './knowledge-graph.js';
import { ensureWeightTable, seedWeights } from './kg-weights.js';

const SUBJECTS = ['chinese', 'english', 'math', 'science'] as const;
type Subject = typeof SUBJECTS[number];
type MappingKind = 'curated_mapping' | 'fallback_classification' | 'curriculum_sequence';

type CanonicalMapping = {
  prerequisites: Array<{ from: string; to: string }>;
  themes: Map<string, string>;
  literacies: Map<string, string[]>;
  blooms: Map<string, string>;
};

export type ProductionKgIssue = {
  subject: string;
  grade: string;
  kps: number;
  missingThemes: number;
  missingLiteracies: number;
  missingBlooms: number;
  missingWeights: number;
  prerequisiteParticipants: number;
};

export type ProductionKgAudit = {
  integrity: string;
  foreignKeyViolations: number;
  legacyKnowledgePointsWithoutGraphNode: number;
  mappedKnowledgePointsWithoutUnit: number;
  duplicateGraphKnowledgePoints: number;
  selfEdges: number;
  crossSubjectKnowledgeEdges: number;
  scopes: ProductionKgIssue[];
  failures: string[];
};

function hashCode(subject: string, title: string): string {
  return `kp_${subject}_${createHash('sha256').update(`${subject}:${title}`).digest('hex').slice(0, 20)}`;
}

function asSubject(value: string): Subject | null {
  return (SUBJECTS as readonly string[]).includes(value) ? value as Subject : null;
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim())
    : [];
}

function plainObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function emptyMapping(): CanonicalMapping {
  return { prerequisites: [], themes: new Map(), literacies: new Map(), blooms: new Map() };
}

function addPrerequisite(mapping: CanonicalMapping, from: unknown, to: unknown): void {
  if (typeof from !== 'string' || typeof to !== 'string') return;
  const a = from.trim();
  const b = to.trim();
  if (a && b && a !== b) mapping.prerequisites.push({ from: a, to: b });
}

function normalizeAssignment(
  value: unknown,
  output: Map<string, string>,
): void {
  for (const [key, raw] of Object.entries(plainObject(value))) {
    if (typeof raw === 'string') {
      output.set(key, raw);
      continue;
    }
    // 兼容旧格式：{ themeCode: [knowledgePointTitle, ...] }
    if (Array.isArray(raw)) {
      for (const title of toStringArray(raw)) output.set(title, key);
    }
  }
}

function normalizeLiteracyAssignment(value: unknown, output: Map<string, string[]>): void {
  for (const [key, raw] of Object.entries(plainObject(value))) {
    if (!Array.isArray(raw)) continue;
    const items = toStringArray(raw);
    if (!items.length) continue;
    const looksLikeLiteracyCode = /^lit_/.test(key);
    if (looksLikeLiteracyCode) {
      // 兼容旧格式：{ literacyCode: [knowledgePointTitle, ...] }
      for (const title of items) {
        const current = output.get(title) ?? [];
        if (!current.includes(key)) current.push(key);
        output.set(title, current);
      }
    } else {
      output.set(key, items);
    }
  }
}

/** 兼容当前仓库内的新旧映射 JSON，并输出灌入器唯一接受的四组关系。 */
export function normalizeKgMapping(raw: unknown): CanonicalMapping {
  const source = plainObject(raw);
  const mapping = emptyMapping();

  for (const edge of Array.isArray(source.prerequisites) ? source.prerequisites : []) {
    const item = plainObject(edge);
    addPrerequisite(mapping, item.from, item.to);
  }
  normalizeAssignment(source.themes, mapping.themes);
  normalizeLiteracyAssignment(source.literacies, mapping.literacies);
  normalizeAssignment(source.blooms ?? source.bloomLevels, mapping.blooms);

  // English G7 的 kpMap 与 Science G9 的 nodes 都是旧导出格式；其内部字段才是实际语义关系。
  for (const rawNode of Object.values(plainObject(source.kpMap ?? source.nodes))) {
    const node = plainObject(rawNode);
    const title = typeof node.title === 'string' ? node.title.trim() : '';
    if (!title) continue;
    if (typeof node.theme === 'string') mapping.themes.set(title, node.theme);
    const literacies = toStringArray(node.literacies);
    if (literacies.length) mapping.literacies.set(title, literacies);
    if (typeof node.bloom === 'string') mapping.blooms.set(title, node.bloom);
    for (const prerequisite of toStringArray(node.prerequisites ?? node.prereq)) {
      addPrerequisite(mapping, prerequisite, title);
    }
  }

  mapping.prerequisites = [...new Map(mapping.prerequisites.map((edge) => [`${edge.from}\u0000${edge.to}`, edge])).values()];
  return mapping;
}

function readMappings(): Map<Subject, CanonicalMapping> {
  const result = new Map<Subject, CanonicalMapping>();
  for (const subject of SUBJECTS) result.set(subject, emptyMapping());
  const dir = join(CURRICULUM_DIR, 'kg-mappings');
  if (!existsSync(dir)) return result;

  for (const file of readdirSync(dir)) {
    if (!/^[a-z]+-G\d+\.json$/.test(file)) continue;
    try {
      const raw = JSON.parse(readFileSync(join(dir, file), 'utf8')) as { subject?: string };
      const subject = raw.subject ? asSubject(raw.subject) : asSubject(file.split('-')[0]);
      if (!subject) continue;
      const target = result.get(subject)!;
      const normalized = normalizeKgMapping(raw);
      normalized.prerequisites.forEach((edge) => target.prerequisites.push(edge));
      normalized.themes.forEach((code, title) => target.themes.set(title, code));
      normalized.literacies.forEach((codes, title) => target.literacies.set(title, codes));
      normalized.blooms.forEach((code, title) => target.blooms.set(title, code));
    } catch (error) {
      console.warn(`[production-kg] 跳过无法解析的映射文件 ${file}:`, error instanceof Error ? error.message : error);
    }
  }
  return result;
}

function metadata(kind: MappingKind, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ source: kind, ...extra });
}

function getNodeByCode(type: string, code: string): { id: number } | undefined {
  return db.prepare(`SELECT id FROM kg_nodes WHERE type=? AND code=?`).get(type, code) as { id: number } | undefined;
}

function getKnowledgeNode(subject: string, title: string): { id: number; title: string } | undefined {
  return db.prepare(`SELECT id, title FROM kg_nodes WHERE type='knowledge_point' AND subject=? AND title=?`).get(subject, title) as { id: number; title: string } | undefined;
}

function ensureEdge(sourceId: number, targetId: number, type: string, kind: MappingKind, extra: Record<string, unknown> = {}): void {
  db.prepare(`
    INSERT INTO kg_edges (source_id, target_id, type, weight, metadata)
    VALUES (?, ?, ?, 1.0, ?)
    ON CONFLICT(source_id, target_id, type) DO NOTHING
  `).run(sourceId, targetId, type, metadata(kind, extra));
}

const THEME_LITERACIES: Record<Subject, Record<string, string[]>> = {
  math: {
    math_num_algebra: ['lit_math_num_sense', 'lit_math_symbol', 'lit_math_abstract', 'lit_math_reasoning', 'lit_math_apply'],
    math_geo: ['lit_math_space', 'lit_math_geometry', 'lit_math_measure', 'lit_math_reasoning'],
    math_stats: ['lit_math_data', 'lit_math_apply', 'lit_math_reasoning'],
    math_comprehensive: ['lit_math_apply', 'lit_math_innovation', 'lit_math_model'],
  },
  chinese: {
    chi_literacy: ['lit_chi_lang'],
    chi_reading: ['lit_chi_lang', 'lit_chi_think', 'lit_chi_aesthetic', 'lit_chi_culture'],
    chi_writing: ['lit_chi_lang', 'lit_chi_think', 'lit_chi_aesthetic'],
    chi_comprehensive: ['lit_chi_think', 'lit_chi_culture'],
  },
  english: {
    eng_listening: ['lit_eng_lang', 'lit_eng_learn'],
    eng_speaking: ['lit_eng_lang', 'lit_eng_culture', 'lit_eng_think'],
    eng_reading: ['lit_eng_lang', 'lit_eng_think', 'lit_eng_learn'],
    eng_writing: ['lit_eng_lang', 'lit_eng_think', 'lit_eng_learn'],
    eng_language: ['lit_eng_lang', 'lit_eng_learn'],
  },
  science: {
    sci_matter: ['lit_sci_concept', 'lit_sci_think', 'lit_sci_inquiry'],
    sci_life: ['lit_sci_concept', 'lit_sci_think', 'lit_sci_inquiry', 'lit_sci_attitude'],
    sci_earth: ['lit_sci_concept', 'lit_sci_think', 'lit_sci_inquiry', 'lit_sci_attitude'],
    sci_tech: ['lit_sci_think', 'lit_sci_inquiry', 'lit_sci_attitude'],
  },
};

function inferTheme(subject: Subject, title: string): string {
  const text = title.toLowerCase();
  if (subject === 'math') {
    if (/统计|数据|概率|平均|中位|众数|频数|图表|扇形|条形|方差/.test(text)) return 'math_stats';
    if (/图形|几何|角|线|三角|四边|圆|坐标|平行|垂直|相交|面积|体积|周长|长度|位置|对称|投影|视图|立体|比例尺/.test(text)) return 'math_geo';
    if (/实践|综合|探索|活动|建模|策略/.test(text)) return 'math_comprehensive';
    return 'math_num_algebra';
  }
  if (subject === 'chinese') {
    if (/拼音|汉字|识字|书写|词语|词汇|成语|标点|病句|语法|朗读/.test(text)) return 'chi_literacy';
    if (/写作|作文|习作|书信|日记|演讲|口语|表达|描写/.test(text)) return 'chi_writing';
    if (/综合|实践|探究|文化|活动/.test(text)) return 'chi_comprehensive';
    return 'chi_reading';
  }
  if (subject === 'english') {
    if (/听力/.test(text)) return 'eng_listening';
    if (/口语|对话|交流|演讲|问候|介绍/.test(text)) return 'eng_speaking';
    if (/阅读|语篇|完形|理解|检索/.test(text)) return 'eng_reading';
    if (/写作|作文|书信|邮件|日记/.test(text)) return 'eng_writing';
    return 'eng_language';
  }
  if (/生物|细胞|人体|植物|动物|遗传|生态|生命/.test(text)) return 'sci_life';
  if (/地球|天体|宇宙|气候|天气|岩石|矿物|地形|灾害/.test(text)) return 'sci_earth';
  if (/工程|技术|设计|材料|工具|控制|模型制作/.test(text)) return 'sci_tech';
  return 'sci_matter';
}

function inferBloom(title: string): string {
  if (/记忆|识别|名称|字母|拼音|词汇/.test(title)) return 'bloom_remember';
  if (/概念|定义|性质|认识|组成|分类|特点|意义/.test(title)) return 'bloom_understand';
  if (/分析|比较|判断|辨析|归纳|推理|阅读理解/.test(title)) return 'bloom_analyze';
  if (/设计|创作|写作|制作|方案|探究报告/.test(title)) return 'bloom_create';
  if (/评价|反思|鉴赏/.test(title)) return 'bloom_evaluate';
  return 'bloom_apply';
}

function hasOutgoing(nodeId: number, type: string): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM kg_edges WHERE source_id=? AND type=? LIMIT 1`).get(nodeId, type));
}

/**
 * Older seeders could create a second node for the same subject/title before
 * curriculum mapping had been established.  Remove only a duplicate that is
 * provably orphaned; anything referenced by a learner record, question,
 * mapping, edge, or weight is deliberately retained for manual migration and
 * therefore remains visible to the production audit.
 */
function dropOrphanDuplicateKnowledgeNodes(): number {
  const groups = db.prepare(`
    SELECT subject, title, GROUP_CONCAT(id) AS ids
    FROM kg_nodes
    WHERE type='knowledge_point'
    GROUP BY subject, title
    HAVING COUNT(*) > 1
  `).all() as Array<{ subject: string; title: string; ids: string }>;
  const referenceCount = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM curriculum_kg_map WHERE node_id=?) +
      (SELECT COUNT(*) FROM kg_edges WHERE source_id=? OR target_id=?) +
      (SELECT COUNT(*) FROM kg_weight_dims WHERE node_id=?) +
      (SELECT COUNT(*) FROM user_kp_proficiency WHERE kg_node_id=?) +
      (SELECT COUNT(*) FROM mistake_kp_map WHERE kg_node_id=?) +
      (SELECT COUNT(*) FROM mistake_proficiency_events WHERE kg_node_id=?) AS n
  `);
  const remove = db.prepare(`DELETE FROM kg_nodes WHERE id=?`);
  let removed = 0;

  const tx = db.transaction(() => {
    for (const group of groups) {
      const candidates = group.ids.split(',').map(Number).filter(Number.isInteger).map((id) => ({
        id,
        references: (referenceCount.get(id, id, id, id, id, id, id) as { n: number }).n,
      })).sort((a, b) => b.references - a.references || a.id - b.id);
      // Keep the most referenced (then oldest) node.  Only delete nodes whose
      // reference count is exactly zero, so no learner-visible history moves.
      for (const candidate of candidates.slice(1)) {
        if (candidate.references !== 0) continue;
        remove.run(candidate.id);
        removed++;
      }
    }
  });
  tx();
  return removed;
}

function syncCurriculumNodes(): number {
  const rows = db.prepare(`
    SELECT DISTINCT ukm.unit_id, kp.subject, kp.title, COALESCE(kp.description, '') AS description
    FROM unit_knowledge_map ukm
    JOIN knowledge_points kp ON kp.id=ukm.knowledge_point_id
  `).all() as Array<{ unit_id: number; subject: string; title: string; description: string }>;
  const find = db.prepare(`SELECT id, code FROM kg_nodes WHERE type='knowledge_point' AND subject=? AND title=?`);
  const insert = db.prepare(`
    INSERT INTO kg_nodes (type, subject, code, title, description, metadata)
    VALUES ('knowledge_point', ?, ?, ?, ?, ?)
  `);
  const setCode = db.prepare(`UPDATE kg_nodes SET code=COALESCE(code, ?), description=COALESCE(NULLIF(description, ''), ?) WHERE id=?`);
  const map = db.prepare(`
    INSERT INTO curriculum_kg_map (unit_id, node_id, relevance, metadata)
    VALUES (?, ?, 1.0, ?)
    ON CONFLICT(unit_id, node_id) DO UPDATE SET relevance=MAX(curriculum_kg_map.relevance, excluded.relevance)
  `);
  let created = 0;

  const tx = db.transaction(() => {
    for (const row of rows) {
      let node = find.get(row.subject, row.title) as { id: number; code: string | null } | undefined;
      if (!node) {
        const id = Number(insert.run(row.subject, hashCode(row.subject, row.title), row.title, row.description || null, metadata('curated_mapping', { origin: 'curriculum' })).lastInsertRowid);
        node = { id, code: hashCode(row.subject, row.title) };
        created++;
      } else {
        setCode.run(hashCode(row.subject, row.title), row.description || null, node.id);
      }
      map.run(row.unit_id, node.id, metadata('curated_mapping', { origin: 'curriculum' }));
    }
  });
  tx();
  return created;
}

function seedThemeLiteracyOntology(): void {
  for (const subject of SUBJECTS) {
    for (const [themeCode, literacyCodes] of Object.entries(THEME_LITERACIES[subject])) {
      const theme = getNodeByCode('theme', themeCode);
      if (!theme) continue;
      for (const literacyCode of literacyCodes) {
        const literacy = getNodeByCode('literacy', literacyCode);
        if (literacy) ensureEdge(theme.id, literacy.id, 'belongs_to', 'curated_mapping', { origin: 'theme_literacy_ontology' });
      }
    }
  }
}

function seedSemanticEdges(): void {
  const mappings = readMappings();
  for (const subject of SUBJECTS) {
    const mapping = mappings.get(subject)!;
    for (const edge of mapping.prerequisites) {
      const from = getKnowledgeNode(subject, edge.from);
      const to = getKnowledgeNode(subject, edge.to);
      if (from && to) ensureEdge(from.id, to.id, 'prerequisite', 'curated_mapping', { origin: 'mapping_json' });
    }
  }

  const nodes = db.prepare(`
    SELECT DISTINCT n.id, n.subject, n.title
    FROM kg_nodes n
    JOIN curriculum_kg_map m ON m.node_id=n.id
    WHERE n.type='knowledge_point'
    ORDER BY n.subject, n.id
  `).all() as Array<{ id: number; subject: string; title: string }>;

  for (const node of nodes) {
    const subject = asSubject(node.subject);
    if (!subject) continue;
    const mapping = mappings.get(subject)!;
    const themeCode = mapping.themes.get(node.title) ?? inferTheme(subject, node.title);
    const theme = getNodeByCode('theme', themeCode);
    if (theme && !hasOutgoing(node.id, 'belongs_to')) {
      ensureEdge(node.id, theme.id, 'belongs_to', mapping.themes.has(node.title) ? 'curated_mapping' : 'fallback_classification', { themeCode });
    }

    const literacyCodes = mapping.literacies.get(node.title) ?? THEME_LITERACIES[subject][themeCode] ?? [];
    if (!hasOutgoing(node.id, 'reinforces')) {
      for (const literacyCode of literacyCodes) {
        const literacy = getNodeByCode('literacy', literacyCode);
        if (literacy) ensureEdge(node.id, literacy.id, 'reinforces', mapping.literacies.has(node.title) ? 'curated_mapping' : 'fallback_classification', { literacyCode });
      }
    }

    const bloomCode = mapping.blooms.get(node.title) ?? inferBloom(node.title);
    const bloom = getNodeByCode('bloom_level', bloomCode);
    if (bloom && !hasOutgoing(node.id, 'bloom_at')) {
      ensureEdge(node.id, bloom.id, 'bloom_at', mapping.blooms.has(node.title) ? 'curated_mapping' : 'fallback_classification', { bloomCode });
    }
  }
}

/** 仅补充低置信度“教材相邻关系”，不冒充前置依赖，画像追溯仍只使用人工/映射文件中的 prerequisite。 */
function seedCurriculumSequenceEdges(): void {
  const scopes = db.prepare(`SELECT DISTINCT subject, grade FROM curriculum_textbooks ORDER BY subject, CAST(grade AS INTEGER)`).all() as Array<{ subject: string; grade: string }>;
  for (const scope of scopes) {
    const nodes = db.prepare(`
      SELECT n.id
      FROM kg_nodes n
      JOIN curriculum_kg_map m ON m.node_id=n.id
      JOIN curriculum_units u ON u.id=m.unit_id
      JOIN curriculum_textbooks t ON t.id=u.textbook_id
      WHERE n.type='knowledge_point' AND t.subject=? AND t.grade=?
      GROUP BY n.id
      ORDER BY MIN(t.volume), MIN(u.seq), n.title
    `).all(scope.subject, scope.grade) as Array<{ id: number }>;
    for (let index = 1; index < nodes.length; index++) {
      const previous = nodes[index - 1].id;
      const current = nodes[index].id;
      const connected = db.prepare(`
        SELECT 1 FROM kg_edges
        WHERE type IN ('prerequisite', 'related_to')
          AND ((source_id=? AND target_id=?) OR (source_id=? AND target_id=?))
        LIMIT 1
      `).get(previous, current, current, previous);
      if (!connected) ensureEdge(previous, current, 'related_to', 'curriculum_sequence', { subject: scope.subject, grade: scope.grade, confidence: 0.35 });
    }
  }
}

function fillWeightGaps(): void {
  const scopes = db.prepare(`SELECT DISTINCT subject, grade FROM curriculum_textbooks ORDER BY subject, CAST(grade AS INTEGER)`).all() as Array<{ subject: string; grade: string }>;
  for (const scope of scopes) seedWeights(scope.subject, scope.grade);

  const missing = db.prepare(`
    SELECT DISTINCT n.id
    FROM kg_nodes n
    JOIN curriculum_kg_map m ON m.node_id=n.id
    WHERE n.type='knowledge_point'
      AND NOT EXISTS (SELECT 1 FROM kg_weight_dims d WHERE d.node_id=n.id)
  `).all() as Array<{ id: number }>;
  const setNodeWeight = db.prepare(`UPDATE kg_nodes SET weight=COALESCE(weight, 0.5) WHERE id=?`);
  const insertDim = db.prepare(`
    INSERT INTO kg_weight_dims (node_id, class_hours, exam_weight, foundation, overall)
    VALUES (?, 1, 0.5, 0.5, 0.5)
    ON CONFLICT(node_id) DO NOTHING
  `);
  const tx = db.transaction(() => {
    for (const node of missing) {
      setNodeWeight.run(node.id);
      insertDim.run(node.id);
    }
  });
  tx();
}

/** 批量修复当前数据库；可安全重复执行。 */
export function repairProductionKnowledgeGraph(): { createdNodes: number; removedDuplicateNodes: number; audit: ProductionKgAudit } {
  ensureKnowledgeGraphTables();
  ensureWeightTable();
  seedKnowledgeGraph();
  const removedDuplicateNodes = dropOrphanDuplicateKnowledgeNodes();
  const createdNodes = syncCurriculumNodes();
  seedThemeLiteracyOntology();
  seedSemanticEdges();
  seedCurriculumSequenceEdges();
  fillWeightGaps();
  const audit = auditProductionKnowledgeGraph();
  return { createdNodes, removedDuplicateNodes, audit };
}

/** 对所有“数据库中实际发布”的学科/年级进行生产准入审计。 */
export function auditProductionKnowledgeGraph(): ProductionKgAudit {
  const integrity = (db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check;
  const foreignKeyViolations = (db.prepare('PRAGMA foreign_key_check').all() as unknown[]).length;
  const scopes = db.prepare(`
    WITH scoped AS (
      SELECT DISTINCT t.subject, t.grade, n.id AS node_id
      FROM curriculum_textbooks t
      JOIN curriculum_units u ON u.textbook_id=t.id
      JOIN curriculum_kg_map m ON m.unit_id=u.id
      JOIN kg_nodes n ON n.id=m.node_id AND n.type='knowledge_point'
    )
    SELECT subject, grade, COUNT(*) AS kps,
      SUM(EXISTS(SELECT 1 FROM kg_edges e WHERE e.source_id=scoped.node_id AND e.type='belongs_to')) AS missingThemesInverse,
      SUM(EXISTS(SELECT 1 FROM kg_edges e WHERE e.source_id=scoped.node_id AND e.type='reinforces')) AS missingLiteraciesInverse,
      SUM(EXISTS(SELECT 1 FROM kg_edges e WHERE e.source_id=scoped.node_id AND e.type='bloom_at')) AS missingBloomsInverse,
      SUM(EXISTS(SELECT 1 FROM kg_weight_dims d WHERE d.node_id=scoped.node_id)) AS weighted,
      SUM(EXISTS(SELECT 1 FROM kg_edges e WHERE (e.source_id=scoped.node_id OR e.target_id=scoped.node_id) AND e.type='prerequisite')) AS prerequisiteParticipants
    FROM scoped
    GROUP BY subject, grade
    ORDER BY subject, CAST(grade AS INTEGER)
  `).all() as Array<{
    subject: string; grade: string; kps: number;
    missingThemesInverse: number; missingLiteraciesInverse: number; missingBloomsInverse: number;
    weighted: number; prerequisiteParticipants: number;
  }>;

  const scopeIssues: ProductionKgIssue[] = scopes.map((scope) => ({
    subject: scope.subject,
    grade: scope.grade,
    kps: scope.kps,
    missingThemes: scope.kps - scope.missingThemesInverse,
    missingLiteracies: scope.kps - scope.missingLiteraciesInverse,
    missingBlooms: scope.kps - scope.missingBloomsInverse,
    missingWeights: scope.kps - scope.weighted,
    prerequisiteParticipants: scope.prerequisiteParticipants,
  }));

  const legacyKnowledgePointsWithoutGraphNode = (db.prepare(`
    SELECT COUNT(DISTINCT kp.id) AS n
    FROM knowledge_points kp
    JOIN unit_knowledge_map ukm ON ukm.knowledge_point_id=kp.id
    WHERE NOT EXISTS (
      SELECT 1 FROM kg_nodes n
      WHERE n.type='knowledge_point' AND n.subject=kp.subject AND n.title=kp.title
    )
  `).get() as { n: number }).n;
  const mappedKnowledgePointsWithoutUnit = (db.prepare(`
    SELECT COUNT(*) AS n FROM kg_nodes n
    WHERE n.type='knowledge_point' AND NOT EXISTS (SELECT 1 FROM curriculum_kg_map m WHERE m.node_id=n.id)
  `).get() as { n: number }).n;
  const duplicateGraphKnowledgePoints = (db.prepare(`
    SELECT COUNT(*) AS n FROM (
      SELECT subject, title FROM kg_nodes WHERE type='knowledge_point' GROUP BY subject, title HAVING COUNT(*)>1
    )
  `).get() as { n: number }).n;
  const selfEdges = (db.prepare(`SELECT COUNT(*) AS n FROM kg_edges WHERE source_id=target_id`).get() as { n: number }).n;
  const crossSubjectKnowledgeEdges = (db.prepare(`
    SELECT COUNT(*) AS n FROM kg_edges e
    JOIN kg_nodes a ON a.id=e.source_id
    JOIN kg_nodes b ON b.id=e.target_id
    WHERE a.type='knowledge_point' AND b.type='knowledge_point' AND a.subject<>b.subject
  `).get() as { n: number }).n;

  const failures: string[] = [];
  if (integrity !== 'ok') failures.push(`SQLite integrity_check=${integrity}`);
  if (foreignKeyViolations) failures.push(`发现 ${foreignKeyViolations} 条外键违规`);
  if (legacyKnowledgePointsWithoutGraphNode) failures.push(`${legacyKnowledgePointsWithoutGraphNode} 个教材知识点未同步到图谱`);
  if (duplicateGraphKnowledgePoints) failures.push(`${duplicateGraphKnowledgePoints} 组图谱知识点标题重复`);
  if (selfEdges) failures.push(`${selfEdges} 条图谱自环`);
  if (crossSubjectKnowledgeEdges) failures.push(`${crossSubjectKnowledgeEdges} 条跨学科知识点边`);
  for (const scope of scopeIssues) {
    if (!scope.kps) failures.push(`${scope.subject} G${scope.grade} 没有可发布知识点`);
    if (scope.missingThemes || scope.missingLiteracies || scope.missingBlooms || scope.missingWeights) {
      failures.push(`${scope.subject} G${scope.grade} 图谱覆盖不完整：主题-${scope.missingThemes}，素养-${scope.missingLiteracies}，Bloom-${scope.missingBlooms}，权重-${scope.missingWeights}`);
    }
  }

  return {
    integrity,
    foreignKeyViolations,
    legacyKnowledgePointsWithoutGraphNode,
    mappedKnowledgePointsWithoutUnit,
    duplicateGraphKnowledgePoints,
    selfEdges,
    crossSubjectKnowledgeEdges,
    scopes: scopeIssues,
    failures,
  };
}

export function assertProductionKnowledgeGraph(): ProductionKgAudit {
  const audit = auditProductionKnowledgeGraph();
  if (audit.failures.length) throw new Error(`知识图谱未达到生产准入：${audit.failures.join('；')}`);
  return audit;
}

if (process.argv[1]?.includes('production-kg')) {
  const verifyOnly = process.argv.includes('--verify');
  const run = async () => {
    if (!verifyOnly) {
      const backupPath = join(CURRICULUM_DIR, '..', 'data', `boen.before-production-kg-${Date.now()}.db`);
      await db.backup(backupPath);
      console.log(`[production-kg] 已创建数据库备份：${backupPath}`);
      const result = repairProductionKnowledgeGraph();
      console.log(`[production-kg] 新建 ${result.createdNodes} 个知识点节点`);
      console.log(`[production-kg] 清理 ${result.removedDuplicateNodes} 个无引用重复节点`);
    }
    const audit = assertProductionKnowledgeGraph();
    console.log(`[production-kg] 生产验收通过：${audit.scopes.length} 个已发布学科年级单元`);
  };
  run().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
