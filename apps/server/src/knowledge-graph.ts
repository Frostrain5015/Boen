/**
 * 博文知识图谱层（Knowledge Graph）
 *
 * 基于 2022 版新课标核心素养框架 + 教学系统设计理论，将教材章节、
 * 知识点、学科能力、核心素养以自由映射方式连接，为后续知识图谱
 * 导航系统和针对性练习系统提供基础设施。
 *
 * 节点类型（kg_nodes.type）：
 *   knowledge_point — 学科知识点（粒度小于等于教材小节）
 *   skill           — 学科能力（如运算能力、逻辑推理）
 *   literacy        — 核心素养（2022 课标四个维度）
 *   theme           — 主题领域（如「数与代数」「图形与几何」）
 *   cross_cutting   — 跨学科概念
 *   bloom_level     — 认知层次（布鲁姆分类学）
 *   question_type   — 考查题型（选择题、填空题等）
 *
 * 关系类型（kg_edges.type）：
 *   prerequisite  — 前置依赖（A 是 B 的前提）
 *   reinforces    — 强化关系（A 的学习增强 B）
 *   belongs_to    — 归属关系（A 属于 B 范畴）
 *   difficulty    — 难度层级（1-5）
 *   assesses      — 考查方式（某题型考查某知识点）
 *   bloom_at     — 布鲁姆层级标记
 *   related_to    — 自由关联
 */

import db from './db.js';

// ── 节点类型常量 ──────────────────────────────
export const KG_NODE_TYPES = [
  'knowledge_point',
  'skill',
  'literacy',
  'theme',
  'cross_cutting',
  'bloom_level',
  'question_type',
] as const;
export type KgNodeType = (typeof KG_NODE_TYPES)[number];

// ── 关系类型常量 ──────────────────────────────
export const KG_EDGE_TYPES = [
  'prerequisite',
  'reinforces',
  'belongs_to',
  'difficulty',
  'assesses',
  'bloom_at',
  'related_to',
] as const;
export type KgEdgeType = (typeof KG_EDGE_TYPES)[number];

// ── 主题领域（2022 课标各学科的内容领域）────────
export const MATH_THEMES = [
  { id: 'math_num_algebra', title: '数与代数', description: '数的认识与运算、式与方程、函数等内容领域' },
  { id: 'math_geo', title: '图形与几何', description: '图形的认识、测量、运动、位置等内容领域' },
  { id: 'math_stats', title: '统计与概率', description: '数据的收集/整理/描述、随机现象等内容领域' },
  { id: 'math_comprehensive', title: '综合与实践', description: '跨学科主题学习、项目式学习等内容领域' },
];

export const CHINESE_THEMES = [
  { id: 'chi_literacy', title: '识字与写字', description: '汉语拼音、汉字识记与书写' },
  { id: 'chi_reading', title: '阅读与鉴赏', description: '文学作品阅读、整本书阅读、古诗文阅读' },
  { id: 'chi_writing', title: '表达与交流', description: '口语交际、写作、书面表达' },
  { id: 'chi_comprehensive', title: '梳理与探究', description: '综合性学习、跨学科学习' },
];

export const ENGLISH_THEMES = [
  { id: 'eng_listening', title: '听的技能', description: '语音识别、听力理解' },
  { id: 'eng_speaking', title: '说的技能', description: '口语表达、语音语调、交际策略' },
  { id: 'eng_reading', title: '读的技能', description: '阅读理解、语篇分析' },
  { id: 'eng_writing', title: '写的技能', description: '书面表达、语法写作' },
  { id: 'eng_language', title: '语言知识', description: '语音/词汇/语法/语用知识' },
];

export const SCIENCE_THEMES = [
  { id: 'sci_matter', title: '物质科学', description: '物质的性质、变化、运动与相互作用' },
  { id: 'sci_life', title: '生命科学', description: '生物多样性、生命活动、遗传进化' },
  { id: 'sci_earth', title: '地球与宇宙', description: '地球系统、宇宙探索、天文现象' },
  { id: 'sci_tech', title: '技术与工程', description: '工程设计、技术应用、STEM实践' },
];

