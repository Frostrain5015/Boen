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

/**
 * Textbook navigation markers, not assessable teaching sections.  The source
 * curriculum remains unchanged; only the learner profile tree is pruned.
 */
const PROFILE_OUTLINE_NOISE = /^(?:数学活动|小结|复习题\d*|阅读综合实践|本章复习与测试|(?:单元)?整理和复习|总复习)$/u;

export function isProfileOutlineNoise(title: string): boolean {
  return PROFILE_OUTLINE_NOISE.test(title.replace(/\s+/g, '').replace(/^☆/, ''));
}

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

// ── Elo 常量 ──────────────────────────────────
const ELO_RATING_INIT = 50;
const ELO_SIGMA_INIT = 20;
const ELO_SIGMA_MIN = 3;
const ELO_SIGMA_MAX = 25;
const ELO_K_BASE = 5;
const ELO_SCALING = 15;      // logistic scaling factor
const ELO_DEFAULT_DIFFICULTY = 50;

/** 各模式下对 Elo K-factor 的倍增器（不是直接控制 observed，而是控制更新幅度的权重） */
const MODE_ELO_MULTIPLIERS: Record<string, number> = {
  qa: 1.0,
  preview: 0.7,
  review: 1.0,
  weakness: 1.3,
  exam: 1.5,
};

/** 前置依赖反向传播用的 K-factor（比主更新弱得多） */
const ELO_K_PROPAGATE = 2;

// ── Elo 辅助函数 ──────────────────────────────

/** 逻辑期望：给定 rating 和题目难度，预期正确率 */
function expectedCorrectness(rating: number, difficulty: number): number {
  return 1 / (1 + Math.exp(-(rating - difficulty) / ELO_SCALING));
}

/** 根据不确定度和模式计算 K-factor */
function computeKFactor(sigma: number, mode: string): number {
  const modeMult = MODE_ELO_MULTIPLIERS[mode] ?? 1.0;
  const uncertaintyFactor = 1 + (sigma / ELO_SIGMA_MAX);
  return ELO_K_BASE * modeMult * uncertaintyFactor;
}

/** Elo 评分更新核心 */
function updateRatingElo(
  oldRating: number, oldSigma: number,
  observed: number, expected: number,
  mode: string,
): { newRating: number; newSigma: number; delta: number } {
  const K = computeKFactor(oldSigma, mode);
  const delta = K * (observed - expected);
  const newRating = Math.max(0, Math.min(100, oldRating + delta));
  const newSigma = Math.max(ELO_SIGMA_MIN, Math.min(ELO_SIGMA_MAX, oldSigma * 0.85));
  return { newRating: Math.round(newRating * 10) / 10, newSigma: Math.round(newSigma * 10) / 10, delta: Math.round(delta * 10) / 10 };
}

/** 遗忘：距上次练习每过一天 sigma 涨 0.5，上限 ELO_SIGMA_MAX */
function applyForgetting(sigma: number, lastUpdated: number, now: number): number {
  if (lastUpdated <= 0) return sigma;
  const daysSince = Math.max(0, (now - lastUpdated) / 86400);
  if (daysSince < 0.5) return sigma;
  return Math.min(ELO_SIGMA_MAX, sigma + 0.5 * daysSince);
}

/** 旧 EMA 自适应 alpha（保留后向兼容） */
const BASE_ALPHA = 0.25;
function adaptiveAlpha(effectivePct: number, oldWeighted: number): number {
  const diff = effectivePct - oldWeighted;
  if (diff > 15) return 0.45;
  if (diff > 5) return 0.35;
  if (diff < -10) return 0.12;
  if (diff < -3) return 0.18;
  return BASE_ALPHA;
}

/** 旧 EMA 模式权重（保留后向兼容） */
const MODE_WEIGHTS: Record<string, number> = {
  qa: 1.0, preview: 0.5, review: 1.0, weakness: 1.5, exam: 2.0,
};

// ── CRUD ─────────────────────────────────────

