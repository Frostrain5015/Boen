/**
 * 结构化学习全模式场景测试。
 * 模拟每种模式下同一知识点连答 5 题的各种答案组合，
 * 验证最终熟练度在合理范围内，且过程中不抛异常。
 */
import { describe, it, expect } from 'vitest';
import { computeProficiencyDelta, difficultyLevelToValue, ELO_RATING_INIT, ELO_SIGMA_INIT } from '../knowledge-profile.js';

const STAR_BANDS = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5];

function starVal(v: number): number {
  if (v < 0) return 0;
  return Math.round(Math.max(0, v) / 10) / 2;
}

interface Step {
  score: number;
  maxScore: number;
}

interface Scenario {
  name: string;
  mode: string;
  steps: Step[];
  expectMinStars: number;
  expectMaxStars: number;
}

const SCENARIOS: Scenario[] = [
  // ═══ review 模式 ═══
  { name: 'review-5全对', mode: 'review', steps: '11111', expectMinStars: 4.0, expectMaxStars: 5.0 },
  { name: 'review-1错4对', mode: 'review', steps: '01111', expectMinStars: 3.5, expectMaxStars: 5.0 },
  { name: 'review-5全错', mode: 'review', steps: '00000', expectMinStars: 0, expectMaxStars: 1.0 },
  { name: 'review-3对2错', mode: 'review', steps: '11011', expectMinStars: 2.0, expectMaxStars: 4.0 },
  // ═══ weakness 模式（同 review，modeMult=2.0）═══
  { name: 'weakness-5全对', mode: 'weakness', steps: '11111', expectMinStars: 4.0, expectMaxStars: 5.0 },
  { name: 'weakness-1错4对', mode: 'weakness', steps: '01111', expectMinStars: 3.5, expectMaxStars: 5.0 },
  // ═══ exam 模式（同 review，modeMult=2.0）═══
  { name: 'exam-5全对', mode: 'exam', steps: '11111', expectMinStars: 4.0, expectMaxStars: 5.0 },
  // ═══ qa 模式（modeMult=1.0）═══
  { name: 'qa-5全对', mode: 'qa', steps: '11111', expectMinStars: 2.5, expectMaxStars: 3.5 },
  { name: 'qa-1错4对', mode: 'qa', steps: '01111', expectMinStars: 2.0, expectMaxStars: 3.5 },
  { name: 'qa-5全错', mode: 'qa', steps: '00000', expectMinStars: 0, expectMaxStars: 1.0 },
  // ═══ preview 模式（modeMult=0.7）═══
  { name: 'preview-5全对', mode: 'preview', steps: '11111', expectMinStars: 2.0, expectMaxStars: 3.0 },
  // ═══ explore 模式（modeMult=0.4）═══
  { name: 'explore-5全对', mode: 'explore', steps: '11111', expectMinStars: 1.0, expectMaxStars: 2.0 },
];

// 解析 steps 字符串：'01111' → 第 1 题错，后 4 题对
function parseSteps(s: string): Step[] {
  return s.split('').map((ch) => ({ score: ch === '1' ? 1 : 0, maxScore: 1 }));
}

describe('结构化学习场景精算', () => {
  for (const sc of SCENARIOS) {
    it(sc.name, () => {
      const steps = parseSteps(sc.steps);
      let rating = ELO_RATING_INIT;
      let sigma = ELO_SIGMA_INIT;

      for (const step of steps) {
        const result = computeProficiencyDelta(
          rating, sigma, step.score, step.maxScore, sc.mode, 0,
        );
        rating = result.newRating;
        sigma = result.newSigma;
      }

      const stars = starVal(rating);
      expect(stars).withContext(
        `mode=${sc.mode}, steps=${sc.steps}: rating=${Math.round(rating)}, stars=${stars}`,
      ).toBeGreaterThanOrEqual(sc.expectMinStars);
      expect(stars).toBeLessThanOrEqual(sc.expectMaxStars);
    });
  }
});

describe('所有模式下 rating 不越界', () => {
  const MODES = ['qa', 'preview', 'review', 'weakness', 'practice', 'exam', 'explore'];
  const PATTERNS = ['11111', '00000', '10101', '01010'];

  for (const mode of MODES) {
    for (const pattern of PATTERNS) {
      it(`${mode} ${pattern}`, () => {
        let rating = ELO_RATING_INIT;
        let sigma = ELO_SIGMA_INIT;
        for (const ch of pattern) {
          const result = computeProficiencyDelta(
            rating, sigma, ch === '1' ? 1 : 0, 1, mode, 0,
          );
          rating = result.newRating;
          sigma = result.newSigma;
        }
        expect(rating).toBeGreaterThanOrEqual(0);
        expect(rating).toBeLessThanOrEqual(100);
        expect(sigma).toBeGreaterThanOrEqual(3);
        expect(sigma).toBeLessThanOrEqual(25);
      });
    }
  }
});

describe('难度组合场景', () => {
  const SCENARIOS: { name: string; difficulties: string[]; steps: string; expectStars: number }[] = [
    { name: 'easy 题全对 → 涨得少', difficulties: ['easy', 'easy', 'easy', 'easy', 'easy'], steps: '11111', expectStars: 3.0 },
    { name: 'hard 题全对 → 涨得多', difficulties: ['hard', 'hard', 'hard', 'hard', 'hard'], steps: '11111', expectStars: 4.5 },
  ];

  for (const sc of SCENARIOS) {
    it(sc.name, () => {
      let rating = ELO_RATING_INIT;
      let sigma = ELO_SIGMA_INIT;

      for (let i = 0; i < sc.steps.length; i++) {
        const ch = sc.steps[i];
        const diff = difficultyLevelToValue(sc.difficulties[i]);
        const result = computeProficiencyDelta(
          rating, sigma, ch === '1' ? 1 : 0, 1, 'review', 0, diff,
        );
        rating = result.newRating;
        sigma = result.newSigma;
      }

      expect(starVal(rating)).toBeGreaterThanOrEqual(sc.expectStars);
    });
  }
});
