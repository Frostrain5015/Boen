/**
 * knowledge-profile.ts — 用户知识画像
 *
 * 每次答题后记录知识点熟练度，基于知识图谱计算：
 * - 知识点掌握度（weighted_score 0-100）
 * - 核心素养聚合（通过 kg_edges.reinforces）
 * - 薄弱点追溯（通过 kg_edges.prerequisite）
 * - 针对性练习推荐（按 weakness × weight 排序）
 */

import db from './db.js';
import type { ProficiencyLevel, KpProficiency, LiteracyProficiency, ProfileRecommendation } from '@boen/shared';

// ── 等级阈值 ────────────────────────────────
export const PROFICIENCY_THRESHOLDS = {
  mastered: 90,
  proficient: 70,
  developing: 40,
  // < 40 → needs_practice
};

export function getProficiencyLevel(weightedScore: number): ProficiencyLevel {
  if (weightedScore >= PROFICIENCY_THRESHOLDS.mastered) return 'mastered';
  if (weightedScore >= PROFICIENCY_THRESHOLDS.proficient) return 'proficient';
  if (weightedScore >= PROFICIENCY_THRESHOLDS.developing) return 'developing';
  return 'needs_practice';
}

// ── CRUD ─────────────────────────────────────

/** EMA 基础平滑因子 */
const BASE_ALPHA = 0.25;

/** 自适应 alpha：好转时加速上升，恶化时减速下降 */
function adaptiveAlpha(effectivePct: number, oldWeighted: number): number {
  const diff = effectivePct - oldWeighted;
  // 显著好转（当前表现远超历史）→ 加速吸收
  if (diff > 15) return 0.45;
  // 轻度好转 → 略快
  if (diff > 5) return 0.35;
  // 恶化 → 减速，让坏成绩影响变小
  if (diff < -10) return 0.12;
  if (diff < -3) return 0.18;
  // 持平 → 基础速度
  return BASE_ALPHA;
}

/** 各模式下熟练度权重（预习容错高、考试权重高） */
const MODE_WEIGHTS: Record<string, number> = {
  qa: 1.0,       // 通用对话
  preview: 0.5,  // 预习——探索阶段，容错高
  review: 1.0,   // 复习巩固——正常
  weakness: 1.5, // 薄弱点突破——刻意训练，权重高
  exam: 2.0,     // 考试——时间压力下表现更能反映真实水平
};

export function updateProficiency(userId: string, kgNodeId: number, score: number, maxScore: number, mode?: string): KpProficiency {
  const existing = db.prepare(`SELECT * FROM user_kp_proficiency WHERE user_id=? AND kg_node_id=?`).get(userId, kgNodeId) as any;
  const correct = existing ? existing.correct_count + score : score;
  const total = existing ? existing.total_count + maxScore : maxScore;
  const now = Math.floor(Date.now() / 1000);

  // 加权 EMA：不同模式下对熟练度的影响不同
  const modeWeight = MODE_WEIGHTS[mode ?? 'qa'] ?? 1.0;
  const weightedPct = maxScore > 0 ? ((score * modeWeight) / maxScore) * 100 : 0;
  const effectivePct = Math.min(100, weightedPct);

  // 自适应 alpha：进步时加速上升，退步时减速下降
  const alpha = existing ? adaptiveAlpha(effectivePct, existing.weighted_score) : BASE_ALPHA;
  // 首次答题从 50 分起步用 EMA 平滑上升，避免1题满分
  const INITIAL_WEIGHT = 50;
  const weighted = existing
    ? Math.round(alpha * effectivePct + (1 - alpha) * existing.weighted_score)
    : Math.round(alpha * effectivePct + (1 - alpha) * INITIAL_WEIGHT);

  db.prepare(`
    INSERT INTO user_kp_proficiency (user_id, kg_node_id, correct_count, total_count, weighted_score, last_updated)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, kg_node_id) DO UPDATE SET
      correct_count = excluded.correct_count,
      total_count = excluded.total_count,
      weighted_score = excluded.weighted_score,
      last_updated = excluded.last_updated
  `).run(userId, kgNodeId, correct, total, weighted, now);

  const node = db.prepare(`SELECT title FROM kg_nodes WHERE id=?`).get(kgNodeId) as { title: string } | undefined;
  return {
    kgNodeId,
    title: node?.title ?? '',
    correctCount: correct,
    totalCount: total,
    weightedScore: weighted,
    level: getProficiencyLevel(weighted),
    lastUpdated: now,
  };
}

