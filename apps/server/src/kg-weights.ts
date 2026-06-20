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

// ── 数学 G8 权重（基于人教社2024修订版）─────────
const MATH_G8_WEIGHTS: WeightSeed[] = [
  // ── 上册 第十三章 三角形（约10课时）───────────
  { title: '三角形的概念',              weight: 0.75, classHours: 1,  examWeight: 0.6,  foundation: 0.9, tier: '重要：几何推理基础' },
  { title: '三角形的边',                weight: 1.0,  classHours: 2,  examWeight: 0.9,  foundation: 1.0, tier: '核心：三边关系常考' },
  { title: '三角形的中线角平分线和高',  weight: 0.75, classHours: 2,  examWeight: 0.7,  foundation: 0.8, tier: '重要：重要线段概念' },
  { title: '三角形的内角',              weight: 1.0,  classHours: 2,  examWeight: 1.0,  foundation: 1.0, tier: '核心：内角和定理必考' },
  { title: '三角形的外角',              weight: 0.75, classHours: 1,  examWeight: 0.7,  foundation: 0.8, tier: '重要：外角定理应用' },
  { title: '多边形',                    weight: 0.5,  classHours: 1,  examWeight: 0.4,  foundation: 0.5, tier: '标准：多边形基本概念' },
  { title: '多边形的内角和',            weight: 0.75, classHours: 1,  examWeight: 0.7,  foundation: 0.6, tier: '重要：公式应用' },
  // ── 上册 第十四章 全等三角形（约10课时）───────
  { title: '全等三角形及其性质',        weight: 1.0,  classHours: 2,  examWeight: 0.9,  foundation: 1.0, tier: '核心：全等概念基础' },
  { title: '三角形全等的判定',          weight: 1.0,  classHours: 5,  examWeight: 1.0,  foundation: 1.0, tier: '核心：中考必考证明题' },
  { title: '角的平分线',                weight: 0.75, classHours: 2,  examWeight: 0.7,  foundation: 0.7, tier: '重要：角平分线性质' },
  // ── 上册 第十五章 轴对称（约10课时）───────────
  { title: '轴对称及其性质',            weight: 1.0,  classHours: 2,  examWeight: 0.9,  foundation: 1.0, tier: '核心：轴对称性质必考' },
  { title: '线段的垂直平分线',          weight: 0.75, classHours: 2,  examWeight: 0.7,  foundation: 0.8, tier: '重要：垂直平分线性质' },
  { title: '画轴对称的图形',            weight: 0.5,  classHours: 1,  examWeight: 0.4,  foundation: 0.5, tier: '标准：作图技能' },
  { title: '等腰三角形',                weight: 1.0,  classHours: 3,  examWeight: 1.0,  foundation: 1.0, tier: '核心：等腰三角形性质与判定' },
  { title: '等边三角形',                weight: 0.75, classHours: 1,  examWeight: 0.7,  foundation: 0.7, tier: '重要：特殊等腰三角形' },
  // ── 上册 第十六章 整式的乘法（约12课时）───────
  { title: '同底数幂的乘法',            weight: 0.75, classHours: 2,  examWeight: 0.7,  foundation: 0.9, tier: '重要：幂运算基础' },
  { title: '幂的乘方与积的乘方',        weight: 0.75, classHours: 2,  examWeight: 0.7,  foundation: 0.8, tier: '重要：运算法则' },
  { title: '整式的乘法',                weight: 1.0,  classHours: 3,  examWeight: 0.9,  foundation: 1.0, tier: '核心：多项式乘法' },
  { title: '平方差公式',                weight: 1.0,  classHours: 2,  examWeight: 1.0,  foundation: 1.0, tier: '核心：中考高频公式' },
  { title: '完全平方公式',              weight: 1.0,  classHours: 2,  examWeight: 1.0,  foundation: 1.0, tier: '核心：中考高频公式' },
  // ── 上册 第十七章 因式分解（约6课时）─────────
  { title: '用提公因式法分解因式',      weight: 1.0,  classHours: 3,  examWeight: 0.9,  foundation: 1.0, tier: '核心：因式分解基础' },
  { title: '用公式法分解因式',          weight: 1.0,  classHours: 3,  examWeight: 1.0,  foundation: 1.0, tier: '核心：综合运用公式' },
  // ── 上册 第十八章 分式（约14课时）─────────────
  { title: '从分数到分式',              weight: 0.75, classHours: 1,  examWeight: 0.5,  foundation: 0.9, tier: '重要：分式概念引入' },
  { title: '分式的基本性质',            weight: 1.0,  classHours: 2,  examWeight: 0.8,  foundation: 1.0, tier: '核心：约分通分基础' },
  { title: '分式的乘法与除法',          weight: 1.0,  classHours: 3,  examWeight: 0.9,  foundation: 0.9, tier: '核心：分式运算' },
  { title: '分式的加法与减法',          weight: 1.0,  classHours: 3,  examWeight: 0.9,  foundation: 0.9, tier: '核心：异分母通分' },
  { title: '整数指数幂',                weight: 0.5,  classHours: 2,  examWeight: 0.5,  foundation: 0.6, tier: '标准：指数扩展' },
  { title: '分式方程',                  weight: 1.0,  classHours: 3,  examWeight: 1.0,  foundation: 1.0, tier: '核心：中考必考，需验根' },
  // ── 下册 第十九章 二次根式（约8课时）─────────
  { title: '二次根式及其性质',          weight: 1.0,  classHours: 3,  examWeight: 0.9,  foundation: 1.0, tier: '核心：根式运算基础' },
  { title: '二次根式的乘法与除法',      weight: 0.75, classHours: 2,  examWeight: 0.7,  foundation: 0.8, tier: '重要：根式乘除' },
  { title: '二次根式的加法与减法',      weight: 0.75, classHours: 2,  examWeight: 0.7,  foundation: 0.8, tier: '重要：同类根式合并' },
  // ── 下册 第二十章 勾股定理（约6课时）─────────
  { title: '勾股定理及其应用',          weight: 1.0,  classHours: 3,  examWeight: 1.0,  foundation: 1.0, tier: '核心：中考必考定理' },
  { title: '勾股定理的逆定理及其应用',  weight: 1.0,  classHours: 3,  examWeight: 0.9,  foundation: 0.9, tier: '核心：判定直角三角形' },
  // ── 下册 第二十一章 四边形（约16课时）────────
  { title: '四边形及其内角和',          weight: 0.75, classHours: 1,  examWeight: 0.5,  foundation: 0.8, tier: '重要：四边形基础' },
  { title: '多边形及其内角和',          weight: 0.5,  classHours: 1,  examWeight: 0.4,  foundation: 0.6, tier: '标准：多边形扩展' },
  { title: '平行四边形及其性质',        weight: 1.0,  classHours: 3,  examWeight: 1.0,  foundation: 1.0, tier: '核心：性质必考' },
  { title: '平行四边形的判定',          weight: 1.0,  classHours: 3,  examWeight: 1.0,  foundation: 1.0, tier: '核心：判定证明' },
  { title: '三角形的中位线',            weight: 0.75, classHours: 2,  examWeight: 0.7,  foundation: 0.7, tier: '重要：中位线定理' },
  { title: '矩形',                      weight: 1.0,  classHours: 2,  examWeight: 0.9,  foundation: 0.9, tier: '核心：特殊平行四边形' },
  { title: '菱形',                      weight: 1.0,  classHours: 2,  examWeight: 0.9,  foundation: 0.9, tier: '核心：特殊平行四边形' },
  { title: '正方形',                    weight: 1.0,  classHours: 2,  examWeight: 1.0,  foundation: 0.9, tier: '核心：综合性最强' },
  // ── 下册 第二十二章 函数（约4课时）───────────
  { title: '函数的概念',                weight: 1.0,  classHours: 2,  examWeight: 0.8,  foundation: 1.0, tier: '核心：函数思想起点' },
  { title: '函数的表示',                weight: 0.75, classHours: 2,  examWeight: 0.6,  foundation: 0.9, tier: '重要：三种表示法' },
  // ── 下册 第二十三章 一次函数（约14课时）──────
  { title: '一次函数的概念',            weight: 1.0,  classHours: 2,  examWeight: 0.8,  foundation: 1.0, tier: '核心：一次函数定义' },
  { title: '一次函数的图象和性质',      weight: 1.0,  classHours: 4,  examWeight: 1.0,  foundation: 1.0, tier: '核心：中考压轴高频' },
  { title: '一次函数与方程不等式',      weight: 1.0,  classHours: 3,  examWeight: 1.0,  foundation: 1.0, tier: '核心：数形结合综合' },
  { title: '实际问题与一次函数',        weight: 1.0,  classHours: 3,  examWeight: 1.0,  foundation: 1.0, tier: '核心：建模与应用' },
  // ── 下册 第二十四章 数据的分析（约10课时）────
  { title: '平均数',                    weight: 0.75, classHours: 2,  examWeight: 0.7,  foundation: 0.9, tier: '重要：集中趋势核心' },
  { title: '中位数和众数',              weight: 0.75, classHours: 2,  examWeight: 0.7,  foundation: 0.8, tier: '重要：集中趋势补充' },
  { title: '数据的离散程度',            weight: 0.75, classHours: 2,  examWeight: 0.7,  foundation: 0.8, tier: '重要：方差标准差' },
  { title: '数据的四分位数',            weight: 0.5,  classHours: 1,  examWeight: 0.4,  foundation: 0.5, tier: '标准：数据分割' },
  { title: '数据的分组',                weight: 0.5,  classHours: 1,  examWeight: 0.4,  foundation: 0.5, tier: '标准：频数分布' },
];

