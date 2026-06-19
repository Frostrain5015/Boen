/**
 * kg-weights.ts — 知识点权重体系
 *
 * 每个知识点在课程体系中的重要性不同，这直接影响：
 * - 出卷时知识点覆盖面的合理分布
 * - 智能体分配题目数量的比例
 * - 针对性练习时薄弱点的优先级排序
 *
 * 权重层级（kg_nodes.weight）：
 *   1.0 — 核心（Core）：必须掌握，中考高频，多课时
 *   0.75 — 重要（Important）：关键知识点，常考
 *   0.5  — 标准（Standard）：常规教学内容
 *   0.25 — 了解（Awareness）：拓展阅读、了解即可
 *   0.1  — 拓展（Enrichment）：选学内容、课外延伸
 *
 * 权重维度（kg_weight_dims）：
 *   class_hours  — 典型课时数
 *   exam_weight  — 考试权重 (0-1)，基于中考频次
 *   foundation   — 基础性 (0-1)，是否为后续学习基石
 *   overall      — 综合权重 (0-1)，由各维度加权计算
 */

import db from './db.js';

// ── 权重层级定义 ──────────────────────────────
export interface WeightTier {
  level: number;        // 0.1 ~ 1.0
  label: string;        // 中文标签
  description: string;
  /** 出题建议：100 道题中该层级应占的题目数 */
  paperRatio: number;
}

export const WEIGHT_TIERS: WeightTier[] = [
  { level: 1.0,  label: '核心',   description: '必须掌握，中考高频，多课时投入', paperRatio: 40 },
  { level: 0.75, label: '重要',   description: '关键知识点，常考，需熟练运用',   paperRatio: 30 },
  { level: 0.5,  label: '标准',   description: '常规教学内容，适度考查',         paperRatio: 20 },
  { level: 0.25, label: '了解',   description: '拓展阅读、了解即可，少考',       paperRatio: 7 },
  { level: 0.1,  label: '拓展',   description: '选学内容、课外延伸，不考',       paperRatio: 3 },
];

// ── DB 初始化 ─────────────────────────────────
export function ensureWeightTable(): void {
  // 给 kg_nodes 加 weight 列（安全：先检查再 ALTER）
  const hasCol = db.prepare(`PRAGMA table_info('kg_nodes')`).all() as Array<{ name: string }>;
  if (!hasCol.some((c) => c.name === 'weight')) {
    db.exec(`ALTER TABLE kg_nodes ADD COLUMN weight REAL DEFAULT 0.5`);
  }

  // 权重维度明细表
  db.exec(`
    CREATE TABLE IF NOT EXISTS kg_weight_dims (
      node_id INTEGER NOT NULL,
      class_hours INTEGER,          -- 典型课时
      exam_weight REAL,             -- 考试权重 0-1
      foundation REAL,              -- 基础性 0-1
      overall REAL DEFAULT 0.5,     -- 综合权重
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (node_id),
      FOREIGN KEY (node_id) REFERENCES kg_nodes(id) ON DELETE CASCADE
    );
  `);
}

// ── 权重 seeding ───────────────────────────────
// 基于人教社教师用书课时建议 + 中考考频分析

interface WeightSeed {
  title: string;
  weight: number;          // overall
  classHours: number;      // 课时
  examWeight: number;      // 考试权重
  foundation: number;      // 基础性
  tier: string;            // 说明
}

