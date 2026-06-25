/**
 * exam-recommendation.ts — Post-exam Adaptive Recommendations
 *
 * After an exam is graded, analyze the kpBreakdown and proficiency data
 * to recommend next learning steps:
 *   - Weak KPs (score rate < 60%) → trace prerequisite chain for foundational gaps
 *   - Strong KPs (all >= 80%) → recommend preview mode for new material
 *   - Difficulty adjustment based on recent exam history trends
 */
import db from './db.js';
import { findKnowledgePointNode } from './exam.js';
// ── Main function ──────────────────────────────
/**
 * Generate post-exam adaptive recommendations based on exam results.
 *
 * @param userId   - The current user ID
 * @param subject  - Exam subject (e.g. 'math')
 * @param grade    - Exam grade (e.g. '7')
 * @param results  - The graded ExamResults (with kpBreakdown and proficiencyChanges)
 */
export function postExamRecommendation(userId, subject, grade, results) {
    const recommendedPractice = [];
    // ── Step 1: Identify weak KPs from kpBreakdown (score rate < 60%) ──
    const weakKps = results.kpBreakdown.filter((kp) => kp.percentage < 60);
    const allHighKps = results.kpBreakdown.length > 0 && results.kpBreakdown.every((kp) => kp.percentage >= 80);
    if (weakKps.length > 0) {
        // ── Step 2: For each weak KP, trace prerequisite chain ──
        for (const weakKp of weakKps) {
            const node = findKnowledgePointNode(weakKp.kp, subject);
            if (!node) {
                // Cannot find KG node — recommend review mode as fallback
                recommendedPractice.push({
                    kpId: 0,
                    kpTitle: weakKp.kp,
                    reason: `该知识点得分率 ${weakKp.percentage}%，低于 60%，建议复习巩固`,
                    suggestedMode: 'review',
                });
                continue;
            }
            // Query prerequisites: kg_edges where type='prerequisite' AND target_id=node.id
            // (source_id is the prerequisite, target_id is the dependent)
            const prereqs = db.prepare(`
        SELECT e.source_id, n.title
        FROM kg_edges e
        JOIN kg_nodes n ON n.id = e.source_id
        WHERE e.type = 'prerequisite' AND e.target_id = ?
      `).all(node.id);
            let hasFoundationalGap = false;
            if (prereqs.length > 0) {
                // Check each prerequisite's proficiency
                for (const prereq of prereqs) {
                    const profRow = db.prepare(`SELECT weighted_score FROM user_kp_proficiency WHERE user_id = ? AND kg_node_id = ?`).get(userId, prereq.source_id);
                    const prereqProficiency = profRow?.weighted_score ?? -1;
                    if (prereqProficiency >= 0 && prereqProficiency < 60) {
                        // Foundational gap: prerequisite is weak
                        recommendedPractice.push({
                            kpId: prereq.source_id,
                            kpTitle: prereq.title,
                            reason: `前置知识点「${prereq.title}」掌握度仅 ${Math.round(prereqProficiency)}%，是导致「${weakKp.kp}」薄弱的根本原因`,
                            suggestedMode: 'weakness',
                        });
                        hasFoundationalGap = true;
                        break; // One foundational gap per weak KP is enough
                    }
                }
            }
            if (!hasFoundationalGap) {
                // Prerequisites are fine (or none exist) — the current topic itself needs work
                recommendedPractice.push({
                    kpId: node.id,
                    kpTitle: weakKp.kp,
                    reason: `该知识点得分率 ${weakKp.percentage}%，基础前置已掌握，建议针对本知识点强化复习`,
                    suggestedMode: 'review',
                });
            }
        }
    }
    else if (allHighKps) {
        // ── Step 3: All KPs >= 80% → recommend preview mode ──
        // Find KPs from the exam and suggest previewing next-level material
        for (const kp of results.kpBreakdown.slice(0, 3)) {
            const node = findKnowledgePointNode(kp.kp, subject);
            recommendedPractice.push({
                kpId: node?.id ?? 0,
                kpTitle: kp.kp,
                reason: `该知识点已较好掌握（得分率 ${kp.percentage}%），建议预习进阶内容`,
                suggestedMode: 'preview',
            });
        }
    }
    else {
        // Mixed results: some KPs between 60-80% — recommend review for those
        const midKps = results.kpBreakdown.filter((kp) => kp.percentage < 80);
        for (const kp of midKps.slice(0, 5)) {
            const node = findKnowledgePointNode(kp.kp, subject);
            recommendedPractice.push({
                kpId: node?.id ?? 0,
                kpTitle: kp.kp,
                reason: `该知识点得分率 ${kp.percentage}%，仍有提升空间，建议巩固练习`,
                suggestedMode: 'review',
            });
        }
    }
    // Limit to top 5 recommendations, prioritizing weakness > review > preview
    const modePriority = { weakness: 0, review: 1, preview: 2 };
    recommendedPractice.sort((a, b) => (modePriority[a.suggestedMode] ?? 9) - (modePriority[b.suggestedMode] ?? 9));
    const topRecommendations = recommendedPractice.slice(0, 5);
    // ── Step 4: Difficulty adjustment ──
    const difficultyAdjustment = computeDifficultyAdjustment(userId, subject);
    // ── Step 5: Next exam scope ──
    const nextExamScope = computeNextExamScope(subject, grade, results, allHighKps);
    return {
        recommendedPractice: topRecommendations,
        nextExamScope,
        difficultyAdjustment,
    };
}
// ── Difficulty adjustment ──────────────────────
/**
 * Check recent exam history for this user+subject to suggest difficulty changes.
 * - Last 2 exams both > 85% → suggest increasing difficulty
 * - Last 2 exams both < 50% → suggest decreasing difficulty
 * - Otherwise → maintain current
 */