// ── 数学 G9 权重（基于人教社2024修订版）─────────
const MATH_G9_WEIGHTS: WeightSeed[] = [
  // ── 上册 第二十一章 一元二次方程（约16课时）───
  { title: '一元二次方程',              weight: 1.0,  classHours: 2,  examWeight: 0.8,  foundation: 1.0, tier: '核心：二次方程概念' },
  { title: '配方法',                    weight: 1.0,  classHours: 3,  examWeight: 0.9,  foundation: 1.0, tier: '核心：重要解法' },
  { title: '公式法',                    weight: 1.0,  classHours: 3,  examWeight: 1.0,  foundation: 1.0, tier: '核心：求根公式必考' },
  { title: '因式分解法',                weight: 0.75, classHours: 2,  examWeight: 0.8,  foundation: 0.8, tier: '重要：简便解法' },
  { title: '一元二次方程的根与系数的关系', weight: 1.0, classHours: 2, examWeight: 1.0,  foundation: 1.0, tier: '核心：韦达定理必考' },
  { title: '实际问题与一元二次方程',    weight: 1.0,  classHours: 4,  examWeight: 1.0,  foundation: 1.0, tier: '核心：建模应用' },
  // ── 上册 第二十二章 二次函数（约14课时）───────
  { title: '二次函数',                  weight: 1.0,  classHours: 2,  examWeight: 0.9,  foundation: 1.0, tier: '核心：二次函数概念' },
  { title: '二次函数的图象和性质',      weight: 1.0,  classHours: 5,  examWeight: 1.0,  foundation: 1.0, tier: '核心：中考压轴核心' },
  { title: '二次函数与一元二次方程',    weight: 1.0,  classHours: 2,  examWeight: 1.0,  foundation: 1.0, tier: '核心：函数与方程联系' },
  { title: '实际问题与二次函数',        weight: 1.0,  classHours: 3,  examWeight: 1.0,  foundation: 1.0, tier: '核心：综合应用最值' },
  // ── 上册 第二十三章 旋转（约8课时）───────────
  { title: '图形的旋转',                weight: 0.75, classHours: 2,  examWeight: 0.7,  foundation: 0.8, tier: '重要：旋转性质' },
  { title: '中心对称',                  weight: 0.75, classHours: 2,  examWeight: 0.6,  foundation: 0.7, tier: '重要：对称性质' },
  { title: '中心对称图形',              weight: 0.5,  classHours: 1,  examWeight: 0.5,  foundation: 0.6, tier: '标准：图形识别' },
  { title: '关于原点对称的点的坐标',    weight: 0.5,  classHours: 1,  examWeight: 0.5,  foundation: 0.6, tier: '标准：坐标变换' },
  { title: '图案设计',                  weight: 0.25, classHours: 1,  examWeight: 0.2,  foundation: 0.3, tier: '了解：综合应用' },
  // ── 上册 第二十四章 圆（约16课时）─────────────
  { title: '圆',                        weight: 1.0,  classHours: 2,  examWeight: 0.8,  foundation: 1.0, tier: '核心：圆的基本概念' },
  { title: '垂直于弦的直径',            weight: 1.0,  classHours: 2,  examWeight: 1.0,  foundation: 1.0, tier: '核心：垂径定理必考' },
  { title: '弧弦圆心角',                weight: 0.75, classHours: 2,  examWeight: 0.8,  foundation: 0.9, tier: '重要：关系定理' },
  { title: '圆周角',                    weight: 1.0,  classHours: 2,  examWeight: 1.0,  foundation: 1.0, tier: '核心：圆周角定理' },
  { title: '点和圆的位置关系',          weight: 0.75, classHours: 1,  examWeight: 0.6,  foundation: 0.7, tier: '重要：位置判断' },
  { title: '直线和圆的位置关系',        weight: 1.0,  classHours: 3,  examWeight: 1.0,  foundation: 1.0, tier: '核心：切线判定与性质' },
  { title: '正多边形和圆',              weight: 0.5,  classHours: 1,  examWeight: 0.4,  foundation: 0.5, tier: '标准：正多边形计算' },
  { title: '弧长和扇形面积',            weight: 1.0,  classHours: 2,  examWeight: 1.0,  foundation: 0.8, tier: '核心：公式计算必考' },
  // ── 上册 第二十五章 概率初步（约8课时）───────
  { title: '随机事件',                  weight: 0.75, classHours: 1,  examWeight: 0.5,  foundation: 0.9, tier: '重要：概率概念基础' },
  { title: '概率',                      weight: 1.0,  classHours: 2,  examWeight: 0.9,  foundation: 1.0, tier: '核心：概率计算' },
  { title: '用列举法求概率',            weight: 1.0,  classHours: 3,  examWeight: 1.0,  foundation: 0.9, tier: '核心：列表法树状图' },
  { title: '用频率估计概率',            weight: 0.5,  classHours: 1,  examWeight: 0.5,  foundation: 0.6, tier: '标准：频率与概率' },
  // ── 下册 第二十六章 反比例函数（约8课时）─────
  { title: '反比例函数',                weight: 1.0,  classHours: 2,  examWeight: 0.9,  foundation: 1.0, tier: '核心：反比例函数概念' },
  { title: '反比例函数的图象和性质',    weight: 1.0,  classHours: 3,  examWeight: 1.0,  foundation: 1.0, tier: '核心：双曲线性质' },
  { title: '实际问题与反比例函数',      weight: 1.0,  classHours: 2,  examWeight: 0.9,  foundation: 0.9, tier: '核心：建模应用' },
  // ── 下册 第二十七章 相似（约12课时）──────────
  { title: '图形的相似',                weight: 0.75, classHours: 1,  examWeight: 0.6,  foundation: 0.9, tier: '重要：相似概念' },
  { title: '相似三角形的判定',          weight: 1.0,  classHours: 4,  examWeight: 1.0,  foundation: 1.0, tier: '核心：中考证明高频' },
  { title: '相似三角形的性质',          weight: 1.0,  classHours: 3,  examWeight: 1.0,  foundation: 1.0, tier: '核心：比例计算' },
  { title: '相似三角形应用举例',        weight: 0.75, classHours: 2,  examWeight: 0.7,  foundation: 0.7, tier: '重要：实际应用' },
  { title: '位似',                      weight: 0.5,  classHours: 1,  examWeight: 0.4,  foundation: 0.5, tier: '标准：位似变换' },
  // ── 下册 第二十八章 锐角三角函数（约10课时）──
  { title: '锐角三角函数',              weight: 1.0,  classHours: 3,  examWeight: 1.0,  foundation: 1.0, tier: '核心：sin/cos/tan定义' },
  { title: '解直角三角形',              weight: 1.0,  classHours: 3,  examWeight: 1.0,  foundation: 0.9, tier: '核心：综合求解' },
  { title: '解直角三角形的应用',        weight: 1.0,  classHours: 3,  examWeight: 1.0,  foundation: 0.8, tier: '核心：仰角坡度问题' },
  // ── 下册 第二十九章 投影与视图（约6课时）─────
  { title: '投影',                      weight: 0.5,  classHours: 1,  examWeight: 0.4,  foundation: 0.5, tier: '标准：投影概念' },
  { title: '三视图',                    weight: 0.75, classHours: 3,  examWeight: 0.7,  foundation: 0.6, tier: '重要：三视图画法' },
  { title: '制作立体模型',              weight: 0.25, classHours: 1,  examWeight: 0.2,  foundation: 0.3, tier: '了解：动手实践' },
];