const MATH_G7_WEIGHTS: WeightSeed[] = [
  // ── 第一章 有理数（约18课时）─────────────────
  { title: '正数和负数',              weight: 0.75, classHours: 2,  examWeight: 0.6,  foundation: 1.0, tier: '重要：后续所有运算的基础' },
  { title: '有理数的概念',            weight: 1.0,  classHours: 1,  examWeight: 0.8,  foundation: 1.0, tier: '核心：整个初中代数的基石' },
  { title: '数轴',                    weight: 1.0,  classHours: 2,  examWeight: 1.0,  foundation: 1.0, tier: '核心：数形结合思想起点' },
  { title: '相反数',                  weight: 0.75, classHours: 1,  examWeight: 0.7,  foundation: 0.8, tier: '重要：绝对值、运算前置' },
  { title: '绝对值',                  weight: 1.0,  classHours: 2,  examWeight: 1.0,  foundation: 1.0, tier: '核心：中考必考，区分度大' },
  { title: '有理数的大小比较',        weight: 0.5,  classHours: 1,  examWeight: 0.4,  foundation: 0.5, tier: '标准：结合数轴考查' },
  { title: '有理数的加法',            weight: 1.0,  classHours: 2,  examWeight: 0.9,  foundation: 1.0, tier: '核心：四则运算起点' },
  { title: '有理数的减法',            weight: 1.0,  classHours: 2,  examWeight: 0.8,  foundation: 1.0, tier: '核心：与加法互逆' },
  { title: '有理数的乘法',            weight: 1.0,  classHours: 2,  examWeight: 0.9,  foundation: 1.0, tier: '核心：符号法则关键' },
  { title: '有理数的除法',            weight: 0.75, classHours: 1,  examWeight: 0.7,  foundation: 1.0, tier: '重要：乘除互逆' },
  { title: '乘方',                    weight: 0.75, classHours: 2,  examWeight: 0.7,  foundation: 0.8, tier: '重要：科学记数法的基础' },
  { title: '科学记数法',              weight: 0.75, classHours: 1,  examWeight: 0.8,  foundation: 0.3, tier: '重要：中考常考题型' },
  { title: '近似数',                  weight: 0.5,  classHours: 1,  examWeight: 0.4,  foundation: 0.3, tier: '标准：与科学记数法结合考' },
  // ── 第三章 代数式（约6课时）──────────────────
  { title: '列代数式表示数量关系',    weight: 1.0,  classHours: 3,  examWeight: 0.9,  foundation: 1.0, tier: '核心：方程、函数建模基础' },
  { title: '代数式的值',              weight: 0.75, classHours: 2,  examWeight: 0.6,  foundation: 0.8, tier: '重要：求值代入思想' },
  // ── 第四章 整式的加减（约8课时）─────────────
  { title: '整式',                    weight: 1.0,  classHours: 3,  examWeight: 0.8,  foundation: 1.0, tier: '核心：代数运算基础' },
  { title: '整式的加法与减法',        weight: 1.0,  classHours: 4,  examWeight: 0.9,  foundation: 1.0, tier: '核心：合并同类项、去括号' },
  // ── 第五章 一元一次方程（约16课时）──────────
  { title: '从算式到方程',            weight: 1.0,  classHours: 2,  examWeight: 0.7,  foundation: 1.0, tier: '核心：方程思想起点' },
  { title: '等式的性质',              weight: 1.0,  classHours: 2,  examWeight: 0.8,  foundation: 1.0, tier: '核心：解方程的依据' },
  { title: '解一元一次方程',          weight: 1.0,  classHours: 5,  examWeight: 1.0,  foundation: 1.0, tier: '核心：中考必考核心技能' },
  { title: '实际问题与一元一次方程',  weight: 1.0,  classHours: 4,  examWeight: 1.0,  foundation: 1.0, tier: '核心：建模能力，区分度大' },
  // ── 第六章 几何图形初步（约14课时）──────────
  { title: '立体图形与平面图形',      weight: 0.5,  classHours: 2,  examWeight: 0.4,  foundation: 0.5, tier: '标准：空间观念入门' },
  { title: '点线面体',                weight: 0.5,  classHours: 1,  examWeight: 0.2,  foundation: 0.5, tier: '标准：几何基本元素' },
  { title: '直线射线线段',            weight: 0.75, classHours: 3,  examWeight: 0.6,  foundation: 0.8, tier: '重要：几何推理基础' },
  { title: '线段的比较与运算',        weight: 0.75, classHours: 2,  examWeight: 0.6,  foundation: 0.7, tier: '重要：度量与比较' },
  { title: '角的概念',                weight: 0.5,  classHours: 2,  examWeight: 0.5,  foundation: 0.7, tier: '标准：角的后续学习基础' },
  { title: '角的比较与运算',          weight: 0.75, classHours: 2,  examWeight: 0.6,  foundation: 0.7, tier: '重要：角的计算' },
  { title: '余角和补角',              weight: 0.75, classHours: 2,  examWeight: 0.7,  foundation: 0.6, tier: '重要：中考常考概念' },
];

/** 注入权重数据 */
export function seedWeights(subject?: string): number {
  ensureWeightTable();
  const updates = subject ? MATH_G7_WEIGHTS : MATH_G7_WEIGHTS;
  let count = 0;

  const updateNode = db.prepare(`UPDATE kg_nodes SET weight=? WHERE type='knowledge_point' AND subject=? AND title=?`);
  const upsertDim = db.prepare(`
    INSERT OR REPLACE INTO kg_weight_dims (node_id, class_hours, exam_weight, foundation, overall, updated_at)
    VALUES (?, ?, ?, ?, ?, unixepoch())
  `);

  for (const s of updates) {
    const subj = subject || 'math';
    const node = db.prepare(`SELECT id FROM kg_nodes WHERE type='knowledge_point' AND subject=? AND title=?`).get(subj, s.title) as { id: number } | undefined;
    if (!node) continue;

    db.transaction(() => {
      updateNode.run(s.weight, subj, s.title);
      upsertDim.run(node.id, s.classHours, s.examWeight, s.foundation, s.weight);
    })();
    count++;
  }

  return count;
}