export function getProficiency(userId: string, kgNodeId: number): KpProficiency | null {
  const row = db.prepare(`
    SELECT p.*, n.title FROM user_kp_proficiency p
    JOIN kg_nodes n ON n.id = p.kg_node_id
    WHERE p.user_id=? AND p.kg_node_id=?
  `).get(userId, kgNodeId) as any;
  if (!row) return null;
  return {
    kgNodeId: row.kg_node_id, title: row.title,
    correctCount: row.correct_count, totalCount: row.total_count,
    weightedScore: row.weighted_score, level: getProficiencyLevel(row.weighted_score),
    lastUpdated: row.last_updated,
  };
}

export function getAllProficiencies(userId: string, subject?: string, grade?: string): KpProficiency[] {
  let sql = `
    SELECT p.*, n.title FROM user_kp_proficiency p
    JOIN kg_nodes n ON n.id = p.kg_node_id
    WHERE p.user_id=?
  `;
  const params: unknown[] = [userId];
  if (subject) { sql += ` AND n.subject=?`; params.push(subject); }
  if (grade) {
    sql += ` AND EXISTS (SELECT 1 FROM curriculum_kg_map m JOIN curriculum_units u ON u.id=m.unit_id JOIN curriculum_textbooks t ON t.id=u.textbook_id WHERE m.node_id=p.kg_node_id AND t.grade=?)`;
    params.push(grade);
  }
  sql += ` ORDER BY p.weighted_score ASC`;
  return (db.prepare(sql).all(...params) as any[]).map((row: any) => ({
    kgNodeId: row.kg_node_id, title: row.title,
    correctCount: row.correct_count, totalCount: row.total_count,
    weightedScore: row.weighted_score, level: getProficiencyLevel(row.weighted_score),
    lastUpdated: row.last_updated,
  }));
}

// ── 弱点 / 优势 ─────────────────────────────

export function getWeakPoints(userId: string, subject: string, grade?: string, threshold = 60, limit = 10): KpProficiency[] {
  const all = getAllProficiencies(userId, subject, grade);
  return all.filter((p) => p.weightedScore < threshold).slice(0, limit);
}

export function getStrongPoints(userId: string, subject: string, grade?: string, threshold = 75, limit = 10): KpProficiency[] {
  const all = getAllProficiencies(userId, subject, grade);
  return all.filter((p) => p.weightedScore >= threshold).sort((a, b) => b.weightedScore - a.weightedScore).slice(0, limit);
}

// ── 素养聚合 ───────────────────────────────

export function getLiteracyProficiency(userId: string, subject: string): LiteracyProficiency[] {
  // 找该学科所有 literacy 节点
  const lits = db.prepare(`SELECT id, code, title FROM kg_nodes WHERE type='literacy' AND subject=?`).all(subject) as any[];
  const result: LiteracyProficiency[] = [];

  for (const lit of lits) {
    // 找出 reinforces → 该素养的所有 KP
    const kps = db.prepare(`
      SELECT n.id FROM kg_edges e
      JOIN kg_nodes n ON n.id = e.source_id
      WHERE e.target_id=? AND e.type='reinforces' AND n.type='knowledge_point'
    `).all(lit.id) as any[];

    if (kps.length === 0) continue;

    let totalScore = 0, totalMax = 0;
    for (const kp of kps) {
      const prof = db.prepare(`SELECT correct_count, total_count FROM user_kp_proficiency WHERE user_id=? AND kg_node_id=?`).get(userId, kp.id) as any;
      if (prof) {
        totalScore += prof.correct_count;
        totalMax += prof.total_count;
      }
    }
    result.push({
      literacy: lit.title,
      score: totalScore,
      totalScore: totalMax,
      percentage: totalMax > 0 ? Math.round((totalScore / totalMax) * 100) : 0,
    });
  }

  return result;
}

// ── 弱点链追溯 ─────────────────────────────