// ── 数学 G1 权重（一年级）─────────────────────────
const MATH_G1_WEIGHTS: WeightSeed[] = [
  // ── 上册 ─────────────────────────────────────
  { title: '1~5的认识',         weight: 1.0,  classHours: 4,  examWeight: 1.0,  foundation: 1.0, tier: '核心：数的认识起点' },
  { title: '比大小',            weight: 0.75, classHours: 2,  examWeight: 0.8,  foundation: 1.0, tier: '重要：大小比较基础' },
  { title: '第几',              weight: 0.5,  classHours: 1,  examWeight: 0.5,  foundation: 0.7, tier: '标准：序数概念' },
  { title: '分与合',            weight: 1.0,  classHours: 3,  examWeight: 1.0,  foundation: 1.0, tier: '核心：加减法前置' },
  { title: '加法',              weight: 1.0,  classHours: 4,  examWeight: 1.0,  foundation: 1.0, tier: '核心：四则运算起点' },
  { title: '减法',              weight: 1.0,  classHours: 4,  examWeight: 1.0,  foundation: 1.0, tier: '核心：四则运算' },
  { title: '0的认识和加减法',   weight: 0.75, classHours: 2,  examWeight: 0.7,  foundation: 0.9, tier: '重要：零的概念' },
  { title: '6~9的认识',         weight: 0.75, classHours: 3,  examWeight: 0.8,  foundation: 0.9, tier: '重要：数的扩展' },
  { title: '6~9的加减法',       weight: 1.0,  classHours: 4,  examWeight: 1.0,  foundation: 1.0, tier: '核心：运算熟练' },
  { title: '10的认识和加减法',  weight: 1.0,  classHours: 4,  examWeight: 1.0,  foundation: 1.0, tier: '核心：十进制基础' },
  { title: '连加连减',          weight: 0.75, classHours: 2,  examWeight: 0.7,  foundation: 0.8, tier: '重要：多步运算' },
  { title: '加减混合',          weight: 0.75, classHours: 2,  examWeight: 0.7,  foundation: 0.8, tier: '重要：混合运算' },
  // ── 下册 ─────────────────────────────────────
  { title: '20以内的退位减法',  weight: 1.0,  classHours: 6,  examWeight: 1.0,  foundation: 1.0, tier: '核心：退位减法必考' },
  { title: '100以内数的认识',   weight: 1.0,  classHours: 5,  examWeight: 1.0,  foundation: 1.0, tier: '核心：数位概念' },
  { title: '100以内的加法和减法', weight: 1.0, classHours: 8,  examWeight: 1.0,  foundation: 1.0, tier: '核心：竖式计算基础' },
  { title: '认识人民币',        weight: 0.75, classHours: 3,  examWeight: 0.7,  foundation: 0.7, tier: '重要：生活应用' },
  { title: '认识钟表',          weight: 0.5,  classHours: 2,  examWeight: 0.5,  foundation: 0.6, tier: '标准：时间认知' },
];