function computeDifficultyAdjustment(userId, subject) {
    const recentExams = db.prepare(`
    SELECT results FROM exam_sessions
    WHERE user_id = ? AND subject = ? AND status = 'completed'
    ORDER BY submitted_at DESC
    LIMIT 5
  `).all(userId, subject);
    if (recentExams.length < 2) {
        return { currentLevel: 'medium', suggestedLevel: 'medium' };
    }
    // Parse percentages from the two most recent exams
    const percentages = [];
    for (const row of recentExams.slice(0, 2)) {
        try {
            const parsed = JSON.parse(row.results);
            if (typeof parsed.percentage === 'number') {
                percentages.push(parsed.percentage);
            }
        }
        catch {
            // Skip malformed results
        }
    }
    if (percentages.length < 2) {
        return { currentLevel: 'medium', suggestedLevel: 'medium' };
    }
    const [latest, previous] = percentages;
    if (latest > 85 && previous > 85) {
        return { currentLevel: 'medium', suggestedLevel: 'hard' };
    }
    if (latest < 50 && previous < 50) {
        return { currentLevel: 'medium', suggestedLevel: 'easy' };
    }
    return { currentLevel: 'medium', suggestedLevel: 'medium' };
}
// ── Next exam scope ────────────────────────────
function computeNextExamScope(subject, grade, results, allHigh) {
    const subjectLabels = { chinese: '语文', math: '数学', english: '英语', science: '科学' };
    const subjectLabel = subjectLabels[subject] ?? subject;
    if (allHigh) {
        return {
            subject,
            grade,
            reason: `${subjectLabel}各知识点掌握良好，建议下次考试适当提升难度或预习新章节`,
        };
    }
    // Find the weakest KP to focus on
    const weakest = results.kpBreakdown.reduce((min, kp) => (kp.percentage < min.percentage ? kp : min), results.kpBreakdown[0]);
    return {
        subject,
        grade,
        reason: weakest
            ? `建议下次重点考查「${weakest.kp}」等薄弱知识点，针对性突破`
            : `建议继续巩固${subjectLabel}基础知识`,
    };
}
