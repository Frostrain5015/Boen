import type { AnswerPayload, GradingResult, QuestionPayload } from '@boen/shared';
import {
  fillBlankSchema,
  multipleChoiceSchema,
  shortAnswerSchema,
  trueFalseSchema,
} from './schemas.js';

export { quizTools, QUIZ_TOOL_NAMES } from './schemas.js';

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, '');
const setEq = (a: string[], b: string[]) => {
  const sa = new Set(a.map((x) => x.trim().toUpperCase()));
  const sb = new Set(b.map((x) => x.trim().toUpperCase()));
  return sa.size === sb.size && [...sa].every((x) => sb.has(x));
};

/** 把模型给的工具参数（含答案）转成发给前端的题目（剥离答案） */
export function toQuestionPayload(toolName: string, rawArgs: unknown): QuestionPayload {
  switch (toolName) {
    case 'ask_multiple_choice': {
      const a = multipleChoiceSchema.parse(rawArgs);
      return {
        type: 'multiple_choice',
        stem: a.stem,
        passage: a.passage ?? undefined,
        options: a.options,
        multiSelect: a.multiSelect,
        knowledgePoint: a.knowledgePoint ?? undefined,
        difficulty: a.difficulty ?? undefined,
      };
    }
    case 'ask_fill_blank': {
      const a = fillBlankSchema.parse(rawArgs);
      return {
        type: 'fill_blank',
        stem: a.stem,
        passage: a.passage ?? undefined,
        blankCount: a.blanks.length,
        knowledgePoint: a.knowledgePoint ?? undefined,
        difficulty: a.difficulty ?? undefined,
      };
    }
    case 'ask_true_false': {
      const a = trueFalseSchema.parse(rawArgs);
      return {
        type: 'true_false',
        stem: a.stem,
        passage: a.passage ?? undefined,
        knowledgePoint: a.knowledgePoint ?? undefined,
        difficulty: a.difficulty ?? undefined,
      };
    }
    case 'ask_short_answer': {
      const a = shortAnswerSchema.parse(rawArgs);
      return {
        type: 'short_answer',
        stem: a.stem,
        passage: a.passage ?? undefined,
        knowledgePoint: a.knowledgePoint ?? undefined,
        difficulty: a.difficulty ?? undefined,
      };
    }
    default:
      throw new Error(`未知出题工具：${toolName}`);
  }
}

/** 服务端判分。返回判分结果 + 回灌给模型的 ToolMessage 内容。 */
export function gradeAnswer(
  toolName: string,
  rawArgs: unknown,
  answer: AnswerPayload,
): { result: GradingResult; toolContent: string } {
  let result: GradingResult;

  const commonResult = (base: GradingResult): GradingResult => {
    const args = rawArgs as Record<string, unknown>;
    return {
      ...base,
      knowledgePoints: args.knowledgePoint ? [String(args.knowledgePoint)] : undefined,
      literacies: Array.isArray(args.literacies) ? (args.literacies as string[]) : undefined,
    };
  };

  if (toolName === 'ask_multiple_choice' && answer.type === 'multiple_choice') {
    const a = multipleChoiceSchema.parse(rawArgs);
    const correct = setEq(answer.selectedKeys, a.correctKeys);
    const refText = a.correctKeys
      .map((k) => `${k}. ${a.options.find((o) => o.key === k)?.text ?? ''}`.trim())
      .join('；');
    result = commonResult({ correct, score: correct ? 1 : 0, maxScore: 1, reference: refText, explanation: a.explanation });
  } else if (toolName === 'ask_fill_blank' && answer.type === 'fill_blank') {
    const a = fillBlankSchema.parse(rawArgs);
    const perBlank = a.blanks.map((b, i) =>
      b.acceptedAnswers.some((acc) => norm(acc) === norm(answer.answers[i] ?? '')),
    );
    const score = perBlank.filter(Boolean).length;
    const reference = a.blanks.map((b, i) => `空${i + 1}：${b.acceptedAnswers.join(' / ')}`).join('；');
    result = commonResult({
      correct: perBlank.every(Boolean),
      score,
      maxScore: a.blanks.length,
      reference,
      explanation: a.explanation,
      perBlank,
    });
  } else if (toolName === 'ask_true_false' && answer.type === 'true_false') {
    const a = trueFalseSchema.parse(rawArgs);
    const correct = answer.value === a.answer;
    result = commonResult({
      correct,
      score: correct ? 1 : 0,
      maxScore: 1,
      reference: a.answer ? '正确' : '错误',
      explanation: a.explanation,
    });
  } else if (toolName === 'ask_short_answer' && answer.type === 'short_answer') {
    const a = shortAnswerSchema.parse(rawArgs);
    const ref = a.referenceAnswer
      ? (a.keyPoints?.length ? `${a.referenceAnswer}\n要点：${a.keyPoints.join('、')}` : a.referenceAnswer)
      : (a.keyPoints?.length ? `要点：${a.keyPoints.join('、')}` : '（无参考答案）');
    // 简答题由模型定性评判
    result = commonResult({ correct: null, score: 0, maxScore: 1, reference: ref, explanation: a.explanation ?? '' });
  } else {
    throw new Error(`题型与答案不匹配：${toolName}`);
  }

  const toolContent = JSON.stringify({
    userAnswer: answer,
    correct: result.correct,
    reference: result.reference,
    explanation: result.explanation,
  });
  return { result, toolContent };
}