// ── 数学 G2 权重（二年级）─────────────────────────
const MATH_G2_WEIGHTS: WeightSeed[] = [
  // ── 上册 ─────────────────────────────────────
  { title: '100以内的加法和减法（笔算）', weight: 1.0, classHours: 8, examWeight: 1.0, foundation: 1.0, tier: '核心：竖式计算' },
  { title: '认识长度单位',        weight: 0.75, classHours: 3,  examWeight: 0.7,  foundation: 0.8, tier: '重要：度量入门' },
  { title: '角的初步认识',        weight: 0.75, classHours: 3,  examWeight: 0.7,  foundation: 0.8, tier: '重要：角的概念' },
  { title: '表内乘法',            weight: 1.0,  classHours: 8,  examWeight: 1.0,  foundation: 1.0, tier: '核心：乘法口诀' },
  { title: '观察物体',            weight: 0.5,  classHours: 2,  examWeight: 0.4,  foundation: 0.5, tier: '标准：空间观念' },
  // ── 下册 ─────────────────────────────────────
  { title: '表内除法',            weight: 1.0,  classHours: 6,  examWeight: 1.0,  foundation: 1.0, tier: '核心：除法概念' },
  { title: '混合运算',            weight: 1.0,  classHours: 4,  examWeight: 0.9,  foundation: 1.0, tier: '核心：运算顺序' },
  { title: '有余数的除法',        weight: 0.75, classHours: 3,  examWeight: 0.8,  foundation: 0.9, tier: '重要：余数概念' },
  { title: '万以内数的认识',      weight: 1.0,  classHours: 5,  examWeight: 0.9,  foundation: 1.0, tier: '核心：大数认识' },
  { title: '克和千克',            weight: 0.5,  classHours: 2,  examWeight: 0.5,  foundation: 0.6, tier: '标准：质量单位' },
];

