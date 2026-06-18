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

/** EMA 平滑因子：0.3 = 新成绩占 30%，历史占 70% */
const PROFICIENCY_ALPHA = 0.3;

export function updateProficiency(userId: string, kgNodeId: number, score: number, maxScore: number): KpProficiency {
  const existing = db.prepare(`SELECT * FROM user_kp_proficiency WHERE user_id=? AND kg_node_id=?`).get(userId, kgNodeId) as any;
  const correct = existing ? existing.correct_count + score : score;
  const total = existing ? existing.total_count + maxScore : maxScore;
  const now = Math.floor(Date.now() / 1000);

  // 指数移动平均：新成绩权重 α，旧权重 (1-α)
  const pct = maxScore > 0 ? (score / maxScore) * 100 : 0;
  const weighted = existing
    ? Math.round(PROFICIENCY_ALPHA * pct + (1 - PROFICIENCY_ALPHA) * existing.weighted_score)
    : Math.round(pct);

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

    return { title, knowledgePoints: kpNodes };
  }

  // 加权平均函数：按 weight 字段加权
  function weightedAvg(kps: any[]): number {
    const valid = kps.filter((k: any) => k.weightedScore >= 0);
    if (!valid.length) return -1;
    const totalWeight = valid.reduce((s: number, k: any) => s + k.weight, 0);
    if (totalWeight <= 0) return Math.round(valid.reduce((s: number, k: any) => s + k.weightedScore, 0) / valid.length);
    return Math.round(valid.reduce((s: number, k: any) => s + k.weightedScore * k.weight, 0) / totalWeight);
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

  return {
    subject, grade,
    overall: {
      weightedScore: overallCount > 0 ? Math.round(overallSum / overallCount) : -1,
      weakCount, goodCount, masteredCount,
      totalKps: overallCount,
    },
    textbooks: textbookNodes,
  };
}