// ── 核心素养（2022 课标各学科核心素养维度）────
export const MATH_LITERACIES = [
  { id: 'lit_math_abstract', title: '抽象能力', description: '从具体数量关系中抽象出数学概念的能力' },
  { id: 'lit_math_reasoning', title: '推理意识/推理能力', description: '合情推理与演绎推理，有条理地思考' },
  { id: 'lit_math_model', title: '模型意识/模型观念', description: '用数学模型解决实际问题的意识与能力' },
  { id: 'lit_math_num_sense', title: '数感', description: '对数的意义、大小、运算的直觉感知' },
  { id: 'lit_math_measure', title: '量感', description: '对长度、面积、体积等度量属性的感知' },
  { id: 'lit_math_symbol', title: '符号意识', description: '理解并运用符号表示数量关系和一般规律' },
  { id: 'lit_math_space', title: '空间观念', description: '对空间图形的形状、大小、位置关系的认知' },
  { id: 'lit_math_geometry', title: '几何直观', description: '利用图形描述和分析数学问题的能力' },
  { id: 'lit_math_data', title: '数据意识', description: '用数据描述信息、进行推断的意识' },
  { id: 'lit_math_apply', title: '应用意识', description: '用数学的眼光观察现实世界的意识' },
  { id: 'lit_math_innovation', title: '创新意识', description: '发现和提出问题的能力，独立思考的习惯' },
];

export const CHINESE_LITERACIES = [
  { id: 'lit_chi_lang', title: '语言运用', description: '正确理解和运用国家通用语言文字的能力' },
  { id: 'lit_chi_think', title: '思维能力', description: '直觉思维、形象思维、逻辑思维的全面发展' },
  { id: 'lit_chi_aesthetic', title: '审美创造', description: '感受、理解、欣赏语言文字之美并创造表达' },
  { id: 'lit_chi_culture', title: '文化自信', description: '对中华优秀传统文化的认同与传承' },
];

export const ENGLISH_LITERACIES = [
  { id: 'lit_eng_lang', title: '语言能力', description: '在语境中感知、理解、运用英语的能力' },
  { id: 'lit_eng_culture', title: '文化意识', description: '对中外文化的理解与跨文化认知' },
  { id: 'lit_eng_think', title: '思维品质', description: '在英语学习中发展的逻辑与创造性思维' },
  { id: 'lit_eng_learn', title: '学习能力', description: '英语学习的方法、策略与自主能力' },
];

export const SCIENCE_LITERACIES = [
  { id: 'lit_sci_concept', title: '科学观念', description: '对物质世界的基本认识和科学世界观' },
  { id: 'lit_sci_think', title: '科学思维', description: '模型建构、推理论证、创新思维' },
  { id: 'lit_sci_inquiry', title: '探究实践', description: '观察实验、科学探究、技术与工程实践' },
  { id: 'lit_sci_attitude', title: '态度责任', description: '科学态度、社会责任、环保意识' },
];

// ── 布鲁姆认知分类 ────────────────────────────
export const BLOOM_LEVELS = [
  { id: 'bloom_remember', title: '记忆', description: '识别、回忆事实性信息', level: 1 },
  { id: 'bloom_understand', title: '理解', description: '解释、举例、分类、总结、推断', level: 2 },
  { id: 'bloom_apply', title: '应用', description: '在新情境中执行、实施已学知识', level: 3 },
  { id: 'bloom_analyze', title: '分析', description: '区分、组织、归因，厘清要素关系', level: 4 },
  { id: 'bloom_evaluate', title: '评价', description: '检查、批判、基于标准做出判断', level: 5 },
  { id: 'bloom_create', title: '创造', description: '生成、计划、产出原创性成果', level: 6 },
];

/** 按学科获取主题领域 */
export function themesForSubject(subject: string): typeof MATH_THEMES {
  switch (subject) {
    case 'math': return MATH_THEMES;
    case 'chinese': return CHINESE_THEMES;
    case 'english': return ENGLISH_THEMES;
    case 'science': return SCIENCE_THEMES;
    default: return MATH_THEMES;
  }
}

/** 按学科获取核心素养 */
export function literaciesForSubject(subject: string): typeof MATH_LITERACIES {
  switch (subject) {
    case 'math': return MATH_LITERACIES;
    case 'chinese': return CHINESE_LITERACIES;
    case 'english': return ENGLISH_LITERACIES;
    case 'science': return SCIENCE_LITERACIES;
    default: return MATH_LITERACIES;
  }
}