// ── 数学 G3 权重（三年级）─────────────────────────
const MATH_G3_WEIGHTS: WeightSeed[] = [
  // ── 上册 ─────────────────────────────────────
  { title: '万以内的加法和减法',  weight: 1.0,  classHours: 6,  examWeight: 1.0,  foundation: 1.0, tier: '核心：多位数运算' },
  { title: '多位数乘一位数',      weight: 1.0,  classHours: 5,  examWeight: 1.0,  foundation: 1.0, tier: '核心：乘法笔算' },
  { title: '倍的认识',            weight: 0.75, classHours: 3,  examWeight: 0.8,  foundation: 0.9, tier: '重要：倍数概念' },
  { title: '长方形和正方形',      weight: 0.75, classHours: 3,  examWeight: 0.7,  foundation: 0.8, tier: '重要：图形特征' },
  { title: '周长的认识',          weight: 1.0,  classHours: 3,  examWeight: 0.9,  foundation: 0.9, tier: '核心：周长计算' },
  { title: '分数的初步认识',      weight: 1.0,  classHours: 4,  examWeight: 0.9,  foundation: 1.0, tier: '核心：分数入门' },
  // ── 下册 ─────────────────────────────────────
  { title: '除数是一位数的除法',  weight: 1.0,  classHours: 6,  examWeight: 1.0,  foundation: 1.0, tier: '核心：除法笔算' },
  { title: '两位数乘两位数',      weight: 1.0,  classHours: 5,  examWeight: 1.0,  foundation: 1.0, tier: '核心：乘法笔算' },
  { title: '面积',                weight: 1.0,  classHours: 5,  examWeight: 1.0,  foundation: 1.0, tier: '核心：面积概念与计算' },
  { title: '小数的初步认识',      weight: 0.75, classHours: 3,  examWeight: 0.7,  foundation: 0.9, tier: '重要：小数入门' },
];

