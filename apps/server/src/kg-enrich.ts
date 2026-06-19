// kg-enrich.ts — 为已有知识点建立完整的语义映射
// 连接 知识点 → 主题领域 → 核心素养 → 认知层级

import db from './db.js';

const insEdge = db.prepare(
  `INSERT OR IGNORE INTO kg_edges (source_id, target_id, type, weight) VALUES (?, ?, ?, ?)`
);
const getNode = (type: string, code?: string, title?: string) => {
  if (code) return db.prepare(`SELECT id FROM kg_nodes WHERE type=? AND code=?`).get(type, code) as { id: number } | undefined;
  return db.prepare(`SELECT id FROM kg_nodes WHERE type=? AND title=?`).get(type, title) as { id: number } | undefined;
};

let edges = 0;

// 1) 每个数学知识点 → 所属主题领域
const kpThemes: Record<string, string> = {
  // 第一章 有理数 → 数与代数
  '正数和负数': 'math_num_algebra',
  '有理数的概念': 'math_num_algebra',
  '数轴': 'math_num_algebra',
  '相反数': 'math_num_algebra',
  '绝对值': 'math_num_algebra',
  '有理数的大小比较': 'math_num_algebra',
  // 第二章 有理数的运算 → 数与代数
  '有理数的加法': 'math_num_algebra',
  '有理数的减法': 'math_num_algebra',
  '有理数的乘法': 'math_num_algebra',
  '有理数的除法': 'math_num_algebra',
  '乘方': 'math_num_algebra',
  '科学记数法': 'math_num_algebra',
  '近似数': 'math_num_algebra',
  // 第三章 代数式 → 数与代数
  '列代数式表示数量关系': 'math_num_algebra',
  '代数式的值': 'math_num_algebra',
  // 第四章 整式的加减 → 数与代数
  '整式': 'math_num_algebra',
  '整式的加法与减法': 'math_num_algebra',
  // 第五章 一元一次方程 → 数与代数
  '从算式到方程': 'math_num_algebra',
  '等式的性质': 'math_num_algebra',
  '解一元一次方程': 'math_num_algebra',
  '实际问题与一元一次方程': 'math_num_algebra',
  // 第六章 几何图形初步 → 图形与几何
  '立体图形与平面图形': 'math_geo',
  '点线面体': 'math_geo',
  '直线射线线段': 'math_geo',
  '线段的比较与运算': 'math_geo',
  '角的概念': 'math_geo',
  '角的比较与运算': 'math_geo',
  '余角和补角': 'math_geo',
};

for (const [kpTitle, themeCode] of Object.entries(kpThemes)) {
  const kp = getNode('knowledge_point', undefined, kpTitle);
  const theme = getNode('theme', themeCode);
  if (kp && theme) { insEdge.run(kp.id, theme.id, 'belongs_to', 1.0); edges++; }
}