export function getPrerequisiteWeaknessChain(userId: string, kgNodeId: number, maxDepth = 5): Array<{
  nodeId: number; title: string; weightedScore: number; level: ProficiencyLevel;
}> {
  const chain: Array<any> = [];
  const visited = new Set<number>();
  let currentId = kgNodeId;

  for (let i = 0; i < maxDepth && currentId && !visited.has(currentId); i++) {
    visited.add(currentId);
    const prof = getProficiency(userId, currentId);
    const node = db.prepare(`SELECT id, title FROM kg_nodes WHERE id=?`).get(currentId) as any;
    if (!node) break;

    chain.push({
      nodeId: currentId,
      title: node.title,
      weightedScore: prof?.weightedScore ?? -1,
      level: prof?.level ?? 'needs_practice',
    });

    // 找前置依赖
    const prereq = db.prepare(`
      SELECT n.id FROM kg_edges e
      JOIN kg_nodes n ON n.id = e.source_id
      WHERE e.target_id=? AND e.type='prerequisite'
    `).get(currentId) as { id: number } | undefined;
    currentId = prereq?.id ?? 0;
  }

  return chain;
}

// ── 推荐 ───────────────────────────────────

export function getRecommendedKPs(userId: string, subject: string, grade: string, limit = 5): ProfileRecommendation[] {
  const all = db.prepare(`
    SELECT DISTINCT n.id, n.title, n.weight
    FROM kg_nodes n
    JOIN curriculum_kg_map m ON m.node_id = n.id
    JOIN curriculum_units u ON u.id = m.unit_id
    JOIN curriculum_textbooks t ON t.id = u.textbook_id
    WHERE n.type='knowledge_point' AND t.subject=? AND t.grade=?
  `).all(subject, grade) as any[];

  const scored: ProfileRecommendation[] = [];
  for (const node of all) {
    const prof = getProficiency(userId, node.id);
    const ws = prof?.weightedScore ?? -1;
    // 还没答过题的优先推荐
    const weakness = prof ? (1 - ws / 100) : 1.0;
    const weight = node.weight ?? 0.5;
    const score = weakness * weight;

    scored.push({
      kgNodeId: node.id,
      title: node.title,
      weightedScore: ws,
      level: getProficiencyLevel(ws >= 0 ? ws : 0),
      weight,
      reason: ws < 0 ? '尚未练习过' : ws < 60 ? '需要加强' : '巩固提升',
    });
  }

  return scored.sort((a, b) => {
    const aScore = ((1 - (a.weightedScore >= 0 ? a.weightedScore : 0) / 100) * a.weight);
    const bScore = ((1 - (b.weightedScore >= 0 ? b.weightedScore : 0) / 100) * b.weight);
    return bScore - aScore;
  }).slice(0, limit);
}

// ── 历史回填 ───────────────────────────────

export function seedProficiencyFromHistory(userId: string): { updated: number } {
  const msgs = db.prepare(`
    SELECT content FROM messages
    WHERE role='system' AND content LIKE '%__boen_type%grading_result%'
    ORDER BY created_at ASC
  `).all() as { content: string }[];

  let count = 0;
  for (const msg of msgs) {
    try {
      const meta = JSON.parse(msg.content);
      if (meta.__boen_type === 'grading_result' && meta.result?.knowledgePoints?.length) {
        for (const kpName of meta.result.knowledgePoints) {
          // 模糊匹配：精确 → 包含 → 反向包含（与 exam.ts findKnowledgePointNode 一致）
          let node = db.prepare(`SELECT id FROM kg_nodes WHERE type='knowledge_point' AND title=?`).get(kpName) as { id: number } | undefined;
          if (!node) node = db.prepare(`SELECT id FROM kg_nodes WHERE type='knowledge_point' AND title LIKE ?`).get(`%${kpName}%`) as { id: number } | undefined;
          if (!node) node = db.prepare(`SELECT id FROM kg_nodes WHERE type='knowledge_point' AND ? LIKE '%' || title`).get(kpName) as { id: number } | undefined;
          if (node) {
            updateProficiency(userId, node.id, meta.result.score ?? 0, meta.result.maxScore ?? 1);
            count++;
          }
        }
      }
    } catch { /* skip malformed */ }
  }

  return { updated: count };
}

// ── 大纲数据（章节树 + 掌握度） ─────────────

/**
 * 返回教材大纲树，每个节点附带掌握度数据。
 * 前端画像视图的唯一数据源。
 */