// ── DB 初始化：建表 ──────────────────────────
export function ensureKnowledgeGraphTables(): void {
  // 知识图谱节点（通用节点表，取代单薄的 knowledge_points）
  db.exec(`
    CREATE TABLE IF NOT EXISTS kg_nodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL CHECK(type IN ('${KG_NODE_TYPES.join("','")}')),
      subject TEXT,                              -- 所属学科，可空（跨学科可为 null）
      code TEXT,                                 -- 编码（如课标编码）
      title TEXT NOT NULL,
      description TEXT,
      metadata TEXT,                             -- JSON 灵活元数据
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(type, code)                         -- 同一类型下编码唯一
    );
    CREATE INDEX IF NOT EXISTS idx_kg_nodes_type ON kg_nodes(type);
    CREATE INDEX IF NOT EXISTS idx_kg_nodes_subject ON kg_nodes(subject);
  `);

  // 知识图谱边（自由映射关系）
  db.exec(`
    CREATE TABLE IF NOT EXISTS kg_edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id INTEGER NOT NULL,
      target_id INTEGER NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('${KG_EDGE_TYPES.join("','")}')),
      weight REAL DEFAULT 1.0,
      metadata TEXT,                             -- JSON 灵活元数据
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      FOREIGN KEY (source_id) REFERENCES kg_nodes(id) ON DELETE CASCADE,
      FOREIGN KEY (target_id) REFERENCES kg_nodes(id) ON DELETE CASCADE,
      UNIQUE(source_id, target_id, type)
    );
    CREATE INDEX IF NOT EXISTS idx_kg_edges_source ON kg_edges(source_id);
    CREATE INDEX IF NOT EXISTS idx_kg_edges_target ON kg_edges(target_id);
    CREATE INDEX IF NOT EXISTS idx_kg_edges_type ON kg_edges(type);
  `);

  // 章节 ↔ 知识图谱节点映射（取代旧的 unit_knowledge_map，
  // 但保留兼容；新数据同时写两边，逐步迁移）
  db.exec(`
    CREATE TABLE IF NOT EXISTS curriculum_kg_map (
      unit_id INTEGER NOT NULL,
      node_id INTEGER NOT NULL,
      relevance REAL DEFAULT 1.0,                -- 关联度（0~1）
      metadata TEXT,
      PRIMARY KEY (unit_id, node_id),
      FOREIGN KEY (unit_id) REFERENCES curriculum_units(id) ON DELETE CASCADE,
      FOREIGN KEY (node_id) REFERENCES kg_nodes(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_kgmap_unit ON curriculum_kg_map(unit_id);
    CREATE INDEX IF NOT EXISTS idx_kgmap_node ON curriculum_kg_map(node_id);
  `);
}

