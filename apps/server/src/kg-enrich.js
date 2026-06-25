/**
 * kg-enrich.ts — 为已有知识点建立完整的语义映射
 *
 * 连接 知识点 → 主题领域 → 核心素养 → 认知层级 → 前置依赖
 *
 * 导出函数：
 *   seedAllEdges(subject)         — 注入所有语义关系（belongs_to / reinforces / bloom_at / prerequisite）
 *   seedPrerequisiteEdges(subject) — 仅注入 prerequisite 边
 */
import db from './db.js';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const MAPPINGS_DIR = resolve(__dirname, '../curriculum/kg-mappings');
/** 加载 JSON 映射文件（LLM 生成 + 人工审核后的数据） */
export function loadMappingsFromJson(subject, grade) {
    const path = join(MAPPINGS_DIR, `${subject}-G${grade}.json`);
    if (!existsSync(path))
        return null;
    try {
        return JSON.parse(readFileSync(path, 'utf-8'));
    }
    catch {
        return null;
    }
}
// ── 共享 DB 辅助 ─────────────────────────────────
const insEdge = db.prepare(`INSERT OR IGNORE INTO kg_edges (source_id, target_id, type, weight) VALUES (?, ?, ?, ?)`);
const getNode = (type, code, title) => {
    if (code)
        return db.prepare(`SELECT id FROM kg_nodes WHERE type=? AND code=?`).get(type, code);
    return db.prepare(`SELECT id FROM kg_nodes WHERE type=? AND title=?`).get(type, title);
};
const getNodeByTitleSubject = (title, subject) => db.prepare(`SELECT id FROM kg_nodes WHERE type='knowledge_point' AND subject=? AND title=?`).get(subject, title);
// ── 1) 知识点 → 所属主题领域 ─────────────────────
const kpThemes = {
    // ── G7 上册 第一章 有理数 → 数与代数 ──────────
    '正数和负数': 'math_num_algebra',
    '有理数的概念': 'math_num_algebra',
    '数轴': 'math_num_algebra',
    '相反数': 'math_num_algebra',
    '绝对值': 'math_num_algebra',
    '有理数的大小比较': 'math_num_algebra',
    '有理数的加法': 'math_num_algebra',
    '有理数的减法': 'math_num_algebra',
    '有理数的乘法': 'math_num_algebra',
    '有理数的除法': 'math_num_algebra',
    '乘方': 'math_num_algebra',
    '科学记数法': 'math_num_algebra',
    '近似数': 'math_num_algebra',
    '列代数式表示数量关系': 'math_num_algebra',
    '代数式的值': 'math_num_algebra',
    '整式': 'math_num_algebra',
    '整式的加法与减法': 'math_num_algebra',
    '从算式到方程': 'math_num_algebra',
    '等式的性质': 'math_num_algebra',
    '解一元一次方程': 'math_num_algebra',
    '实际问题与一元一次方程': 'math_num_algebra',
    // ── G7 上册 第六章 几何图形初步 → 图形与几何 ──
    '立体图形与平面图形': 'math_geo',
    '点线面体': 'math_geo',
    '直线射线线段': 'math_geo',
    '线段的比较与运算': 'math_geo',
    '角的概念': 'math_geo',
    '角的比较与运算': 'math_geo',
    '余角和补角': 'math_geo',
    // ── G8 上册 → 数与代数 ─────────────────────────
    '同底数幂的乘法': 'math_num_algebra',
    '幂的乘方与积的乘方': 'math_num_algebra',
    '整式的乘法': 'math_num_algebra',
    '平方差公式': 'math_num_algebra',
    '完全平方公式': 'math_num_algebra',
    '用提公因式法分解因式': 'math_num_algebra',
    '用公式法分解因式': 'math_num_algebra',
    '从分数到分式': 'math_num_algebra',
    '分式的基本性质': 'math_num_algebra',
    '分式的乘法与除法': 'math_num_algebra',
    '分式的加法与减法': 'math_num_algebra',
    '整数指数幂': 'math_num_algebra',
    '分式方程': 'math_num_algebra',
    // ── G8 下册 → 数与代数 ─────────────────────────
    '二次根式及其性质': 'math_num_algebra',
    '二次根式的乘法与除法': 'math_num_algebra',
    '二次根式的加法与减法': 'math_num_algebra',
    '函数的概念': 'math_num_algebra',
    '函数的表示': 'math_num_algebra',
    '一次函数的概念': 'math_num_algebra',
    '一次函数的图象和性质': 'math_num_algebra',
    '一次函数与方程不等式': 'math_num_algebra',
    '实际问题与一次函数': 'math_num_algebra',
    // ── G8 上册 → 图形与几何 ───────────────────────
    '三角形的概念': 'math_geo',
    '三角形的边': 'math_geo',
    '三角形的中线角平分线和高': 'math_geo',
    '三角形的内角': 'math_geo',
    '三角形的外角': 'math_geo',
    '多边形': 'math_geo',
    '多边形的内角和': 'math_geo',
    '全等三角形及其性质': 'math_geo',
    '三角形全等的判定': 'math_geo',
    '角的平分线': 'math_geo',
    '轴对称及其性质': 'math_geo',
    '线段的垂直平分线': 'math_geo',
    '画轴对称的图形': 'math_geo',
    '等腰三角形': 'math_geo',
    '等边三角形': 'math_geo',
    // ── G8 下册 → 图形与几何 ───────────────────────
    '勾股定理及其应用': 'math_geo',
    '勾股定理的逆定理及其应用': 'math_geo',
    '四边形及其内角和': 'math_geo',
    '多边形及其内角和': 'math_geo',
    '平行四边形及其性质': 'math_geo',
    '平行四边形的判定': 'math_geo',
    '三角形的中位线': 'math_geo',
    '矩形': 'math_geo',
    '菱形': 'math_geo',
    '正方形': 'math_geo',
    // ── G8 下册 → 统计与概率 ───────────────────────
    '平均数': 'math_stats',
    '中位数和众数': 'math_stats',
    '数据的离散程度': 'math_stats',
    '数据的四分位数': 'math_stats',
    '数据的分组': 'math_stats',
    // ── G9 上册 → 数与代数 ─────────────────────────
    '一元二次方程': 'math_num_algebra',
    '配方法': 'math_num_algebra',
    '公式法': 'math_num_algebra',
    '因式分解法': 'math_num_algebra',
    '一元二次方程的根与系数的关系': 'math_num_algebra',
    '实际问题与一元二次方程': 'math_num_algebra',
    '二次函数': 'math_num_algebra',
    '二次函数的图象和性质': 'math_num_algebra',
    '二次函数与一元二次方程': 'math_num_algebra',
    '实际问题与二次函数': 'math_num_algebra',
    // ── G9 下册 → 数与代数 ─────────────────────────
    '反比例函数': 'math_num_algebra',
    '反比例函数的图象和性质': 'math_num_algebra',
    '实际问题与反比例函数': 'math_num_algebra',
    // ── G9 上册 → 图形与几何 ───────────────────────
    '图形的旋转': 'math_geo',
    '中心对称': 'math_geo',
    '中心对称图形': 'math_geo',
    '关于原点对称的点的坐标': 'math_geo',
    '图案设计': 'math_geo',
    '圆': 'math_geo',
    '垂直于弦的直径': 'math_geo',
    '弧弦圆心角': 'math_geo',
    '圆周角': 'math_geo',
    '点和圆的位置关系': 'math_geo',
    '直线和圆的位置关系': 'math_geo',
    '正多边形和圆': 'math_geo',
    '弧长和扇形面积': 'math_geo',
    // ── G9 下册 → 图形与几何 ───────────────────────
    '图形的相似': 'math_geo',
    '相似三角形的判定': 'math_geo',
    '相似三角形的性质': 'math_geo',
    '相似三角形应用举例': 'math_geo',
    '位似': 'math_geo',
    '锐角三角函数': 'math_geo',
    '解直角三角形': 'math_geo',
    '解直角三角形的应用': 'math_geo',
    '投影': 'math_geo',
    '三视图': 'math_geo',
    '制作立体模型': 'math_geo',
    // ── G9 上册 → 统计与概率 ───────────────────────
    '随机事件': 'math_stats',
    '概率': 'math_stats',
    '用列举法求概率': 'math_stats',
    '用频率估计概率': 'math_stats',
};
function seedBelongsToEdges(subject) {
    let count = 0;
    for (const [kpTitle, themeCode] of Object.entries(kpThemes)) {
        const kp = getNode('knowledge_point', undefined, kpTitle);
        const theme = getNode('theme', themeCode);
        if (kp && theme) {
            insEdge.run(kp.id, theme.id, 'belongs_to', 1.0);
            count++;
        }
    }
    return count;
}
// ── 2) 知识点 → 核心素养 ─────────────────────────
const kpLiteracies = {
    // ── G7 上册 数感 ───────────────────────────────
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
    '列代数式表示数量关系': ['lit_math_abstract', 'lit_math_symbol', 'lit_math_model'],
    '代数式的值': ['lit_math_abstract', 'lit_math_apply'],
    '整式': ['lit_math_abstract', 'lit_math_symbol'],
    '整式的加法与减法': ['lit_math_abstract', 'lit_math_apply'],
    '从算式到方程': ['lit_math_abstract', 'lit_math_model'],
    '等式的性质': ['lit_math_reasoning', 'lit_math_abstract'],
    '解一元一次方程': ['lit_math_apply', 'lit_math_reasoning'],
    '实际问题与一元一次方程': ['lit_math_model', 'lit_math_apply', 'lit_math_innovation'],
    '立体图形与平面图形': ['lit_math_space', 'lit_math_geometry'],
    '点线面体': ['lit_math_space', 'lit_math_abstract'],
    '直线射线线段': ['lit_math_space', 'lit_math_geometry'],
    '线段的比较与运算': ['lit_math_space', 'lit_math_measure', 'lit_math_apply'],
    '角的概念': ['lit_math_space', 'lit_math_geometry'],
    '角的比较与运算': ['lit_math_space', 'lit_math_measure', 'lit_math_apply'],
    '余角和补角': ['lit_math_space', 'lit_math_reasoning', 'lit_math_apply'],
    // ── G8 上册 三角形 → 空间观念 + 推理 ──────────
    '三角形的概念': ['lit_math_space', 'lit_math_geometry'],
    '三角形的边': ['lit_math_space', 'lit_math_reasoning'],
    '三角形的中线角平分线和高': ['lit_math_space', 'lit_math_geometry'],
    '三角形的内角': ['lit_math_reasoning', 'lit_math_abstract'],
    '三角形的外角': ['lit_math_reasoning', 'lit_math_abstract'],
    '多边形': ['lit_math_space', 'lit_math_abstract'],
    '多边形的内角和': ['lit_math_reasoning', 'lit_math_apply'],
    // ── G8 上册 全等三角形 → 推理 ─────────────────
    '全等三角形及其性质': ['lit_math_space', 'lit_math_reasoning'],
    '三角形全等的判定': ['lit_math_reasoning', 'lit_math_abstract', 'lit_math_apply'],
    '角的平分线': ['lit_math_space', 'lit_math_reasoning'],
    // ── G8 上册 轴对称 → 空间观念 ─────────────────
    '轴对称及其性质': ['lit_math_space', 'lit_math_geometry'],
    '线段的垂直平分线': ['lit_math_space', 'lit_math_reasoning'],
    '画轴对称的图形': ['lit_math_space', 'lit_math_geometry'],
    '等腰三角形': ['lit_math_space', 'lit_math_reasoning', 'lit_math_apply'],
    '等边三角形': ['lit_math_space', 'lit_math_reasoning'],
    // ── G8 上册 整式的乘法 → 符号 + 运算 ─────────
    '同底数幂的乘法': ['lit_math_symbol', 'lit_math_apply'],
    '幂的乘方与积的乘方': ['lit_math_symbol', 'lit_math_apply'],
    '整式的乘法': ['lit_math_abstract', 'lit_math_apply'],
    '平方差公式': ['lit_math_abstract', 'lit_math_symbol', 'lit_math_apply'],
    '完全平方公式': ['lit_math_abstract', 'lit_math_symbol', 'lit_math_apply'],
    // ── G8 上册 因式分解 → 抽象 + 运算 ───────────
    '用提公因式法分解因式': ['lit_math_abstract', 'lit_math_apply'],
    '用公式法分解因式': ['lit_math_abstract', 'lit_math_apply'],
    // ── G8 上册 分式 → 抽象 + 运算 ───────────────
    '从分数到分式': ['lit_math_abstract', 'lit_math_symbol'],
    '分式的基本性质': ['lit_math_abstract', 'lit_math_apply'],
    '分式的乘法与除法': ['lit_math_abstract', 'lit_math_apply'],
    '分式的加法与减法': ['lit_math_abstract', 'lit_math_apply'],
    '整数指数幂': ['lit_math_symbol', 'lit_math_apply'],
    '分式方程': ['lit_math_model', 'lit_math_apply', 'lit_math_reasoning'],
    // ── G8 下册 二次根式 → 运算 ──────────────────
    '二次根式及其性质': ['lit_math_abstract', 'lit_math_apply'],
    '二次根式的乘法与除法': ['lit_math_abstract', 'lit_math_apply'],
    '二次根式的加法与减法': ['lit_math_abstract', 'lit_math_apply'],
    // ── G8 下册 勾股定理 → 推理 + 几何直观 ───────
    '勾股定理及其应用': ['lit_math_reasoning', 'lit_math_geometry', 'lit_math_apply'],
    '勾股定理的逆定理及其应用': ['lit_math_reasoning', 'lit_math_geometry', 'lit_math_apply'],
    // ── G8 下册 四边形 → 空间观念 + 推理 ─────────
    '四边形及其内角和': ['lit_math_space', 'lit_math_reasoning'],
    '多边形及其内角和': ['lit_math_space', 'lit_math_reasoning'],
    '平行四边形及其性质': ['lit_math_space', 'lit_math_reasoning'],
    '平行四边形的判定': ['lit_math_reasoning', 'lit_math_abstract', 'lit_math_apply'],
    '三角形的中位线': ['lit_math_space', 'lit_math_reasoning'],
    '矩形': ['lit_math_space', 'lit_math_reasoning', 'lit_math_apply'],
    '菱形': ['lit_math_space', 'lit_math_reasoning', 'lit_math_apply'],
    '正方形': ['lit_math_space', 'lit_math_reasoning', 'lit_math_apply'],
    // ── G8 下册 函数 → 抽象 + 模型 ───────────────
    '函数的概念': ['lit_math_abstract', 'lit_math_model'],
    '函数的表示': ['lit_math_abstract', 'lit_math_geometry'],
    '一次函数的概念': ['lit_math_abstract', 'lit_math_model'],
    '一次函数的图象和性质': ['lit_math_geometry', 'lit_math_abstract', 'lit_math_reasoning'],
    '一次函数与方程不等式': ['lit_math_model', 'lit_math_reasoning', 'lit_math_apply'],
    '实际问题与一次函数': ['lit_math_model', 'lit_math_apply', 'lit_math_innovation'],
    // ── G8 下册 数据分析 → 数据意识 ──────────────
    '平均数': ['lit_math_data', 'lit_math_apply'],
    '中位数和众数': ['lit_math_data', 'lit_math_apply'],
    '数据的离散程度': ['lit_math_data', 'lit_math_apply'],
    '数据的四分位数': ['lit_math_data', 'lit_math_apply'],
    '数据的分组': ['lit_math_data', 'lit_math_apply'],
    // ── G9 上册 一元二次方程 → 抽象 + 模型 ───────
    '一元二次方程': ['lit_math_abstract', 'lit_math_model'],
    '配方法': ['lit_math_abstract', 'lit_math_apply'],
    '公式法': ['lit_math_abstract', 'lit_math_symbol', 'lit_math_apply'],
    '因式分解法': ['lit_math_abstract', 'lit_math_apply'],
    '一元二次方程的根与系数的关系': ['lit_math_abstract', 'lit_math_reasoning'],
    '实际问题与一元二次方程': ['lit_math_model', 'lit_math_apply', 'lit_math_innovation'],
    // ── G9 上册 二次函数 → 抽象 + 几何直观 ───────
    '二次函数': ['lit_math_abstract', 'lit_math_model'],
    '二次函数的图象和性质': ['lit_math_geometry', 'lit_math_abstract', 'lit_math_reasoning'],
    '二次函数与一元二次方程': ['lit_math_abstract', 'lit_math_reasoning', 'lit_math_model'],
    '实际问题与二次函数': ['lit_math_model', 'lit_math_apply', 'lit_math_innovation'],
    // ── G9 上册 旋转 → 空间观念 ──────────────────
    '图形的旋转': ['lit_math_space', 'lit_math_geometry'],
    '中心对称': ['lit_math_space', 'lit_math_geometry'],
    '中心对称图形': ['lit_math_space', 'lit_math_geometry'],
    '关于原点对称的点的坐标': ['lit_math_space', 'lit_math_geometry'],
    '图案设计': ['lit_math_space', 'lit_math_innovation'],
    // ── G9 上册 圆 → 空间 + 推理 ─────────────────
    '圆': ['lit_math_space', 'lit_math_geometry'],
    '垂直于弦的直径': ['lit_math_space', 'lit_math_reasoning'],
    '弧弦圆心角': ['lit_math_space', 'lit_math_reasoning'],
    '圆周角': ['lit_math_space', 'lit_math_reasoning'],
    '点和圆的位置关系': ['lit_math_space', 'lit_math_geometry'],
    '直线和圆的位置关系': ['lit_math_space', 'lit_math_reasoning', 'lit_math_apply'],
    '正多边形和圆': ['lit_math_space', 'lit_math_apply'],
    '弧长和扇形面积': ['lit_math_space', 'lit_math_measure', 'lit_math_apply'],
    // ── G9 上册 概率 → 数据意识 ──────────────────
    '随机事件': ['lit_math_data', 'lit_math_abstract'],
    '概率': ['lit_math_data', 'lit_math_abstract'],
    '用列举法求概率': ['lit_math_data', 'lit_math_apply'],
    '用频率估计概率': ['lit_math_data', 'lit_math_apply'],
    // ── G9 下册 反比例函数 → 抽象 + 模型 ─────────
    '反比例函数': ['lit_math_abstract', 'lit_math_model'],
    '反比例函数的图象和性质': ['lit_math_geometry', 'lit_math_abstract', 'lit_math_reasoning'],
    '实际问题与反比例函数': ['lit_math_model', 'lit_math_apply', 'lit_math_innovation'],
    // ── G9 下册 相似 → 空间 + 推理 ───────────────
    '图形的相似': ['lit_math_space', 'lit_math_geometry'],
    '相似三角形的判定': ['lit_math_reasoning', 'lit_math_abstract', 'lit_math_apply'],
    '相似三角形的性质': ['lit_math_reasoning', 'lit_math_apply'],
    '相似三角形应用举例': ['lit_math_model', 'lit_math_apply'],
    '位似': ['lit_math_space', 'lit_math_geometry'],
    // ── G9 下册 锐角三角函数 → 抽象 + 应用 ───────
    '锐角三角函数': ['lit_math_abstract', 'lit_math_apply'],
    '解直角三角形': ['lit_math_apply', 'lit_math_reasoning'],
    '解直角三角形的应用': ['lit_math_model', 'lit_math_apply'],
    // ── G9 下册 投影与视图 → 空间观念 ────────────
    '投影': ['lit_math_space', 'lit_math_geometry'],
    '三视图': ['lit_math_space', 'lit_math_geometry'],
    '制作立体模型': ['lit_math_space', 'lit_math_innovation'],
};
function seedReinforcesEdges(subject) {
    let count = 0;
    for (const [kpTitle, litCodes] of Object.entries(kpLiteracies)) {
        const kp = getNode('knowledge_point', undefined, kpTitle);
        if (!kp)
            continue;
        for (const litCode of litCodes) {
            const lit = getNode('literacy', litCode);
            if (lit) {
                insEdge.run(kp.id, lit.id, 'reinforces', 1.0);
                count++;
            }
        }
    }
    return count;
}
// ── 3) 知识点间前置依赖（prerequisite）───────────
// 按照人教社 PEP 课程编排顺序，后者依赖前者。
// 包含册内依赖和跨册依赖（G7→G8→G9）。
const MATH_PREREQUISITES = [
    // ══════════════════════════════════════════════
    // G7 上册：有理数链
    // ══════════════════════════════════════════════
    { from: '正数和负数', to: '有理数的概念', subject: 'math' },
    { from: '有理数的概念', to: '数轴', subject: 'math' },
    { from: '数轴', to: '相反数', subject: 'math' },
    { from: '相反数', to: '绝对值', subject: 'math' },
    { from: '绝对值', to: '有理数的大小比较', subject: 'math' },
    { from: '有理数的概念', to: '有理数的加法', subject: 'math' },
    { from: '有理数的加法', to: '有理数的减法', subject: 'math' },
    { from: '有理数的减法', to: '有理数的乘法', subject: 'math' },
    { from: '有理数的乘法', to: '有理数的除法', subject: 'math' },
    { from: '有理数的概念', to: '乘方', subject: 'math' },
    { from: '乘方', to: '科学记数法', subject: 'math' },
    // G7 上册：代数式链
    { from: '有理数的加法', to: '列代数式表示数量关系', subject: 'math' },
    { from: '列代数式表示数量关系', to: '代数式的值', subject: 'math' },
    { from: '列代数式表示数量关系', to: '整式', subject: 'math' },
    { from: '整式', to: '整式的加法与减法', subject: 'math' },
    // G7 上册：方程链
    { from: '从算式到方程', to: '等式的性质', subject: 'math' },
    { from: '等式的性质', to: '解一元一次方程', subject: 'math' },
    { from: '解一元一次方程', to: '实际问题与一元一次方程', subject: 'math' },
    { from: '整式的加法与减法', to: '解一元一次方程', subject: 'math' },
    // G7 上册：几何链
    { from: '立体图形与平面图形', to: '点线面体', subject: 'math' },
    { from: '点线面体', to: '直线射线线段', subject: 'math' },
    { from: '直线射线线段', to: '线段的比较与运算', subject: 'math' },
    { from: '直线射线线段', to: '角的概念', subject: 'math' },
    { from: '角的概念', to: '角的比较与运算', subject: 'math' },
    { from: '角的比较与运算', to: '余角和补角', subject: 'math' },
    // ══════════════════════════════════════════════
    // G7 → G8 跨册衔接
    // ══════════════════════════════════════════════
    // 整式 → 整式的乘法
    { from: '整式的加法与减法', to: '同底数幂的乘法', subject: 'math' },
    { from: '乘方', to: '同底数幂的乘法', subject: 'math' },
    // 一元一次方程 → 分式方程
    { from: '解一元一次方程', to: '分式方程', subject: 'math' },
    // 角的概念 → 三角形的内角
    { from: '角的概念', to: '三角形的内角', subject: 'math' },
    // 线段的比较与运算 → 三角形的边
    { from: '线段的比较与运算', to: '三角形的边', subject: 'math' },
    // ══════════════════════════════════════════════
    // G8 上册：三角形链
    // ══════════════════════════════════════════════
    { from: '三角形的概念', to: '三角形的边', subject: 'math' },
    { from: '三角形的概念', to: '三角形的中线角平分线和高', subject: 'math' },
    { from: '三角形的边', to: '三角形的内角', subject: 'math' },
    { from: '三角形的内角', to: '三角形的外角', subject: 'math' },
    { from: '三角形的内角', to: '多边形', subject: 'math' },
    { from: '多边形', to: '多边形的内角和', subject: 'math' },
    // G8 上册：全等三角形链
    { from: '三角形的内角', to: '全等三角形及其性质', subject: 'math' },
    { from: '全等三角形及其性质', to: '三角形全等的判定', subject: 'math' },
    { from: '三角形全等的判定', to: '角的平分线', subject: 'math' },
    // G8 上册：轴对称链
    { from: '线段的比较与运算', to: '轴对称及其性质', subject: 'math' },
    { from: '轴对称及其性质', to: '线段的垂直平分线', subject: 'math' },
    { from: '轴对称及其性质', to: '画轴对称的图形', subject: 'math' },
    { from: '全等三角形及其性质', to: '等腰三角形', subject: 'math' },
    { from: '等腰三角形', to: '等边三角形', subject: 'math' },
    // G8 上册：整式乘法链
    { from: '同底数幂的乘法', to: '幂的乘方与积的乘方', subject: 'math' },
    { from: '幂的乘方与积的乘方', to: '整式的乘法', subject: 'math' },
    { from: '整式的乘法', to: '平方差公式', subject: 'math' },
    { from: '整式的乘法', to: '完全平方公式', subject: 'math' },
    // G8 上册：因式分解链（乘法逆运算）
    { from: '整式的乘法', to: '用提公因式法分解因式', subject: 'math' },
    { from: '平方差公式', to: '用公式法分解因式', subject: 'math' },
    { from: '完全平方公式', to: '用公式法分解因式', subject: 'math' },
    { from: '用提公因式法分解因式', to: '用公式法分解因式', subject: 'math' },
    // G8 上册：分式链
    { from: '整式的乘法', to: '从分数到分式', subject: 'math' },
    { from: '从分数到分式', to: '分式的基本性质', subject: 'math' },
    { from: '分式的基本性质', to: '分式的乘法与除法', subject: 'math' },
    { from: '分式的基本性质', to: '分式的加法与减法', subject: 'math' },
    { from: '分式的乘法与除法', to: '整数指数幂', subject: 'math' },
    { from: '分式的加法与减法', to: '分式方程', subject: 'math' },
    // ══════════════════════════════════════════════
    // G8 → G8下 跨册衔接
    // ══════════════════════════════════════════════
    { from: '乘方', to: '二次根式及其性质', subject: 'math' },
    { from: '三角形的内角', to: '勾股定理及其应用', subject: 'math' },
    { from: '多边形的内角和', to: '四边形及其内角和', subject: 'math' },
    { from: '平行四边形及其性质', to: '平行四边形的判定', subject: 'math' },
    // ══════════════════════════════════════════════
    // G8 下册：二次根式链
    // ══════════════════════════════════════════════
    { from: '二次根式及其性质', to: '二次根式的乘法与除法', subject: 'math' },
    { from: '二次根式及其性质', to: '二次根式的加法与减法', subject: 'math' },
    // G8 下册：勾股定理
    { from: '勾股定理及其应用', to: '勾股定理的逆定理及其应用', subject: 'math' },
    // G8 下册：四边形链
    { from: '四边形及其内角和', to: '多边形及其内角和', subject: 'math' },
    { from: '平行四边形及其性质', to: '三角形的中位线', subject: 'math' },
    { from: '平行四边形的判定', to: '矩形', subject: 'math' },
    { from: '平行四边形的判定', to: '菱形', subject: 'math' },
    { from: '矩形', to: '正方形', subject: 'math' },
    { from: '菱形', to: '正方形', subject: 'math' },
    // G8 下册：函数链
    { from: '函数的概念', to: '函数的表示', subject: 'math' },
    { from: '函数的概念', to: '一次函数的概念', subject: 'math' },
    { from: '一次函数的概念', to: '一次函数的图象和性质', subject: 'math' },
    { from: '一次函数的图象和性质', to: '一次函数与方程不等式', subject: 'math' },
    { from: '一次函数与方程不等式', to: '实际问题与一次函数', subject: 'math' },
    { from: '解一元一次方程', to: '一次函数与方程不等式', subject: 'math' },
    // G8 下册：数据分析链
    { from: '平均数', to: '中位数和众数', subject: 'math' },
    { from: '平均数', to: '数据的离散程度', subject: 'math' },
    { from: '数据的离散程度', to: '数据的四分位数', subject: 'math' },
    { from: '数据的四分位数', to: '数据的分组', subject: 'math' },
    // ══════════════════════════════════════════════
    // G8 → G9 跨册衔接
    // ══════════════════════════════════════════════
    { from: '用公式法分解因式', to: '公式法', subject: 'math' },
    { from: '分式方程', to: '一元二次方程', subject: 'math' },
    { from: '一次函数的概念', to: '二次函数', subject: 'math' },
    { from: '轴对称及其性质', to: '图形的旋转', subject: 'math' },
    { from: '勾股定理及其应用', to: '圆', subject: 'math' },
    // ══════════════════════════════════════════════
    // G9 上册：一元二次方程链
    // ══════════════════════════════════════════════
    { from: '一元二次方程', to: '配方法', subject: 'math' },
    { from: '配方法', to: '公式法', subject: 'math' },
    { from: '一元二次方程', to: '因式分解法', subject: 'math' },
    { from: '公式法', to: '一元二次方程的根与系数的关系', subject: 'math' },
    { from: '一元二次方程的根与系数的关系', to: '实际问题与一元二次方程', subject: 'math' },
    // G9 上册：二次函数链
    { from: '二次函数', to: '二次函数的图象和性质', subject: 'math' },
    { from: '二次函数的图象和性质', to: '二次函数与一元二次方程', subject: 'math' },
    { from: '二次函数与一元二次方程', to: '实际问题与二次函数', subject: 'math' },
    { from: '一元二次方程', to: '二次函数与一元二次方程', subject: 'math' },
    // G9 上册：旋转链
    { from: '图形的旋转', to: '中心对称', subject: 'math' },
    { from: '中心对称', to: '中心对称图形', subject: 'math' },
    { from: '中心对称', to: '关于原点对称的点的坐标', subject: 'math' },
    { from: '图形的旋转', to: '图案设计', subject: 'math' },
    // G9 上册：圆链
    { from: '圆', to: '垂直于弦的直径', subject: 'math' },
    { from: '圆', to: '弧弦圆心角', subject: 'math' },
    { from: '弧弦圆心角', to: '圆周角', subject: 'math' },
    { from: '圆', to: '点和圆的位置关系', subject: 'math' },
    { from: '点和圆的位置关系', to: '直线和圆的位置关系', subject: 'math' },
    { from: '圆', to: '正多边形和圆', subject: 'math' },
    { from: '圆', to: '弧长和扇形面积', subject: 'math' },
    // G9 上册：概率链
    { from: '随机事件', to: '概率', subject: 'math' },
    { from: '概率', to: '用列举法求概率', subject: 'math' },
    { from: '概率', to: '用频率估计概率', subject: 'math' },
    // ══════════════════════════════════════════════
    // G9 下册：反比例函数
    // ══════════════════════════════════════════════
    { from: '一次函数的概念', to: '反比例函数', subject: 'math' },
    { from: '反比例函数', to: '反比例函数的图象和性质', subject: 'math' },
    { from: '反比例函数的图象和性质', to: '实际问题与反比例函数', subject: 'math' },
    // G9 下册：相似链
    { from: '三角形全等的判定', to: '相似三角形的判定', subject: 'math' },
    { from: '图形的相似', to: '相似三角形的判定', subject: 'math' },
    { from: '相似三角形的判定', to: '相似三角形的性质', subject: 'math' },
    { from: '相似三角形的性质', to: '相似三角形应用举例', subject: 'math' },
    { from: '相似三角形的判定', to: '位似', subject: 'math' },
    // G9 下册：锐角三角函数链
    { from: '相似三角形的判定', to: '锐角三角函数', subject: 'math' },
    { from: '勾股定理及其应用', to: '解直角三角形', subject: 'math' },
    { from: '锐角三角函数', to: '解直角三角形', subject: 'math' },
    { from: '解直角三角形', to: '解直角三角形的应用', subject: 'math' },
    // G9 下册：投影与视图链
    { from: '投影', to: '三视图', subject: 'math' },
    { from: '三视图', to: '制作立体模型', subject: 'math' },
    { from: '立体图形与平面图形', to: '投影', subject: 'math' },
];
/**
 * 注入 prerequisite 边到 kg_edges 表。
 * 根据 title + subject 查找 kg_nodes 中的节点 ID，再插入 prerequisite 关系。
 * 返回成功插入的边数。
 */