export function getProfileOutline(subject: string, grade: string, userId?: string): object {
  const tbs = db.prepare(
    `SELECT id, volume FROM curriculum_textbooks WHERE subject=? AND grade=? ORDER BY volume`
  ).all(subject, grade) as any[];

  const textbookNodes: any[] = [];
  let overallSum = 0, overallCount = 0;
  let weakCount = 0, goodCount = 0, masteredCount = 0;

  function enrichUnit(unitId: number, title: string): any {
    const kps = db.prepare(`
      SELECT n.id, n.title, n.weight FROM curriculum_kg_map m
      JOIN kg_nodes n ON n.id = m.node_id
      WHERE m.unit_id=? AND n.type='knowledge_point'
    `).all(unitId) as any[];

    const kpNodes = kps.map((kp: any) => {
      const prof = userId ? getProficiency(userId, kp.id) : null;
      const ws = prof?.weightedScore ?? -1;
      const lits = db.prepare(`
        SELECT n.title FROM kg_edges e JOIN kg_nodes n ON n.id=e.target_id
        WHERE e.source_id=? AND e.type='reinforces'
      `).all(kp.id) as any[];
      const prereqs = db.prepare(`
        SELECT n.title FROM kg_edges e JOIN kg_nodes n ON n.id=e.source_id
        WHERE e.target_id=? AND e.type='prerequisite'
      `).all(kp.id) as any[];
      return {
        title: kp.title,
        weightedScore: ws >= 0 ? ws : -1,
        level: ws >= 0 ? getProficiencyLevel(ws) : undefined,
        correctCount: prof?.correctCount ?? 0,
        totalCount: prof?.totalCount ?? 0,
        weight: kp.weight ?? 0.5,
        literacies: lits.map((l: any) => l.title),
        prerequisites: prereqs.map((p: any) => p.title),
      };
    });

    for (const kp of kpNodes) {
      if (kp.weightedScore >= 0) {
        overallSum += kp.weightedScore;
        overallCount++;
        if (kp.weightedScore < 60) weakCount++;
        else if (kp.weightedScore >= 80) masteredCount++;
        else goodCount++;
      }
    }

    const secAvg = weightedAvg(kpNodes);
    return { title, weightedScore: secAvg, knowledgePoints: kpNodes };
  }

  /** 数据丰富度阈值：低于此练习次数的知识点在聚合时权重打折 */
  const RICHNESS_THRESHOLD = 5;

  // 加权平均函数：按 weight × 数据丰富度加权（练习次数越多、权重越大，越有可信度）
  function weightedAvg(kps: any[]): number {
    const valid = kps.filter((k: any) => k.weightedScore >= 0);
    if (!valid.length) return -1;
    let sumScore = 0, sumWeight = 0;
    for (const k of valid) {
      const richness = Math.min(1, (k.totalCount ?? 0) / RICHNESS_THRESHOLD);
      const w = (k.weight ?? 0.5) * richness;
      sumScore += k.weightedScore * w;
      sumWeight += w;
    }
    return sumWeight > 0 ? Math.round(sumScore / sumWeight) : Math.round(valid.reduce((s: number, k: any) => s + k.weightedScore, 0) / valid.length);
  }

  for (const tb of tbs) {
    const chapters = db.prepare(
      `SELECT id, title FROM curriculum_units WHERE textbook_id=? AND parent_id IS NULL ORDER BY seq`
    ).all(tb.id) as any[];

    const chapterNodes = chapters.map((ch: any) => {
      const sections = db.prepare(
        `SELECT id, title FROM curriculum_units WHERE parent_id=? ORDER BY seq`
      ).all(ch.id) as any[];
      const sectionNodes = sections.map((sec: any) => enrichUnit(sec.id, sec.title));
      const chKps = sectionNodes.flatMap((s: any) => s.knowledgePoints);
      const chAvg = weightedAvg(chKps);
      return {
        title: ch.title,
        weightedScore: chAvg,
        level: chAvg >= 0 ? getProficiencyLevel(chAvg) : undefined,
        children: sectionNodes,
      };
    });

    // 每册的综合进度
    const tbKps = chapterNodes.flatMap((c: any) => c.children.flatMap((s: any) => s.knowledgePoints));
    const tbAvg = weightedAvg(tbKps);
    textbookNodes.push({
      volume: tb.volume,
      weightedScore: tbAvg,
      level: tbAvg >= 0 ? getProficiencyLevel(tbAvg) : undefined,
      chapters: chapterNodes,
    });
  }

  // 全局聚合也统一用加权平均（考虑数据丰富度）
  const allKps = textbookNodes.flatMap((t: any) =>
    t.chapters.flatMap((c: any) => c.children.flatMap((s: any) => s.knowledgePoints))
  );
  const overallWeighted = weightedAvg(allKps);

  return {
    subject, grade,
    overall: {
      weightedScore: overallWeighted,
      weakCount, goodCount, masteredCount,
      totalKps: overallCount,
    },
    textbooks: textbookNodes,
  };
}
