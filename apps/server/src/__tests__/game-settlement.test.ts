import { describe, expect, it } from 'vitest';
import db from '../db.js';
import { issueGameQuestion, publicGameQuestion, submitGameAnswer } from '../game.js';
import { finishGameSession, getDailyChallenge, getGameStats, getStageProgress } from '../game-store.js';

function stageQuestions(userId: string, roundId: string) {
  return Array.from({ length: 5 }, (_, i) => issueGameQuestion({
    id: 'template', stem: `${i + 1} + 1`,
    options: ['A', 'B', 'C', 'D'].map((key, j) => ({ key, text: String(i + 2 + j) })),
    correctKey: 'A', explain: '加一',
  }, 'math', { userId, roundId, mode: 'stage', stage: 1, grade: '8' }));
}

describe('game settlement', () => {
  it('protects answers and binds the first choice to the issuing account and round', () => {
    const questions = stageQuestions('alice', 'alice-stage');
    expect(publicGameQuestion(questions[0]!, true)).not.toHaveProperty('correctKey');
    expect(publicGameQuestion(questions[0]!, true)).not.toHaveProperty('explain');
    const answers = questions.map(q => ({ questionId: q.id, chosenKey: 'A' }));
    const input = { userId: 'alice', roundId: 'alice-stage', subject: 'math', mode: 'stage', stage: 1, grade: '8', answers } as const;
    expect(finishGameSession({ ...input })).toBeNull();
    expect(submitGameAnswer('bob', answers[0]!.questionId, 'A')).toBeNull();
    for (const answer of answers) expect(submitGameAnswer('alice', answer.questionId, 'A')?.correctKey).toBe('A');
    expect(submitGameAnswer('alice', answers[0]!.questionId, 'B')).toBeNull();
    expect(finishGameSession({ ...input, mode: 'endless', stage: undefined })).toBeNull();
    expect(finishGameSession({ ...input, stage: 999 })).toBeNull();
    expect(finishGameSession({ ...input, answers: Array(5).fill(answers[0]!) })).toBeNull();
    expect(finishGameSession({ ...input, answers: [...answers].reverse() })).toBeNull();
    const settled = finishGameSession({ ...input });
    expect(settled?.correctCount).toBe(5);
    expect(settled?.points).toBe(0);
    expect(getStageProgress('alice', 'math').stage).toBe(2);
    expect(finishGameSession({ ...input })).toEqual(settled);
    expect(getGameStats('alice').games).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM currency_ledger WHERE user_id='alice' AND reason='game'").get()).toEqual({ n: 0 });
  });

  it('records wrong answers and reserves the daily bonus for a completed challenge', () => {
    const userId = 'daily-player';
    const roundId = 'daily-attempt';
    const questions = Array.from({ length: 10 }, (_, i) => issueGameQuestion({
      id: 'template', stem: `daily ${i}`,
      options: ['A', 'B', 'C', 'D'].map(key => ({ key, text: key })),
      correctKey: 'A',
    }, 'math', { userId, roundId, mode: 'daily', grade: '8' }));
    const answers = questions.slice(0, 3).map(q => ({ questionId: q.id, chosenKey: 'B' }));
    for (const answer of answers) expect(submitGameAnswer(userId, answer.questionId, answer.chosenKey)).not.toBeNull();
    expect(submitGameAnswer(userId, questions[3]!.id, 'A')).toBeNull();
    const result = finishGameSession({ userId, roundId, subject: 'math', mode: 'daily', grade: '8', answers });
    expect(result).toMatchObject({ correctCount: 0, points: 0, dailyCompleted: false, mistakesCreated: 3 });
    expect(getDailyChallenge(userId, 'math', () => questions).state.completed).toBe(false);
  });
});