// ── 种子数据：注入学科主题领域 + 核心素养 + 布鲁姆分类 ─
export function seedKnowledgeGraph(): void {
  ensureKnowledgeGraphTables();

  const insNode = db.prepare(
    `INSERT OR IGNORE INTO kg_nodes (type, subject, code, title, description, metadata) VALUES (?, ?, ?, ?, ?, ?)`
  );

  const subjects = ['math', 'chinese', 'english', 'science'];

  // 1) 主题领域
  for (const subj of subjects) {
    for (const t of themesForSubject(subj)) {
      insNode.run('theme', subj, t.id, t.title, t.description, null);
    }
  }

  // 2) 核心素养
  for (const subj of subjects) {
    for (const l of literaciesForSubject(subj)) {
      insNode.run('literacy', subj, l.id, l.title, l.description, null);
    }
  }

  // 3) 布鲁姆分类（跨学科）
  for (const b of BLOOM_LEVELS) {
    insNode.run('bloom_level', null, b.id, b.title, b.description, JSON.stringify({ level: b.level }));
  }

  // 4) 预置主题 → 核心素养 的归属关系
  const insEdge = db.prepare(
    `INSERT OR IGNORE INTO kg_edges (source_id, target_id, type, weight) VALUES (?, ?, ?, ?)`
  );

  // 数学：四个主题 → 各相关素养
  const mathThemeLiteracyMap: Record<string, string[]> = {
    math_num_algebra: ['lit_math_num_sense', 'lit_math_symbol', 'lit_math_abstract', 'lit_math_reasoning', 'lit_math_apply'],
    math_geo: ['lit_math_space', 'lit_math_geometry', 'lit_math_measure', 'lit_math_reasoning'],
    math_stats: ['lit_math_data', 'lit_math_apply', 'lit_math_reasoning'],
    math_comprehensive: ['lit_math_apply', 'lit_math_innovation', 'lit_math_model'],
  };

  for (const [themeCode, litCodes] of Object.entries(mathThemeLiteracyMap)) {
    const themeNode = db.prepare(`SELECT id FROM kg_nodes WHERE type='theme' AND code=?`).get(themeCode) as { id: number } | undefined;
    if (!themeNode) continue;
    for (const litCode of litCodes) {
      const litNode = db.prepare(`SELECT id FROM kg_nodes WHERE type='literacy' AND code=?`).get(litCode) as { id: number } | undefined;
      if (litNode) insEdge.run(themeNode.id, litNode.id, 'belongs_to', 1.0);
    }
  }

  // 语文
  const chineseThemeLiteracyMap: Record<string, string[]> = {
    chi_literacy: ['lit_chi_lang'],
    chi_reading: ['lit_chi_lang', 'lit_chi_think', 'lit_chi_aesthetic', 'lit_chi_culture'],
    chi_writing: ['lit_chi_lang', 'lit_chi_think', 'lit_chi_aesthetic'],
    chi_comprehensive: ['lit_chi_think', 'lit_chi_culture'],
  };

  for (const [themeCode, litCodes] of Object.entries(chineseThemeLiteracyMap)) {
    const themeNode = db.prepare(`SELECT id FROM kg_nodes WHERE type='theme' AND code=?`).get(themeCode) as { id: number } | undefined;
    if (!themeNode) continue;
    for (const litCode of litCodes) {
      const litNode = db.prepare(`SELECT id FROM kg_nodes WHERE type='literacy' AND code=?`).get(litCode) as { id: number } | undefined;
      if (litNode) insEdge.run(themeNode.id, litNode.id, 'belongs_to', 1.0);
    }
  }

  console.log('[知识图谱] 种子数据已注入：主题领域 + 核心素养 + 布鲁姆分类');
}

// ── 查询接口 ─────────────────────────────────

/** 获取某类型下的所有节点 */
export function getNodesByType(type: KgNodeType, subject?: string): Array<{
  id: number; type: string; subject: string | null; code: string | null; title: string; description: string | null;
}> {
  const rows = subject
    ? db.prepare(`SELECT id, type, subject, code, title, description FROM kg_nodes WHERE type=? AND subject=? ORDER BY code`).all(type, subject)
    : db.prepare(`SELECT id, type, subject, code, title, description FROM kg_nodes WHERE type=? ORDER BY code`).all(type);
  return rows as Array<any>;
}

/** 获取某节点的所有邻居 */
export function getNeighbors(nodeId: number, edgeType?: KgEdgeType): Array<{
  nodeId: number; type: string; title: string; edgeType: string; weight: number; direction: 'outgoing' | 'incoming';
}> {
  const results: Array<any> = [];

  if (edgeType) {
    const outgoing = db.prepare(`
      SELECT n.id, n.type, n.title, e.type AS edge_type, e.weight
      FROM kg_edges e JOIN kg_nodes n ON n.id = e.target_id
      WHERE e.source_id=? AND e.type=?
    `).all(nodeId, edgeType) as Array<any>;
    for (const r of outgoing) results.push({ nodeId: r.id, type: r.type, title: r.title, edgeType: r.edge_type, weight: r.weight, direction: 'outgoing' });

    const incoming = db.prepare(`
      SELECT n.id, n.type, n.title, e.type AS edge_type, e.weight
      FROM kg_edges e JOIN kg_nodes n ON n.id = e.source_id
      WHERE e.target_id=? AND e.type=?
    `).all(nodeId, edgeType) as Array<any>;
    for (const r of incoming) results.push({ nodeId: r.id, type: r.type, title: r.title, edgeType: r.edge_type, weight: r.weight, direction: 'incoming' });
  } else {
    const outgoing = db.prepare(`
      SELECT n.id, n.type, n.title, e.type AS edge_type, e.weight
      FROM kg_edges e JOIN kg_nodes n ON n.id = e.target_id
      WHERE e.source_id=?
    `).all(nodeId) as Array<any>;
    for (const r of outgoing) results.push({ nodeId: r.id, type: r.type, title: r.title, edgeType: r.edge_type, weight: r.weight, direction: 'outgoing' });

    const incoming = db.prepare(`
      SELECT n.id, n.type, n.title, e.type AS edge_type, e.weight
      FROM kg_edges e JOIN kg_nodes n ON n.id = e.source_id
      WHERE e.target_id=?
    `).all(nodeId) as Array<any>;
    for (const r of incoming) results.push({ nodeId: r.id, type: r.type, title: r.title, edgeType: r.edge_type, weight: r.weight, direction: 'incoming' });
  }

  return results;
}