// ── 数学 G4 权重（四年级）─────────────────────────
const MATH_G4_WEIGHTS: WeightSeed[] = [
  // ── 上册 ─────────────────────────────────────
  { title: '大数的认识',          weight: 0.75, classHours: 5,  examWeight: 0.7,  foundation: 0.9, tier: '重要：亿以内数' },
  { title: '公顷和平方千米',      weight: 0.5,  classHours: 2,  examWeight: 0.5,  foundation: 0.6, tier: '标准：面积单位' },
  { title: '角的度量',            weight: 0.75, classHours: 3,  examWeight: 0.7,  foundation: 0.8, tier: '重要：量角器使用' },
  { title: '三位数乘两位数',      weight: 1.0,  classHours: 5,  examWeight: 0.9,  foundation: 1.0, tier: '核心：乘法笔算' },
  { title: '平行四边形和梯形',    weight: 0.75, classHours: 4,  examWeight: 0.7,  foundation: 0.8, tier: '重要：图形分类' },
  { title: '除数是两位数的除法',  weight: 1.0,  classHours: 6,  examWeight: 0.9,  foundation: 1.0, tier: '核心：除法笔算' },
  { title: '条形统计图',          weight: 0.5,  classHours: 2,  examWeight: 0.5,  foundation: 0.7, tier: '标准：统计入门' },
  // ── 下册 ─────────────────────────────────────
  { title: '四则运算',            weight: 1.0,  classHours: 4,  examWeight: 0.9,  foundation: 1.0, tier: '核心：运算律综合' },
  { title: '小数的意义和性质',    weight: 1.0,  classHours: 5,  examWeight: 0.9,  foundation: 1.0, tier: '核心：小数深入' },
  { title: '小数的加法和减法',    weight: 1.0,  classHours: 4,  examWeight: 0.9,  foundation: 1.0, tier: '核心：小数运算' },
  { title: '三角形',              weight: 0.75, classHours: 4,  examWeight: 0.7,  foundation: 0.8, tier: '重要：三角形分类' },
  { title: '平均数与条形统计图',  weight: 0.5,  classHours: 2,  examWeight: 0.5,  foundation: 0.7, tier: '标准：平均数概念' },
];

