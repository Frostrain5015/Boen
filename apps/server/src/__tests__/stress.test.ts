/**
 * 重度压力测试 — 模拟所有模式下大量随机答题序列。
 *
 * 运行：npx vitest run apps/server/src/__tests__/stress-test.ts --reporter=verbose
 * 或直接跑：npx tsx apps/server/src/__tests__/stress-test.ts
 */
import { describe, it, expect } from 'vitest';
import {
  computeProficiencyDelta,
  cacheProficiencyUpdate,
  getCachedProficiencySum,
  getCachedProficiencyExpected,
  setCachedProficiencyExpected,
  hasCachedExpectedRating,
  flushProficiencyCache,
  difficultyLevelToValue,
  ELO_RATING_INIT,
  ELO_SIGMA_INIT,
} from '../knowledge-profile.js';

// ── 配置 ───────────────────────────────────────
const MODES = ['qa', 'preview', 'review', 'weakness', 'practice', 'exam', 'explore'];
const DIFFICULTIES = ['easy', 'medium', 'hard'];
const ITERATIONS = 5_000; // 每场景迭代次数
const MAX_QUESTIONS = 15;   // 每次会话最多题目数

// ── 工具 ───────────────────────────────────────
function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomCorrect(): number {
  return Math.random() < 0.6 ? 1 : 0; // 60% 正确率
}

function starVal(v: number): number {
  if (v < 0) return 0;
  return Math.round(Math.max(0, v) / 10) / 2;
}

// ═══════════════════════════════════════════════════════════
// 测试 1：纯数学随机序列 — 确保无崩溃
// ═══════════════════════════════════════════════════════════
describe('压力测试：纯数学随机序列', () => {
  for (const mode of MODES) {
    it(`${mode} 模式 ${ITERATIONS} 次随机序列`, () => {
      for (let seq = 0; seq < ITERATIONS; seq++) {
        let rating = ELO_RATING_INIT;
        let sigma = ELO_SIGMA_INIT;
        const qCount = randomInt(1, MAX_QUESTIONS);

        for (let q = 0; q < qCount; q++) {
          const score = randomCorrect();
          const difficulty = DIFFICULTIES[randomInt(0, 2)];
          const diffVal = difficultyLevelToValue(difficulty);
          // 偶尔模拟部分正确
          const maxScore = Math.random() < 0.2 ? randomInt(1, 3) : 1;
          const actualScore = maxScore > 1 ? randomInt(0, maxScore) : score;

          const result = computeProficiencyDelta(
            rating, sigma, actualScore, maxScore, mode, 0, diffVal,
          );

          // 不变量断言
          expect(result.newRating).withContext(
            `mode=${mode} seq=${seq} q=${q}: rating out of range`,
          ).toBeGreaterThanOrEqual(0);
          expect(result.newRating).toBeLessThanOrEqual(100);
          expect(result.newSigma).withContext(
            `sigma out of range: ${result.newSigma}`,
          ).toBeGreaterThanOrEqual(3);
          expect(result.newSigma).toBeLessThanOrEqual(25);
          expect(Number.isFinite(result.delta)).toBe(true);

          rating = result.newRating;
          sigma = result.newSigma;
        }

        // 最终星星不越界
        const stars = starVal(rating);
        expect(stars).toBeGreaterThanOrEqual(0);
        expect(stars).toBeLessThanOrEqual(5);
      }
    });
  }
});

