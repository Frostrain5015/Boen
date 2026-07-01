/**
 * 教育游戏 —— 知识跑酷：单题出题接口
 *
 * 复用现有选择题生成能力，每次返回 1 道四选一的选择题。
 * 预缓存机制：前端一次性消费多题时批量向此接口请求。
 */
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { stepWriteQuestionsV2 } from './exam.js';

interface GameQuestion {
  id: string;
  stem: string;
  options: { key: string; text: string }[];
  correctKey: string;
}

/** 用随机学科和年级生成一道选择题 */
export async function generateGameQuestion(model: BaseChatModel): Promise<GameQuestion> {
  const subjects = ['math', 'chinese', 'english', 'science'];
  const grades = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
  const subject = subjects[Math.floor(Math.random() * subjects.length)];
  const grade = grades[Math.floor(Math.random() * grades.length)];

  // 用现有出题引擎生成一道选择题
  const questions = await stepWriteQuestionsV2(
    model,
    { subject, grade },
    {
      section: 'mixed',
      questionType: 'multiple_choice',
      count: 1,
      totalPoints: 10,
      distribution: { multiple_choice: 1, fill_blank: 0, true_false: 0, short_answer: 0 },
      difficultyBand: [{ label: 'medium', weight: 1, minCount: 1, maxCount: 1 }],
    },
    {
      title: '跑步小测',
      sections: [{ name: 'mixed', questionType: 'multiple_choice', count: 1, totalPoints: 10 }],
      totalScore: 10,
      distribution: { multiple_choice: 1, fill_blank: 0, true_false: 0, short_answer: 0 },
      difficultyBand: [{ label: 'medium', weight: 1, minCount: 1, maxCount: 1 }],
      constraints: { knowledgePoints: [], noRepeats: [], maxOptions: 4 },
    },
    [],
  );

  if (!questions || questions.length === 0) {
    throw new Error('出题失败');
  }

  const q = questions[0];

  // 构建 4 个选项（不足则补齐）
  const options = (q.options ?? []).slice(0, 4);
  while (options.length < 4) {
    options.push({ key: String.fromCharCode(65 + options.length), text: '___' });
  }

  // 打乱选项顺序并记录正确项
  const correctAnswer = q.correctKeys?.[0] || 'A';
  const correctIndex = options.findIndex((o: { key: string; text: string }) => o.key === correctAnswer);
  const shuffled = shuffleArray(options);
  const newCorrectKey = shuffled[Math.max(0, correctIndex >= 0 ? shuffled.indexOf(options[correctIndex]) : 0)].key;

  return {
    id: `game_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    stem: q.stem || '题目加载中...',
    options: shuffled,
    correctKey: newCorrectKey,
  };
}

function shuffleArray<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
