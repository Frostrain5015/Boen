/**
 * Elo 熟练度算法纯函数单元测试。
 * 不依赖数据库，直接测试数学计算。
 */
import { describe, it, expect } from 'vitest';
import {
  computeProficiencyDelta,
  difficultyLevelToValue,
  ELO_RATING_INIT,
  ELO_SIGMA_INIT,
} from '../knowledge-profile.js';

// ── Star 映射（与 StarDisplay.vue 一致）───────────────────
function starVal(v: number): number {
  if (v < 0) return 0;
  return Math.round(Math.max(0, v) / 10) / 2;
}

describe('difficultyLevelToValue', () => {
  it('easy → 35', () => expect(difficultyLevelToValue('easy')).toBe(35));
  it('medium → 50', () => expect(difficultyLevelToValue('medium')).toBe(50));
  it('hard → 65', () => expect(difficultyLevelToValue('hard')).toBe(65));
  it('undefined → 50', () => expect(difficultyLevelToValue(undefined)).toBe(50));
});

describe('starVal（线性映射）', () => {
  it('rating 0 → 0 ★', () => expect(starVal(0)).toBe(0));
  it('rating 25 → 1.5 ★', () => expect(starVal(25)).toBe(1.5));
  it('rating 45 → 2.5 ★', () => expect(starVal(45)).toBe(2.5));
  it('rating 55 → 3.0 ★', () => expect(starVal(55)).toBe(3.0));
  it('rating 75 → 4.0 ★', () => expect(starVal(75)).toBe(4.0));
  it('rating 95 → 5.0 ★', () => expect(starVal(95)).toBe(5.0));
  it('rating 100 → 5.0 ★', () => expect(starVal(100)).toBe(5.0));
  it('rating < 0 → 0 ★', () => expect(starVal(-1)).toBe(0));
});

// ═══════════════════════════════════════════════════════════
// review 模式 (modeMult=2.0, K_BASE=8)
// ═══════════════════════════════════════════════════════════
describe('review 模式 — 5 道全对', () => {
  const MODE = 'review';
  let rating = ELO_RATING_INIT; // 0
  let sigma = ELO_SIGMA_INIT;   // 20
  const results: { q: number; rating: number; stars: number }[] = [];

  for (let q = 1; q <= 5; q++) {
    const { newRating, newSigma } = computeProficiencyDelta(
      rating, sigma, 1, 1, MODE, 0,
    );
    rating = newRating;
    sigma = newSigma;
    results.push({ q, rating: Math.round(rating), stars: starVal(rating) });
  }

  results.forEach((r) => {
    it(`Q${r.q}: rating=${r.rating}, 星星=${r.stars}`, () => {
      expect(r.rating).toBeGreaterThanOrEqual(0);
      expect(r.rating).toBeLessThanOrEqual(100);
      expect(r.stars).toBeGreaterThanOrEqual(0);
      expect(r.stars).toBeLessThanOrEqual(5);
    });
  });

  it('第 4 题应达 3.5★（rating≥65）', () => {
    expect(results[3].stars).toBeGreaterThanOrEqual(3.5);
  });

  it('第 5 题应达 4.0★（rating≥75）', () => {
    expect(results[4].stars).toBeGreaterThanOrEqual(4.0);
  });
});

describe('review 模式 — 1 错 4 对', () => {
  const MODE = 'review';
  let rating = ELO_RATING_INIT;
  let sigma = ELO_SIGMA_INIT;
  const Q = [
    { score: 0, maxScore: 1 }, // 第 1 题错
    { score: 1, maxScore: 1 },
    { score: 1, maxScore: 1 },
    { score: 1, maxScore: 1 },
    { score: 1, maxScore: 1 },
  ];
  const snapshots: number[] = [];

  for (const q of Q) {
    const r = computeProficiencyDelta(rating, sigma, q.score, q.maxScore, MODE, 0);
    rating = r.newRating;
    sigma = r.newSigma;
    snapshots.push(Math.round(rating));
  }

  it('第 1 题错后 rating 应近 0（贴地）', () => {
    expect(snapshots[0]).toBeLessThanOrEqual(5);
  });

  it('最终应恢复到 3.5★ 以上（rating≥65）', () => {
    expect(snapshots[4]).toBeGreaterThanOrEqual(65);
  });
});

describe('review 模式 — 5 道全错', () => {
  const MODE = 'review';
  let rating = ELO_RATING_INIT;
  let sigma = ELO_SIGMA_INIT;
  let finalRating = 0;

  for (let q = 0; q < 5; q++) {
    const r = computeProficiencyDelta(rating, sigma, 0, 1, MODE, 0);
    rating = r.newRating;
    sigma = r.newSigma;
    finalRating = rating;
  }

  it('5 全错 rating 应近 0（不降负数）', () => {
    expect(finalRating).toBeGreaterThanOrEqual(0);
    expect(finalRating).toBeLessThanOrEqual(5);
  });
});