// ── 数学 G5 权重（五年级）─────────────────────────
const MATH_G5_WEIGHTS: WeightSeed[] = [
  // ── 上册 ─────────────────────────────────────
  { title: '小数乘法',            weight: 1.0,  classHours: 6,  examWeight: 1.0,  foundation: 1.0, tier: '核心：小数乘法笔算' },
  { title: '小数除法',            weight: 1.0,  classHours: 6,  examWeight: 1.0,  foundation: 1.0, tier: '核心：小数除法笔算' },
  { title: '简易方程',            weight: 1.0,  classHours: 6,  examWeight: 1.0,  foundation: 1.0, tier: '核心：方程入门' },
  { title: '多边形的面积',        weight: 1.0,  classHours: 5,  examWeight: 1.0,  foundation: 1.0, tier: '核心：面积公式' },
  { title: '植树问题',            weight: 0.5,  classHours: 2,  examWeight: 0.5,  foundation: 0.6, tier: '标准：规律探索' },
  // ── 下册 ─────────────────────────────────────
  { title: '因数与倍数',          weight: 1.0,  classHours: 5,  examWeight: 0.9,  foundation: 1.0, tier: '核心：整除性质' },
  { title: '分数的意义和性质',    weight: 1.0,  classHours: 6,  examWeight: 1.0,  foundation: 1.0, tier: '核心：分数深入' },
  { title: '分数的加法和减法',    weight: 1.0,  classHours: 5,  examWeight: 1.0,  foundation: 1.0, tier: '核心：分数运算' },
  { title: '长方体和正方体',      weight: 0.75, classHours: 5,  examWeight: 0.8,  foundation: 0.9, tier: '重要：体积计算' },
  { title: '折线统计图',          weight: 0.5,  classHours: 2,  examWeight: 0.5,  foundation: 0.6, tier: '标准：统计图' },
];

