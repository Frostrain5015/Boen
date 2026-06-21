/**
 * 缓存机制集成测试。
 * 测试 cacheProficiencyUpdate / getCachedProficiencySum /
 * getCachedProficiencyExpected / setCachedProficiencyExpected /
 * hasCachedExpectedRating / flushProficiencyCache 的交互正确性。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  cacheProficiencyUpdate,
  getCachedProficiencySum,
  getCachedProficiencyExpected,
  setCachedProficiencyExpected,
  hasCachedExpectedRating,
  flushProficiencyCache,
  computeProficiencyDelta,
  ELO_RATING_INIT,
  ELO_SIGMA_INIT,
} from '../knowledge-profile.js';

const USER = 'test-user';
const THREAD = 'test-thread';
const KP_A = 1001; // 「树特征的识别」
const KP_B = 1002; // 「植物的分类」

beforeEach(() => {
  // 清除可能残留的缓存（flush 会 delete key）
  flushProficiencyCache(USER, THREAD);
  flushProficiencyCache(USER, `${THREAD}-other`);
});

describe('cacheProficiencyUpdate + getCachedProficiencySum', () => {
  it('首次缓存应创建累计记录', () => {
    cacheProficiencyUpdate(USER, THREAD, KP_A, 1, 1, 'review');
    const sum = getCachedProficiencySum(USER, THREAD, KP_A);
    expect(sum).not.toBeNull();
    expect(sum!.score).toBe(1);
    expect(sum!.maxScore).toBe(1);
    expect(sum!.mode).toBe('review');
  });

  it('同一知识点多次更新应累加', () => {
    cacheProficiencyUpdate(USER, THREAD, KP_A, 1, 1, 'review');
    cacheProficiencyUpdate(USER, THREAD, KP_A, 0, 1, 'review');
    const sum = getCachedProficiencySum(USER, THREAD, KP_A);
    expect(sum!.score).toBe(1);
    expect(sum!.maxScore).toBe(2);
  });

  it('不同知识点应隔离', () => {
    cacheProficiencyUpdate(USER, THREAD, KP_A, 1, 1, 'review');
    cacheProficiencyUpdate(USER, THREAD, KP_B, 1, 1, 'weakness');
    expect(getCachedProficiencySum(USER, THREAD, KP_A)!.mode).toBe('review');
    expect(getCachedProficiencySum(USER, THREAD, KP_B)!.mode).toBe('weakness');
  });

  it('不同 thread 应隔离', () => {
    cacheProficiencyUpdate(USER, THREAD, KP_A, 1, 1, 'review');
    expect(getCachedProficiencySum(USER, `${THREAD}-other`, KP_A)).toBeNull();
  });
});

describe('hasCachedExpectedRating / getCachedProficiencyExpected / setCachedProficiencyExpected', () => {
  it('首次调用 hasCachedExpectedRating 应返回 false', () => {
    cacheProficiencyUpdate(USER, THREAD, KP_A, 1, 1, 'review');
    expect(hasCachedExpectedRating(USER, THREAD, KP_A)).toBe(false);
  });

  it('getCachedProficiencyExpected 首次应初始化并返回 dbRating', () => {
    cacheProficiencyUpdate(USER, THREAD, KP_A, 1, 1, 'review');
    const { rating, sigma, lastUpdated } = getCachedProficiencyExpected(
      USER, THREAD, KP_A, 0, 20, 0,
    );
    expect(rating).toBe(0); // ELI_RATING_INIT = 0
    expect(sigma).toBe(20);
    expect(lastUpdated).toBe(0); // 首次调用返回原始 dbLastUpdated（0）
  });

  it('初始化后 hasCachedExpectedRating 应返回 true', () => {
    cacheProficiencyUpdate(USER, THREAD, KP_A, 1, 1, 'review');
    getCachedProficiencyExpected(USER, THREAD, KP_A, 0, 20, 0);
    expect(hasCachedExpectedRating(USER, THREAD, KP_A)).toBe(true);
  });

  it('setCachedProficiencyExpected 后新值应被读取', () => {
    cacheProficiencyUpdate(USER, THREAD, KP_A, 1, 1, 'review');
    getCachedProficiencyExpected(USER, THREAD, KP_A, 0, 20, 0);
    setCachedProficiencyExpected(USER, THREAD, KP_A, 55, 10);
    const { rating } = getCachedProficiencyExpected(USER, THREAD, KP_A, 0, 20, 0);
    expect(rating).toBe(55);
  });

  it('逐题增量：连续三次计算，每次 oldRating 应等于上次 newRating', () => {
    cacheProficiencyUpdate(USER, THREAD, KP_A, 0, 1, 'review');
    // 第 1 题：错
    let { rating: oldR, sigma: oldS } = getCachedProficiencyExpected(
      USER, THREAD, KP_A, 0, 20, 0,
    );
    let r1 = computeProficiencyDelta(oldR, oldS, 0, 1, 'review', 0);
    setCachedProficiencyExpected(USER, THREAD, KP_A, r1.newRating, r1.newSigma);

    // 第 2 题：对
    cacheProficiencyUpdate(USER, THREAD, KP_A, 1, 1, 'review');
    let r2state = getCachedProficiencyExpected(USER, THREAD, KP_A, 0, 20, 0);
    expect(r2state.rating).toBe(r1.newRating); // 继承上次结果
    let r2 = computeProficiencyDelta(r2state.rating, r2state.sigma, 1, 1, 'review', 0);
    setCachedProficiencyExpected(USER, THREAD, KP_A, r2.newRating, r2.newSigma);

    // 第 3 题：对
    cacheProficiencyUpdate(USER, THREAD, KP_A, 1, 1, 'review');
    let r3state = getCachedProficiencyExpected(USER, THREAD, KP_A, 0, 20, 0);
    expect(r3state.rating).toBe(r2.newRating);
  });
});

describe('flushProficiencyCache', () => {
  it('缓存非空时 flush 返回 count > 0', () => {
    cacheProficiencyUpdate(USER, THREAD, KP_A, 1, 1, 'review');
    cacheProficiencyUpdate(USER, THREAD, KP_B, 1, 1, 'weakness');
    const { count, changes } = flushProficiencyCache(USER, THREAD);
    expect(count).toBe(2);
    expect(changes).toHaveLength(2);
  });

  it('flush 后缓存应清空', () => {
    cacheProficiencyUpdate(USER, THREAD, KP_A, 1, 1, 'review');
    flushProficiencyCache(USER, THREAD);
    expect(getCachedProficiencySum(USER, THREAD, KP_A)).toBeNull();
  });

  it('空缓存 flush 返回 0', () => {
    const { count, changes } = flushProficiencyCache(USER, THREAD);
    expect(count).toBe(0);
    expect(changes).toEqual([]);
  });

  it('flush 的 changes 数组中应有 kpTitle（至少不为空字符串）', () => {
    cacheProficiencyUpdate(USER, THREAD, KP_A, 1, 1, 'review');
    const { changes } = flushProficiencyCache(USER, THREAD);
    for (const c of changes) {
      expect(c.kpTitle).toBeTruthy();
      expect(c.before).toBeGreaterThanOrEqual(0);
      expect(c.after).toBeGreaterThanOrEqual(0);
    }
  });
});