// ═══════════════════════════════════════════════════════════
// qa 模式 (modeMult=1.0, K_BASE=12)
// ═══════════════════════════════════════════════════════════
describe('qa 模式 — 5 道全对', () => {
  const MODE = 'qa';
  let rating = ELO_RATING_INIT;
  let sigma = ELO_SIGMA_INIT;

  for (let q = 0; q < 5; q++) {
    const r = computeProficiencyDelta(rating, sigma, 1, 1, MODE, 0);
    rating = r.newRating;
    sigma = r.newSigma;
  }

  it('最终应在 2.5★~3.0★ 区间', () => {
    const stars = starVal(rating);
    expect(stars).toBeGreaterThanOrEqual(2.5);
    expect(stars).toBeLessThanOrEqual(3.0);
  });
});

// ═══════════════════════════════════════════════════════════
// explore 模式 (modeMult=0.4, K_BASE=12)
// ═══════════════════════════════════════════════════════════
describe('explore 模式 — 5 道全对', () => {
  const MODE = 'explore';
  let rating = ELO_RATING_INIT;
  let sigma = ELO_SIGMA_INIT;

  for (let q = 0; q < 5; q++) {
    const r = computeProficiencyDelta(rating, sigma, 1, 1, MODE, 0);
    rating = r.newRating;
    sigma = r.newSigma;
  }

  it('最终不应超过 2.0★', () => {
    expect(starVal(rating)).toBeLessThanOrEqual(2.0);
  });

  it('rating 不降负数', () => {
    expect(rating).toBeGreaterThanOrEqual(0);
  });
});

// ═══════════════════════════════════════════════════════════
// 难度影响
// ═══════════════════════════════════════════════════════════
describe('题目难度对 delta 的影响', () => {
  const MODE = 'review';

  it('答对 hard 题的 delta > 答对 easy 题的 delta', () => {
    const easy = computeProficiencyDelta(0, 20, 1, 1, MODE, 0, difficultyLevelToValue('easy'));
    const hard = computeProficiencyDelta(0, 20, 1, 1, MODE, 0, difficultyLevelToValue('hard'));
    expect(hard.delta).toBeGreaterThan(easy.delta);
  });

  it('答错 easy 题的惩罚 > 答错 hard 题', () => {
    const easy = computeProficiencyDelta(0, 20, 0, 1, MODE, 0, difficultyLevelToValue('easy'));
    const hard = computeProficiencyDelta(0, 20, 0, 1, MODE, 0, difficultyLevelToValue('hard'));
    // 应更负（惩罚更大）
    expect(easy.delta).toBeLessThan(hard.delta);
  });
});

// ═══════════════════════════════════════════════════════════
// 边界条件
// ═══════════════════════════════════════════════════════════
describe('边界条件', () => {
  const MODE = 'qa';

  it('rating 不低于 0', () => {
    const r = computeProficiencyDelta(0, 20, 0, 1, MODE, 0);
    expect(r.newRating).toBeGreaterThanOrEqual(0);
  });

  it('rating 不高于 100', () => {
    const r = computeProficiencyDelta(99, 20, 1, 1, MODE, 0);
    expect(r.newRating).toBeLessThanOrEqual(100);
  });

  it('sigma 不低于 ELO_SIGMA_MIN（3）', () => {
    let sigma = 5;
    for (let i = 0; i < 20; i++) {
      const r = computeProficiencyDelta(50, sigma, 1, 1, MODE, 0);
      sigma = r.newSigma;
    }
    expect(sigma).toBeGreaterThanOrEqual(3);
  });

  it('sigma 不高于 ELO_SIGMA_MAX（25）', () => {
    const r = computeProficiencyDelta(50, 100, 1, 1, MODE, 0);
    expect(r.newSigma).toBeLessThanOrEqual(25);
  });

  it('obsolute maximum delta 不超 100（Math.clamp）', () => {
    const r = computeProficiencyDelta(0, 25, 1, 1, MODE, 0);
    expect(r.newRating).toBeLessThanOrEqual(100);
  });
});

// ═══════════════════════════════════════════════════════════
// 逐题增量 vs 累计总额
// ═══════════════════════════════════════════════════════════
describe('逐题增量（Running Rating）行为', () => {
  const MODE = 'review';

  it('每道题的 before 应等于上一题的 after（newRating）', () => {
    let oldRating = ELO_RATING_INIT;
    let sigma = ELO_SIGMA_INIT;
    const questions = [
      { score: 0, maxScore: 1 }, // 错
      { score: 1, maxScore: 1 }, // 对
      { score: 1, maxScore: 1 },
    ];
    const changes: { before: number; after: number }[] = [];

    for (const q of questions) {
      const r = computeProficiencyDelta(oldRating, sigma, q.score, q.maxScore, MODE, 0);
      changes.push({ before: Math.round(oldRating), after: Math.round(r.newRating) });
      oldRating = r.newRating;
      sigma = r.newSigma;
    }

    // before ② 应 ≈ after ①（逐题继承）
    expect(changes[1].before).toBe(changes[0].after);
    expect(changes[2].before).toBe(changes[1].after);

    // 第 2 题对：应显示回升
    expect(changes[1].after).toBeGreaterThan(changes[1].before);
  });
});