// ── 数学 G6 权重（六年级）─────────────────────────
const MATH_G6_WEIGHTS: WeightSeed[] = [
  // ── 上册 ─────────────────────────────────────
  { title: '分数乘法',            weight: 1.0,  classHours: 6,  examWeight: 1.0,  foundation: 1.0, tier: '核心：分数乘法' },
  { title: '分数除法',            weight: 1.0,  classHours: 6,  examWeight: 1.0,  foundation: 1.0, tier: '核心：分数除法' },
  { title: '比',                  weight: 0.75, classHours: 3,  examWeight: 0.8,  foundation: 0.9, tier: '重要：比的概念' },
  { title: '圆',                  weight: 1.0,  classHours: 5,  examWeight: 1.0,  foundation: 1.0, tier: '核心：圆的周长面积' },
  { title: '百分数',              weight: 1.0,  classHours: 5,  examWeight: 1.0,  foundation: 1.0, tier: '核心：百分数应用' },
  { title: '扇形统计图',          weight: 0.5,  classHours: 2,  examWeight: 0.5,  foundation: 0.6, tier: '标准：统计图' },
  // ── 下册 ─────────────────────────────────────
  { title: '负数',                weight: 0.75, classHours: 3,  examWeight: 0.6,  foundation: 1.0, tier: '重要：负数入门' },
  { title: '百分数（应用）',      weight: 1.0,  classHours: 4,  examWeight: 1.0,  foundation: 0.9, tier: '核心：折扣利率' },
  { title: '圆柱与圆锥',          weight: 1.0,  classHours: 5,  examWeight: 1.0,  foundation: 1.0, tier: '核心：体积表面积' },
  { title: '比例',                weight: 1.0,  classHours: 4,  examWeight: 0.9,  foundation: 1.0, tier: '核心：正反比例' },
];

// ── 权重映射表（按 subject_grade 路由）───────────
const WEIGHT_MAP: Record<string, WeightSeed[]> = {
  math_G1: MATH_G1_WEIGHTS,
  math_G2: MATH_G2_WEIGHTS,
  math_G3: MATH_G3_WEIGHTS,
  math_G4: MATH_G4_WEIGHTS,
  math_G5: MATH_G5_WEIGHTS,
  math_G6: MATH_G6_WEIGHTS,
  math_G7: MATH_G7_WEIGHTS,
  math_G8: MATH_G8_WEIGHTS,
  math_G9: MATH_G9_WEIGHTS,
};

/** 回退查找：同年级的最近权重数据 */
function findFallbackWeights(subject: string, grade: string): WeightSeed[] {
  const gradeNum = parseInt(grade, 10);
  if (isNaN(gradeNum)) return MATH_G7_WEIGHTS; // 默认回退到 G7

  // 优先找同年级、相邻年级（先下后上）
  for (let offset = 1; offset <= 9; offset++) {
    const up = WEIGHT_MAP[`${subject}_G${gradeNum + offset}`];
    if (up) return up;
    const down = WEIGHT_MAP[`${subject}_G${gradeNum - offset}`];
    if (down) return down;
  }

  // 最终回退：返回 G7
  return MATH_G7_WEIGHTS;
}

/** 注入权重数据，按学科+年级路由到对应权重种子 */
export function seedWeights(subject?: string, grade?: string): number {
  ensureWeightTable();
  const subj = subject || 'math';
  const grd = grade || '7';
  const key = `${subj}_G${grd}`;
  const updates = WEIGHT_MAP[key] ?? findFallbackWeights(subj, grd);
  let count = 0;

  const updateNode = db.prepare(`UPDATE kg_nodes SET weight=? WHERE type='knowledge_point' AND subject=? AND title=?`);
  const upsertDim = db.prepare(`
    INSERT OR REPLACE INTO kg_weight_dims (node_id, class_hours, exam_weight, foundation, overall, updated_at)
    VALUES (?, ?, ?, ?, ?, unixepoch())
  `);

  for (const s of updates) {
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
  id: number; title: string; weight: number; tier: string; classHours: number | null;
}> {
  let rows: any[];
  if (grade) {
    rows = db.prepare(`
      SELECT n.id, n.title, n.weight, d.class_hours
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
      SELECT n.id, n.title, n.weight, d.class_hours
      FROM kg_weight_dims d
      JOIN kg_nodes n ON n.id = d.node_id AND n.subject=?
      ORDER BY n.weight DESC, d.class_hours DESC
    `).all(subject) as any[];
  }

  return rows.map((r: any) => ({
    id: r.id,
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
  const count = seedWeights(subj, grade);

  const key = `${subj}_G${grade}`;
  const hasDirect = !!WEIGHT_MAP[key];
  console.log(`[权重] 已标注 ${count} 个知识点的权重（${subj} G${grade}）${hasDirect ? '' : ' [回退数据]'}`);
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