export function updateProficiency(userId: string, kgNodeId: number, score: number, maxScore: number, mode?: string): KpProficiency {
  const existing = db.prepare(`SELECT * FROM user_kp_proficiency WHERE user_id=? AND kg_node_id=?`).get(userId, kgNodeId) as any;
  const correct = existing ? existing.correct_count + score : score;
  const total = existing ? existing.total_count + maxScore : maxScore;
  const now = Math.floor(Date.now() / 1000);

  // ── Elo 路径 ──
  const modeKey = mode ?? 'qa';
  const oldRating = existing?.rating ?? ELO_RATING_INIT;
  const oldSigma = existing?.rating_sigma ?? ELO_SIGMA_INIT;

  // 1. 遗忘：先增长 sigma
  const sigmaBefore = applyForgetting(oldSigma, existing?.last_updated ?? 0, now);

  // 2. 期望正确率
  const expected = expectedCorrectness(oldRating, ELO_DEFAULT_DIFFICULTY);

  // 3. 观测值：得分比例 × 模式倍数
  const modeMult = MODE_ELO_MULTIPLIERS[modeKey] ?? 1.0;
  const observed = maxScore > 0 ? Math.min(1, (score / maxScore) * modeMult) : 0;

  // 4. Elo 更新
  const { newRating, newSigma, delta } = updateRatingElo(oldRating, sigmaBefore, observed, expected, modeKey);

  // ── 旧 EMA 后向兼容 ──
  const oldWeighted = existing?.weighted_score ?? 50;
  const modeWeight = MODE_WEIGHTS[modeKey] ?? 1.0;
  const weightedPct = maxScore > 0 ? ((score * modeWeight) / maxScore) * 100 : 0;
  const effectivePct = Math.min(100, weightedPct);
  const alpha = existing ? adaptiveAlpha(effectivePct, oldWeighted) : BASE_ALPHA;
  const weighted = Math.round(alpha * effectivePct + (1 - alpha) * oldWeighted);

  // ── 写库：weighted_score 向后兼容，rating/sigma 是新数据 ──
  db.prepare(`
    INSERT INTO user_kp_proficiency (user_id, kg_node_id, correct_count, total_count, weighted_score, rating, rating_sigma, last_updated)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, kg_node_id) DO UPDATE SET
      correct_count = excluded.correct_count,
      total_count = excluded.total_count,
      weighted_score = excluded.weighted_score,
      rating = excluded.rating,
      rating_sigma = excluded.rating_sigma,
      last_updated = excluded.last_updated
  `).run(userId, kgNodeId, correct, total, Math.round(newRating), newRating, newSigma, now);

  // ── 前置依赖反向传播（仅当 observed > expected + 0.15，即明显答对时才传播） ──
  if (observed > expected + 0.15) {
    const prereqs = db.prepare(`
      SELECT e.source_id FROM kg_edges e
      WHERE e.target_id=? AND e.type='prerequisite'
    `).all(kgNodeId) as Array<{ source_id: number }>;
    for (const prereq of prereqs) {
      const prev = db.prepare(`SELECT rating, rating_sigma, last_updated FROM user_kp_proficiency WHERE user_id=? AND kg_node_id=?`).get(userId, prereq.source_id) as any;
      if (!prev) continue;
      const preSigma = applyForgetting(prev.rating_sigma ?? ELO_SIGMA_INIT, prev.last_updated ?? 0, now);
      const preExpected = expectedCorrectness(prev.rating ?? ELO_RATING_INIT, ELO_DEFAULT_DIFFICULTY);
      const preDelta = ELO_K_PROPAGATE * (1.0 - preExpected);
      const preNewRating = Math.max(0, Math.min(100, (prev.rating ?? ELO_RATING_INIT) + preDelta));
      const preNewSigma = Math.max(ELO_SIGMA_MIN, Math.min(ELO_SIGMA_MAX, preSigma * 0.9));
      db.prepare(`
        UPDATE user_kp_proficiency SET rating=?, rating_sigma=?, last_updated=?
        WHERE user_id=? AND kg_node_id=?
      `).run(
        Math.round(preNewRating * 10) / 10,
        Math.round(preNewSigma * 10) / 10,
        now, userId, prereq.source_id,
      );
    }
  }

  const node = db.prepare(`SELECT title FROM kg_nodes WHERE id=?`).get(kgNodeId) as { title: string } | undefined;
  return {
    kgNodeId,
    title: node?.title ?? '',
    correctCount: correct,
    totalCount: total,
    weightedScore: Math.round(newRating),
    level: getProficiencyLevel(Math.round(newRating)),
    lastUpdated: now,
    rating: newRating,
    ratingSigma: newSigma,
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
    rating: row.rating ?? undefined,
    ratingSigma: row.rating_sigma ?? undefined,
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
    rating: row.rating ?? undefined,
    ratingSigma: row.rating_sigma ?? undefined,
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
    const rt = prof?.rating;
    const sg = prof?.ratingSigma;
    const weight = node.weight ?? 0.5;

    // 三因素评分：0.5 薄弱 + 0.3 信息增益 + 0.2 重要性
    const weakness = rt != null ? Math.max(0, 1 - rt / 100) : 1.0;
    const infoGain = sg != null ? Math.min(1, sg / ELO_SIGMA_MAX) : 1.0;
    const score = 0.5 * weakness + 0.3 * infoGain + 0.2 * weight;

    // 原因文本：结合 sigma 提供更精准的说明
    let reason: string;
    if (ws < 0) {
      reason = '尚未练习过';
    } else if (ws < 60 && sg != null && sg > 15) {
      reason = '需要加强（建议优先练习，提高掌握度）';
    } else if (ws < 60) {
      reason = '需要加强';
    } else if (sg != null && sg > 15) {
      reason = '巩固提升（不确定度较高）';
    } else {
      reason = '巩固提升';
    }

    scored.push({
      kgNodeId: node.id,
      title: node.title,
      weightedScore: ws,
      level: getProficiencyLevel(ws >= 0 ? ws : 0),
      weight,
      reason,
      rating: rt ?? undefined,
      ratingSigma: sg ?? undefined,
    });
  }

  // 按三因素评分排序
  scored.sort((a, b) => {
    const wa = a.rating != null ? Math.max(0, 1 - a.rating / 100) : 1.0;
    const wb = b.rating != null ? Math.max(0, 1 - b.rating / 100) : 1.0;
    const ia = a.ratingSigma != null ? Math.min(1, a.ratingSigma / ELO_SIGMA_MAX) : 1.0;
    const ib = b.ratingSigma != null ? Math.min(1, b.ratingSigma / ELO_SIGMA_MAX) : 1.0;
    const sa = 0.5 * wa + 0.3 * ia + 0.2 * (a.weight ?? 0.5);
    const sb = 0.5 * wb + 0.3 * ib + 0.2 * (b.weight ?? 0.5);
    return sb - sa;
  });

  const topK = scored.slice(0, limit);

  // 前置依赖感知排序：若 A 是 B 的前置依赖，确保 A 排在 B 前面
  for (let i = 0; i < topK.length; i++) {
    for (let j = i + 1; j < topK.length; j++) {
      const prereq = db.prepare(`
        SELECT 1 FROM kg_edges
        WHERE source_id=? AND target_id=? AND type='prerequisite'
      `).get(topK[j].kgNodeId, topK[i].kgNodeId);
      if (prereq) {
        // topK[j] 是 topK[i] 的前置依赖 → 交换
        [topK[i], topK[j]] = [topK[j], topK[i]];
      }
    }
  }

  return topK;
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

  // 加权平均函数：所有 KP 参与聚合，未练习的计 0 分，按「已练习占比」打折
  function weightedAvg(kps: any[]): number {
    const practiced = kps.filter((k: any) => k.weightedScore >= 0);
    if (!practiced.length) return -1;
    // 所有知识点（含未练习的计 0 分）参与加权
    let sumScore = 0, sumWeight = 0;
    for (const k of kps) {
      const richness = Math.min(1, (k.totalCount ?? 0) / RICHNESS_THRESHOLD);
      // 未练习的知识点也有最小权重，避免被完全忽略
      const w = (k.weight ?? 0.5) * Math.max(0.2, richness);
      const score = k.weightedScore >= 0 ? k.weightedScore : 0;
      sumScore += score * w;
      sumWeight += w;
    }
    // 再按已练习比例打折（练了 1/2 个知识点 → 最多 50 分）
    const practiceRatio = practiced.length / kps.length;
    return sumWeight > 0 ? Math.round((sumScore / sumWeight) * practiceRatio) : -1;
  }

  for (const tb of tbs) {
    const chapters = db.prepare(
      `SELECT id, title FROM curriculum_units WHERE textbook_id=? AND parent_id IS NULL ORDER BY seq`
    ).all(tb.id).filter((unit: any) => !isProfileOutlineNoise(unit.title)) as any[];

    const chapterNodes = chapters.map((ch: any) => {
      const sections = db.prepare(
        `SELECT id, title FROM curriculum_units WHERE parent_id=? ORDER BY seq`
      ).all(ch.id).filter((unit: any) => !isProfileOutlineNoise(unit.title)) as any[];
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