/** 自由映射：将章节与知识图谱节点关联 */
export function mapUnitToKgNode(unitId: number, nodeId: number, relevance = 1.0): void {
  db.prepare(`INSERT OR REPLACE INTO curriculum_kg_map (unit_id, node_id, relevance) VALUES (?, ?, ?)`).run(unitId, nodeId, relevance);
}

/** 批量映射：对指定学科年级，将每个知识点的章节关联到 kg 节点 */
export function syncUnitMappings(subject: string, grade: string): { mapped: number } {
  // 从旧 unit_knowledge_map + knowledge_points 读取映射，同步到新表
  const rows = db.prepare(`
    SELECT u.id AS unit_id, kp.title AS kp_title
    FROM unit_knowledge_map ukm
    JOIN curriculum_units u ON u.id = ukm.unit_id
    JOIN knowledge_points kp ON kp.id = ukm.knowledge_point_id
    JOIN curriculum_textbooks t ON t.id = u.textbook_id
    WHERE t.subject=? AND t.grade=?
  `).all(subject, grade) as Array<{ unit_id: number; kp_title: string }>;

  let count = 0;
  for (const row of rows) {
    // 在 kg_nodes 中查找或创建对应的 knowledge_point 节点
    let node = db.prepare(`SELECT id FROM kg_nodes WHERE type='knowledge_point' AND title=? AND subject=?`).get(row.kp_title, subject) as { id: number } | undefined;
    if (!node) {
      const r = db.prepare(`INSERT INTO kg_nodes (type, subject, title) VALUES ('knowledge_point', ?, ?)`).run(subject, row.kp_title);
      node = { id: Number(r.lastInsertRowid) };
    }
    db.prepare(`INSERT OR IGNORE INTO curriculum_kg_map (unit_id, node_id) VALUES (?, ?)`).run(row.unit_id, node.id);
    count++;
  }

  return { mapped: count };
}

/** 获取章节关联的知识图谱节点（含素养链） */
export function getKgContextForUnit(unitId: number): Array<{
  nodeId: number; type: string; title: string; relevance: number;
  chain: Array<{ nodeId: number; type: string; title: string; edgeType: string }>;
}> {
  const direct = db.prepare(`
    SELECT n.id AS node_id, n.type, n.title, m.relevance
    FROM curriculum_kg_map m
    JOIN kg_nodes n ON n.id = m.node_id
    WHERE m.unit_id=?
    ORDER BY m.relevance DESC
  `).all(unitId) as Array<{ node_id: number; type: string; title: string; relevance: number }>;

  return direct.map((d) => {
    const chain = getNeighbors(d.node_id).slice(0, 10);
    return {
      nodeId: d.node_id,
      type: d.type,
      title: d.title,
      relevance: d.relevance,
      chain: chain.map((c) => ({ nodeId: c.nodeId, type: c.type, title: c.title, edgeType: c.edgeType })),
    };
  });
}

/** 生成供 LLM 上下文注入的知识图谱文本描述 */
export function formatKgContext(unitId: number): string {
  const nodes = getKgContextForUnit(unitId);
  if (nodes.length === 0) return '';

  const parts: string[] = ['【知识图谱关联】'];
  for (const n of nodes) {
    const line = [`- ${n.title}（${n.type}）`];
    const skills = n.chain.filter((c) => c.type === 'skill' || c.type === 'literacy');
    if (skills.length) {
      line.push(` → 培养素养：${skills.map((s) => s.title).join('、')}`);
    }
    parts.push(line.join(''));
  }
  return parts.join('\n');
}