// 2) 数学知识点 → 培养的核心素养
const kpLiteracies: Record<string, string[]> = {
  // 数感：关于数的直觉
  '正数和负数': ['lit_math_num_sense', 'lit_math_symbol'],
  '有理数的概念': ['lit_math_num_sense', 'lit_math_abstract'],
  '数轴': ['lit_math_num_sense', 'lit_math_geometry'],
  '相反数': ['lit_math_num_sense', 'lit_math_symbol'],
  '绝对值': ['lit_math_num_sense', 'lit_math_abstract'],
  '有理数的大小比较': ['lit_math_num_sense', 'lit_math_reasoning'],
  '有理数的加法': ['lit_math_num_sense', 'lit_math_apply'],
  '有理数的减法': ['lit_math_num_sense', 'lit_math_apply'],
  '有理数的乘法': ['lit_math_num_sense', 'lit_math_apply'],
  '有理数的除法': ['lit_math_num_sense', 'lit_math_apply'],
  '乘方': ['lit_math_num_sense', 'lit_math_symbol'],
  '科学记数法': ['lit_math_num_sense', 'lit_math_apply'],
  '近似数': ['lit_math_num_sense', 'lit_math_data'],
  // 代数式与方程 → 抽象 + 符号 + 模型
  '列代数式表示数量关系': ['lit_math_abstract', 'lit_math_symbol', 'lit_math_model'],
  '代数式的值': ['lit_math_abstract', 'lit_math_apply'],
  '整式': ['lit_math_abstract', 'lit_math_symbol'],
  '整式的加法与减法': ['lit_math_abstract', 'lit_math_apply'],
  '从算式到方程': ['lit_math_abstract', 'lit_math_model'],
  '等式的性质': ['lit_math_reasoning', 'lit_math_abstract'],
  '解一元一次方程': ['lit_math_apply', 'lit_math_reasoning'],
  '实际问题与一元一次方程': ['lit_math_model', 'lit_math_apply', 'lit_math_innovation'],
  // 几何 → 空间观念 + 几何直观
  '立体图形与平面图形': ['lit_math_space', 'lit_math_geometry'],
  '点线面体': ['lit_math_space', 'lit_math_abstract'],
  '直线射线线段': ['lit_math_space', 'lit_math_geometry'],
  '线段的比较与运算': ['lit_math_space', 'lit_math_measure', 'lit_math_apply'],
  '角的概念': ['lit_math_space', 'lit_math_geometry'],
  '角的比较与运算': ['lit_math_space', 'lit_math_measure', 'lit_math_apply'],
  '余角和补角': ['lit_math_space', 'lit_math_reasoning', 'lit_math_apply'],
};

for (const [kpTitle, litCodes] of Object.entries(kpLiteracies)) {
  const kp = getNode('knowledge_point', undefined, kpTitle);
  if (!kp) continue;
  for (const litCode of litCodes) {
    const lit = getNode('literacy', litCode);
    if (lit) { insEdge.run(kp.id, lit.id, 'reinforces', 1.0); edges++; }
  }
}

// 3) 知识点间前置依赖（prerequisite）
const prerequisites: [string, string][] = [
  ['正数和负数', '有理数的概念'],
  ['有理数的概念', '数轴'],
  ['数轴', '相反数'],
  ['相反数', '绝对值'],
  ['绝对值', '有理数的大小比较'],
  ['有理数的概念', '有理数的加法'],
  ['有理数的加法', '有理数的减法'],
  ['有理数的减法', '有理数的乘法'],
  ['有理数的乘法', '有理数的除法'],
  ['有理数的概念', '乘方'],
  ['有理数的加法', '列代数式表示数量关系'],
  ['列代数式表示数量关系', '代数式的值'],
  ['列代数式表示数量关系', '整式'],
  ['整式', '整式的加法与减法'],
  ['从算式到方程', '等式的性质'],
  ['等式的性质', '解一元一次方程'],
  ['解一元一次方程', '实际问题与一元一次方程'],
  ['立体图形与平面图形', '点线面体'],
  ['点线面体', '直线射线线段'],
  ['直线射线线段', '线段的比较与运算'],
  ['直线射线线段', '角的概念'],
  ['角的概念', '角的比较与运算'],
  ['角的比较与运算', '余角和补角'],
];

for (const [from, to] of prerequisites) {
  const fromNode = getNode('knowledge_point', undefined, from);
  const toNode = getNode('knowledge_point', undefined, to);
  if (fromNode && toNode) { insEdge.run(fromNode.id, toNode.id, 'prerequisite', 1.0); edges++; }
}