export function seedPrerequisiteEdges(subject) {
    let count = 0;
    for (const edge of MATH_PREREQUISITES) {
        if (edge.subject !== subject)
            continue;
        const fromNode = getNodeByTitleSubject(edge.from, subject);
        const toNode = getNodeByTitleSubject(edge.to, subject);
        if (fromNode && toNode) {
            insEdge.run(fromNode.id, toNode.id, 'prerequisite', 1.0);
            count++;
        }
    }
    return count;
}
// ── 4) 知识点 → 布鲁姆认知层级 ───────────────────
const kpBloom = {
    // ── G7 ─────────────────────────────────────────
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
    // ── G8 ─────────────────────────────────────────
    '三角形的概念': 'bloom_remember',
    '三角形的边': 'bloom_apply',
    '三角形的中线角平分线和高': 'bloom_understand',
    '三角形的内角': 'bloom_apply',
    '三角形的外角': 'bloom_apply',
    '多边形': 'bloom_remember',
    '多边形的内角和': 'bloom_apply',
    '全等三角形及其性质': 'bloom_understand',
    '三角形全等的判定': 'bloom_analyze',
    '角的平分线': 'bloom_apply',
    '轴对称及其性质': 'bloom_understand',
    '线段的垂直平分线': 'bloom_apply',
    '画轴对称的图形': 'bloom_apply',
    '等腰三角形': 'bloom_analyze',
    '等边三角形': 'bloom_analyze',
    '同底数幂的乘法': 'bloom_apply',
    '幂的乘方与积的乘方': 'bloom_apply',
    '整式的乘法': 'bloom_apply',
    '平方差公式': 'bloom_apply',
    '完全平方公式': 'bloom_apply',
    '用提公因式法分解因式': 'bloom_apply',
    '用公式法分解因式': 'bloom_apply',
    '从分数到分式': 'bloom_understand',
    '分式的基本性质': 'bloom_understand',
    '分式的乘法与除法': 'bloom_apply',
    '分式的加法与减法': 'bloom_apply',
    '整数指数幂': 'bloom_apply',
    '分式方程': 'bloom_analyze',
    '二次根式及其性质': 'bloom_understand',
    '二次根式的乘法与除法': 'bloom_apply',
    '二次根式的加法与减法': 'bloom_apply',
    '勾股定理及其应用': 'bloom_apply',
    '勾股定理的逆定理及其应用': 'bloom_analyze',
    '四边形及其内角和': 'bloom_understand',
    '多边形及其内角和': 'bloom_apply',
    '平行四边形及其性质': 'bloom_apply',
    '平行四边形的判定': 'bloom_analyze',
    '三角形的中位线': 'bloom_apply',
    '矩形': 'bloom_analyze',
    '菱形': 'bloom_analyze',
    '正方形': 'bloom_analyze',
    '函数的概念': 'bloom_understand',
    '函数的表示': 'bloom_apply',
    '一次函数的概念': 'bloom_understand',
    '一次函数的图象和性质': 'bloom_analyze',
    '一次函数与方程不等式': 'bloom_analyze',
    '实际问题与一次函数': 'bloom_evaluate',
    '平均数': 'bloom_apply',
    '中位数和众数': 'bloom_apply',
    '数据的离散程度': 'bloom_analyze',
    '数据的四分位数': 'bloom_apply',
    '数据的分组': 'bloom_apply',
    // ── G9 ─────────────────────────────────────────
    '一元二次方程': 'bloom_understand',
    '配方法': 'bloom_apply',
    '公式法': 'bloom_apply',
    '因式分解法': 'bloom_apply',
    '一元二次方程的根与系数的关系': 'bloom_analyze',
    '实际问题与一元二次方程': 'bloom_analyze',
    '二次函数': 'bloom_understand',
    '二次函数的图象和性质': 'bloom_analyze',
    '二次函数与一元二次方程': 'bloom_analyze',
    '实际问题与二次函数': 'bloom_evaluate',
    '图形的旋转': 'bloom_understand',
    '中心对称': 'bloom_understand',
    '中心对称图形': 'bloom_understand',
    '关于原点对称的点的坐标': 'bloom_apply',
    '图案设计': 'bloom_create',
    '圆': 'bloom_remember',
    '垂直于弦的直径': 'bloom_apply',
    '弧弦圆心角': 'bloom_apply',
    '圆周角': 'bloom_analyze',
    '点和圆的位置关系': 'bloom_apply',
    '直线和圆的位置关系': 'bloom_analyze',
    '正多边形和圆': 'bloom_apply',
    '弧长和扇形面积': 'bloom_apply',
    '随机事件': 'bloom_remember',
    '概率': 'bloom_understand',
    '用列举法求概率': 'bloom_apply',
    '用频率估计概率': 'bloom_analyze',
    '反比例函数': 'bloom_understand',
    '反比例函数的图象和性质': 'bloom_analyze',
    '实际问题与反比例函数': 'bloom_evaluate',
    '图形的相似': 'bloom_understand',
    '相似三角形的判定': 'bloom_analyze',
    '相似三角形的性质': 'bloom_analyze',
    '相似三角形应用举例': 'bloom_apply',
    '位似': 'bloom_apply',
    '锐角三角函数': 'bloom_understand',
    '解直角三角形': 'bloom_apply',
    '解直角三角形的应用': 'bloom_analyze',
    '投影': 'bloom_remember',
    '三视图': 'bloom_apply',
    '制作立体模型': 'bloom_create',
};
function seedBloomEdges(subject) {
    let count = 0;
    for (const [kpTitle, bloomCode] of Object.entries(kpBloom)) {
        const kp = getNode('knowledge_point', undefined, kpTitle);
        const bloom = getNode('bloom_level', bloomCode);
        if (kp && bloom) {
            insEdge.run(kp.id, bloom.id, 'bloom_at', 1.0);
            count++;
        }
    }
    return count;
}
// ── 主入口 ───────────────────────────────────────
/** 注入所有语义关系边（belongs_to / reinforces / prerequisite / bloom_at） */
export function seedAllEdges(subject = 'math') {
    // 硬编码映射（数学）
    const belongsTo = seedBelongsToEdges(subject);
    const reinforces = seedReinforcesEdges(subject);
    const prerequisites = seedPrerequisiteEdges(subject);
    const bloom = seedBloomEdges(subject);
    // JSON 映射（非数学学科：从 LLM 生成 + 人工审核的 JSON 文件加载）
    let jsonEdges = 0;
    if (subject !== 'math') {
        const grades = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
        for (const g of grades) {
            const mappings = loadMappingsFromJson(subject, g);
            if (!mappings)
                continue;
            jsonEdges += seedJsonMappings(subject, mappings);
            console.log(`  [JSON] ${subject} G${g}: loaded ${jsonEdges > 0 ? 'mappings' : 'empty'}`);
        }
    }
    const total = belongsTo + reinforces + prerequisites + bloom + jsonEdges;
    console.log(`[语义映射] 注入 ${total} 条关系`);
    console.log(`  belongs_to: ${belongsTo}, reinforces: ${reinforces}, prerequisite: ${prerequisites}, bloom_at: ${bloom}`);
    if (jsonEdges > 0)
        console.log(`  JSON-loaded: ${jsonEdges}`);
    return total;
}
/** 从 JSON 映射数据注入四类边 */
function seedJsonMappings(subject, mappings) {
    let count = 0;
    // prerequisite
    for (const edge of mappings.prerequisites) {
        const fromNode = getNodeByTitleSubject(edge.from, subject);
        const toNode = getNodeByTitleSubject(edge.to, subject);
        if (fromNode && toNode) {
            insEdge.run(fromNode.id, toNode.id, 'prerequisite', 1.0);
            count++;
        }
    }
    // theme → belongs_to
    for (const [title, themeCode] of Object.entries(mappings.themes)) {
        const kpNode = getNodeByTitleSubject(title, subject);
        const themeNode = getNode('theme', themeCode);
        if (kpNode && themeNode) {
            insEdge.run(kpNode.id, themeNode.id, 'belongs_to', 1.0);
            count++;
        }
    }
    // literacy → reinforces
    for (const [title, litCodes] of Object.entries(mappings.literacies)) {
        const kpNode = getNodeByTitleSubject(title, subject);
        if (!kpNode)
            continue;
        for (const litCode of litCodes) {
            const litNode = getNode('literacy', litCode);
            if (litNode) {
                insEdge.run(kpNode.id, litNode.id, 'reinforces', 1.0);
                count++;
            }
        }
    }
    // bloom → bloom_at
    for (const [title, bloomCode] of Object.entries(mappings.blooms)) {
        const kpNode = getNodeByTitleSubject(title, subject);
        const bloomNode = getNode('bloom_level', bloomCode);
        if (kpNode && bloomNode) {
            insEdge.run(kpNode.id, bloomNode.id, 'bloom_at', 1.0);
            count++;
        }
    }
    return count;
}
// ── CLI 执行（保持向后兼容）──────────────────────
if (process.argv[1] && process.argv[1].includes('kg-enrich')) {
    const subj = process.argv[2] || 'math';
    seedAllEdges(subj);
    // 验证：从 G7 正数和负数 逆推素养链
    const start = db.prepare(`SELECT id FROM kg_nodes WHERE type='knowledge_point' AND title='正数和负数'`).get();
    if (start) {
        console.log('\n═══ 正数和负数 → 知识图谱全景 ═══');
        const up = db.prepare(`
      SELECT e.type AS rel, n.type AS node_type, n.code, n.title
      FROM kg_edges e JOIN kg_nodes n ON n.id=e.target_id
      WHERE e.source_id=? AND e.type!='prerequisite'
      ORDER BY e.type
    `).all(start.id);
        console.log('所属 / 培养方向：');
        for (const u of up)
            console.log('  ╰', u.rel, '→', '[' + u.node_type + ']', u.code || '', u.title);
        const pre = db.prepare(`
      SELECT n.title FROM kg_edges e JOIN kg_nodes n ON n.id=e.source_id
      WHERE e.target_id=? AND e.type='prerequisite'
    `).all(start.id);
        if (pre.length) {
            console.log('前置知识（学这个之前需要会什么）：');
            for (const p of pre)
                console.log('  需要先掌握：' + p.title);
        }
        const post = db.prepare(`
      SELECT n.title FROM kg_edges e JOIN kg_nodes n ON n.id=e.target_id
      WHERE e.source_id=? AND e.type='prerequisite'
    `).all(start.id);
        if (post.length) {
            console.log('后置知识（学了这个才能学什么）：');
            for (const p of post)
                console.log('  支撑着：' + p.title);
        }
        const theme = db.prepare(`
      SELECT n.title FROM kg_edges e JOIN kg_nodes n ON n.id=e.target_id
      WHERE e.source_id=? AND e.type='belongs_to' AND n.type='theme'
    `).get(start.id);
        const lits = db.prepare(`
      SELECT n.title FROM kg_edges e JOIN kg_nodes n ON n.id=e.target_id
      WHERE e.source_id=? AND e.type='reinforces' AND n.type='literacy'
    `).all(start.id);
        const bloom = db.prepare(`
      SELECT n.title FROM kg_edges e JOIN kg_nodes n ON n.id=e.target_id
      WHERE e.source_id=? AND e.type='bloom_at'
    `).get(start.id);
        console.log('\n═══ 学生发展维度全景 ═══');
        console.log('学到「正数和负数」= 不只是认识两个符号');
        if (theme)
            console.log('  主题领域 →', theme.title);
        if (bloom)
            console.log('  认知层级 →', bloom.title);
        if (lits.length)
            console.log('  培养素养 →', lits.map((l) => l.title).join('、'));
    }
    process.exit(0);
}