// ── 查询接口 ─────────────────────────────────
export function getWeightInfo(nodeId: number): {
  weight: number; tier: string; dims: { class_hours: number | null; exam_weight: number | null; foundation: number | null; overall: number | null };
} | null {
  const node = db.prepare(`SELECT weight, title FROM kg_nodes WHERE id=?`).get(nodeId) as { weight: number; title: string } | undefined;
  if (!node) return null;

  const dims = db.prepare(`SELECT class_hours, exam_weight, foundation, overall FROM kg_weight_dims WHERE node_id=?`).get(nodeId) as any;
  const tier = WEIGHT_TIERS.find((t) => t.level === node.weight);

  return {
    weight: node.weight,
    tier: tier ? `${tier.label}：${tier.description}` : `未知`,
    dims: dims || { class_hours: null, exam_weight: null, foundation: null, overall: null },
  };
}

/** 获取某学科某年级所有知识点的权重分布 */
export function getWeightDistribution(subject: string, grade?: string): Array<{
  title: string; weight: number; tier: string; classHours: number | null;
}> {
  let rows: any[];
  if (grade) {
    rows = db.prepare(`
      SELECT n.title, n.weight, d.class_hours
      FROM kg_weight_dims d
      JOIN kg_nodes n ON n.id = d.node_id
      JOIN curriculum_kg_map m ON m.node_id = n.id
      JOIN curriculum_units u ON u.id = m.unit_id
      JOIN curriculum_textbooks t ON t.id = u.textbook_id
      WHERE t.subject=? AND t.grade=?
      GROUP BY n.id
      ORDER BY n.weight DESC, d.class_hours DESC
    `).all(subject, grade) as any[];
  } else {
    rows = db.prepare(`
      SELECT n.title, n.weight, d.class_hours
      FROM kg_weight_dims d
      JOIN kg_nodes n ON n.id = d.node_id AND n.subject=?
      ORDER BY n.weight DESC, d.class_hours DESC
    `).all(subject) as any[];
  }

  return rows.map((r: any) => ({
    title: r.title,
    weight: r.weight,
    tier: (WEIGHT_TIERS.find((t) => t.level === r.weight)?.label) || '',
    classHours: r.class_hours,
  }));
}

/** 格式化权重分布描述（供模型 prompt 注入） */
export function formatWeightGuide(subject: string, grade: string): string {
  const dist = getWeightDistribution(subject, grade);
  if (dist.length === 0) return '';

  const byTier: Record<string, typeof dist> = {};
  for (const d of dist) {
    if (!byTier[d.tier]) byTier[d.tier] = [];
    byTier[d.tier].push(d);
  }

  const lines = ['【知识点权重分布——出题参考】'];
  for (const [tier, items] of Object.entries(byTier)) {
    const t = WEIGHT_TIERS.find((w) => w.label === tier);
    const ratio = t ? `（建议出卷占比 ${t.paperRatio}%）` : '';
    lines.push(`\n${tier} ${ratio}`);
    for (const item of items) {
      lines.push(`  ${item.title}（${item.classHours}课时）`);
    }
  }
  lines.push('\n原则：核心+重要题目应占总分的 70% 以上，了解+拓展不超过 10%。');
  return lines.join('\n');
}

// ── CLI 执行 ─────────────────────────────────
if (process.argv[1] && process.argv[1].includes('kg-weights')) {
  const subj = process.argv[2] || 'math';
  const grade = process.argv[3] || '7';
  const count = seedWeights(subj);

  console.log(`[权重] 已标注 ${count} 个知识点的权重（${subj} ${grade}）`);
  console.log('');

  const dist = getWeightDistribution(subj, grade);
  if (dist.length === 0) {
    console.log('提示：该学科/年级暂无权重数据');
    console.log('请先在 kg_nodes 中创建 knowledge_point 节点再运行');
  } else {
    console.log('权重分布：');
    for (const d of dist) {
      console.log(`  [${d.tier}] ${d.title} (${d.classHours}课时)`);
    }
    console.log('');
    console.log(formatWeightGuide(subj, grade));
  }

  process.exit(0);
}