// 4) 知识点 → 布鲁姆认知层级
const kpBloom: Record<string, string> = {
  '正数和负数': 'bloom_remember',
  '有理数的概念': 'bloom_understand',
  '数轴': 'bloom_understand',
  '相反数': 'bloom_understand',
  '绝对值': 'bloom_understand',
  '有理数的大小比较': 'bloom_apply',
  '有理数的加法': 'bloom_apply',
  '有理数的减法': 'bloom_apply',
  '有理数的乘法': 'bloom_apply',
  '有理数的除法': 'bloom_apply',
  '乘方': 'bloom_apply',
  '科学记数法': 'bloom_apply',
  '近似数': 'bloom_apply',
  '列代数式表示数量关系': 'bloom_understand',
  '代数式的值': 'bloom_apply',
  '整式': 'bloom_understand',
  '整式的加法与减法': 'bloom_apply',
  '从算式到方程': 'bloom_understand',
  '等式的性质': 'bloom_understand',
  '解一元一次方程': 'bloom_apply',
  '实际问题与一元一次方程': 'bloom_analyze',
  '立体图形与平面图形': 'bloom_remember',
  '点线面体': 'bloom_understand',
  '直线射线线段': 'bloom_understand',
  '线段的比较与运算': 'bloom_apply',
  '角的概念': 'bloom_remember',
  '角的比较与运算': 'bloom_apply',
  '余角和补角': 'bloom_apply',
};

for (const [kpTitle, bloomCode] of Object.entries(kpBloom)) {
  const kp = getNode('knowledge_point', undefined, kpTitle);
  const bloom = getNode('bloom_level', bloomCode);
  if (kp && bloom) { insEdge.run(kp.id, bloom.id, 'bloom_at', 1.0); edges++; }
}

console.log(`注入 ${edges} 条语义关系 ✓`);
console.log('');

// 验证：从 1.1 正数和负数 逆推素养链
const start = db.prepare(`SELECT id FROM kg_nodes WHERE type='knowledge_point' AND title='正数和负数'`).get() as any;
if (start) {
  console.log('═══ 正数和负数 → 知识图谱全景 ═══');

  // 向上追溯：正向关系
  const up = db.prepare(`
    SELECT e.type AS rel, n.type AS node_type, n.code, n.title
    FROM kg_edges e JOIN kg_nodes n ON n.id=e.target_id
    WHERE e.source_id=? AND e.type!='prerequisite'
    ORDER BY e.type
  `).all(start.id) as any[];
  console.log('所属 / 培养方向：');
  for (const u of up) console.log('  ╰', u.rel, '→', '['+u.node_type+']', u.code||'', u.title);

  // 前置知识（prerequisite 反向：别人 prerequisites→ 它）
  const pre = db.prepare(`
    SELECT n.title FROM kg_edges e JOIN kg_nodes n ON n.id=e.source_id
    WHERE e.target_id=? AND e.type='prerequisite'
  `).all(start.id) as any[];
  if (pre.length) console.log('前置知识（学这个之前需要会什么）：');
  for (const p of pre) console.log('  需要先掌握：' + p.title);

  // 后置知识（它 prerequisites→ 别人）
  const post = db.prepare(`
    SELECT n.title FROM kg_edges e JOIN kg_nodes n ON n.id=e.target_id
    WHERE e.source_id=? AND e.type='prerequisite'
  `).all(start.id) as any[];
  if (post.length) console.log('后置知识（学了这个才能学什么）：');
  for (const p of post) console.log('  支撑着：' + p.title);

  // 全链展示：正数和负数 → 主题 → 素养
  const theme = db.prepare(`
    SELECT n.title FROM kg_edges e JOIN kg_nodes n ON n.id=e.target_id
    WHERE e.source_id=? AND e.type='belongs_to' AND n.type='theme'
  `).get(start.id) as any;
  const lits = db.prepare(`
    SELECT n.title FROM kg_edges e JOIN kg_nodes n ON n.id=e.target_id
    WHERE e.source_id=? AND e.type='reinforces' AND n.type='literacy'
  `).all(start.id) as any;
  const bloom = db.prepare(`
    SELECT n.title FROM kg_edges e JOIN kg_nodes n ON n.id=e.target_id
    WHERE e.source_id=? AND e.type='bloom_at'
  `).get(start.id) as any;

  console.log('\n═══ 学生发展维度全景 ═══');
  console.log('学到「正数和负数」= 不只是认识两个符号');
  if (theme) console.log('  主题领域 →', theme.title);
  if (bloom) console.log('  认知层级 →', bloom.title);
  if (lits.length) console.log('  培养素养 →', lits.map((l:any)=>l.title).join('、'));
}

process.exit(0);