// ═══════════════════════════════════════════════════════════
// 测试 2：缓存协同压力 — 模拟课堂多知识点交错练习
// ═══════════════════════════════════════════════════════════
describe('压力测试：缓存协同', () => {
  for (const mode of MODES) {
    it(`${mode} 模式 ${ITERATIONS} 次缓存操作`, () => {
      // 每轮模拟一个新 thread
      const threadId = `stress-${mode}-${Date.now()}-${Math.random()}`;
      const userId = 'stress-user';

      // 模拟 3 个知识点交错答题
      const kps = [1101, 1102, 1103];
      const ratings: Record<number, number> = {};
      const sigmas: Record<number, number> = {};
      for (const kp of kps) {
        ratings[kp] = ELO_RATING_INIT;
        sigmas[kp] = ELO_SIGMA_INIT;
      }

      for (let round = 0; round < ITERATIONS; round++) {
        const kp = kps[randomInt(0, 2)];
        const score = randomCorrect();
        const maxScore = 1;

        // 缓存累加
        cacheProficiencyUpdate(userId, threadId, kp, score, maxScore, mode);

        // 增量计算
        const hadCache = hasCachedExpectedRating(userId, threadId, kp);
        const expected = getCachedProficiencyExpected(
          userId, threadId, kp,
          ratings[kp] ?? ELO_RATING_INIT,
          sigmas[kp] ?? ELO_SIGMA_INIT,
          0,
        );
        const oldR = ratings[kp] ?? ELO_RATING_INIT;
        const oldS = sigmas[kp] ?? ELO_SIGMA_INIT;
        const result = computeProficiencyDelta(oldR, oldS, score, maxScore, mode, 0);
        ratings[kp] = result.newRating;
        sigmas[kp] = result.newSigma;
        setCachedProficiencyExpected(userId, threadId, kp, result.newRating, result.newSigma);

        // 不变量
        expect(result.newRating).toBeGreaterThanOrEqual(0);
        expect(result.newRating).toBeLessThanOrEqual(100);
        expect(result.newSigma).toBeGreaterThanOrEqual(3);
        expect(result.newSigma).toBeLessThanOrEqual(25);
      }

      // 结算 flush
      const { count, changes } = flushProficiencyCache(userId, threadId);
      expect(count).toBe(3);
      expect(changes).toHaveLength(3);
      for (const c of changes) {
        expect(c.before).toBeGreaterThanOrEqual(0);
        expect(c.after).toBeGreaterThanOrEqual(0);
        // after 应 >= before（因为 60% 正确率）
      }
    });
  }
});

// ═══════════════════════════════════════════════════════════
// 测试 3：长会话疲劳测试 — 模拟极端场景
// ═══════════════════════════════════════════════════════════
describe('压力测试：长会话疲劳', () => {
  it('100 题连续答题不崩溃', () => {
    const MODE = 'review';
    let rating = ELO_RATING_INIT;
    let sigma = ELO_SIGMA_INIT;

    for (let q = 0; q < 100; q++) {
      const diff = difficultyLevelToValue(DIFFICULTIES[randomInt(0, 2)]);
      const result = computeProficiencyDelta(
        rating, sigma, randomCorrect(), 1, MODE, 0, diff,
      );
      rating = result.newRating;
      sigma = result.newSigma;
    }

    // 100 题后 sigma 应已接近最小值
    expect(sigma).toBeGreaterThanOrEqual(3);
    expect(sigma).toBeLessThanOrEqual(25);
    // rating 不应漂移出界
    expect(rating).toBeGreaterThanOrEqual(0);
    expect(rating).toBeLessThanOrEqual(100);
  });

  it('交替正确/错误 50 轮，rating 不应跑飞', () => {
    const MODE = 'qa';
    let rating = ELO_RATING_INIT;
    let sigma = ELO_SIGMA_INIT;

    // 交替 01 01 01...
    for (let q = 0; q < 100; q++) {
      const score = q % 2;
      const result = computeProficiencyDelta(rating, sigma, score, 1, MODE, 0);
      rating = result.newRating;
      sigma = result.newSigma;
    }

    // 交替应对 rating 稳定在中位附近
    expect(rating).toBeGreaterThanOrEqual(30);
    expect(rating).toBeLessThanOrEqual(70);
  });

  it('全对 200 题 rating 应趋近 100（达到天花板）', () => {
    const MODE = 'qa';
    let rating = ELO_RATING_INIT;
    let sigma = ELO_SIGMA_INIT;

    for (let q = 0; q < 200; q++) {
      const result = computeProficiencyDelta(rating, sigma, 1, 1, MODE, 0);
      rating = result.newRating;
      sigma = result.newSigma;
    }

    // 200 道全对应接近满分
    expect(rating).toBeGreaterThanOrEqual(95);
    expect(rating).toBeLessThanOrEqual(100);
  });
});
