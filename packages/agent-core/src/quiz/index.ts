import type { AnswerPayload, GradingResult, QuestionPayload } from '@boen/shared';
import {
  fillBlankSchema,
  multipleChoiceSchema,
  shortAnswerSchema,
  trueFalseSchema,
} from './schemas.js';

export {
  quizTools,
  QUIZ_TOOL_NAMES,
  makeGenerateQuestionsTool,
  multipleChoiceSchema,
  fillBlankSchema,
  trueFalseSchema,
  shortAnswerSchema,
} from './schemas.js';
export type { GenerateQuestionsResult } from './schemas.js';

// ── 简答题 LLM 评分器类型 ──────────────────────
export interface ShortAnswerGraderParams {
  stem: string;
  referenceAnswer?: string | null;
  keyPoints?: string[] | null;
  userAnswer: string;
  /** 满分（供 LLM 参考，与最终 scoring 无关） */
  maxScore: number;
}

export interface ShortAnswerGraderResult {
  correct: boolean;
  score: number;
  explanation: string;
}

/** 异步外部评分器，由调用方提供（典型实现：LLM 调用） */
export type ShortAnswerGrader = (params: ShortAnswerGraderParams) => Promise<ShortAnswerGraderResult>;

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, '');

/** Level 2 规范化：全角→半角、单位归一、数学常数展开、分数↔小数 */
const FULL_TO_HALF: Record<string, string> = {
  '０': '0', '１': '1', '２': '2', '３': '3', '４': '4',
  '５': '5', '６': '6', '７': '7', '８': '8', '９': '9',
  '．': '.', '（': '(', '）': ')', '，': ',', '；': ';',
  '：': ':', '＝': '=', '＋': '+', '－': '-', '×': '*',
  '÷': '/', '％': '%', 'π': 'π', '√': '√',
};

const UNIT_MAP: Record<string, string> = {
  '厘米': 'cm', '公分': 'cm', '毫米': 'mm',
  '分米': 'dm', '米': 'm', '千米': 'km', '公里': 'km',
  '克': 'g', '千克': 'kg', '公斤': 'kg', '吨': 't',
  '毫升': 'ml', '升': 'l', '平方厘米': 'cm2', '平方米': 'm2',
  '立方厘米': 'cm3', '立方米': 'm3', '度': '°', '摄氏度': '℃',
};

const FRACTION_DECIMAL: Record<string, string> = {
  '1/2': '0.5', '1/3': '0.333', '1/4': '0.25', '1/5': '0.2',
  '2/3': '0.667', '2/5': '0.4', '3/4': '0.75', '3/5': '0.6',
  '1/6': '0.167', '1/8': '0.125', '5/8': '0.625', '7/8': '0.875',
};

function normAdvanced(s: string): string {
  let t = s.trim();
  // 全角 → 半角
  t = t.replace(/[\uff00-\uffef]/g, (c) => FULL_TO_HALF[c] ?? c);
  // 中文单位 → 英文
  for (const [cn, en] of Object.entries(UNIT_MAP)) {
    t = t.replace(new RegExp(cn, 'g'), en);
  }
  // 数学常数展开
  t = t.replace(/π/g, '3.14159');
  t = t.replace(/√2/g, '1.41421');
  t = t.replace(/√3/g, '1.73205');
  // 分数 ↔ 小数（双向）
  for (const [frac, dec] of Object.entries(FRACTION_DECIMAL)) {
    t = t.replace(frac, dec);
  }
  // 反向：小数 → 分数
  for (const [frac, dec] of Object.entries(FRACTION_DECIMAL)) {
    if (t.includes(dec)) t = t.replace(dec, frac);
  }
  return t.toLowerCase().replace(/\s+/g, '');
}

/** 填空题匹配结果：含匹配层级信息，供 Level 3 LLM 语义判定使用 */
export interface BlankMatchResult {
  matched: boolean;
  level: 1 | 2 | 'miss';
  userNorm: string;
  acceptedNorms: string[];
}

/** 两级匹配：Level 1 精确 → Level 2 规范化（返回详细层级信息） */
export function fuzzyMatchBlankDetailed(userAnswer: string, acceptedAnswers: string[]): BlankMatchResult {
  const uNorm = norm(userAnswer);
  // Level 1: 精确匹配
  const acceptedNorm = acceptedAnswers.map((a) => norm(a));
  if (acceptedNorm.some((a) => a === uNorm)) {
    return { matched: true, level: 1, userNorm: uNorm, acceptedNorms: acceptedNorm };
  }
  // Level 2: 规范化匹配
  const uAdv = normAdvanced(userAnswer);
  const acceptedAdv = acceptedAnswers.map((a) => normAdvanced(a));
  if (acceptedAdv.some((a) => a === uAdv)) {
    return { matched: true, level: 2, userNorm: uAdv, acceptedNorms: acceptedAdv };
  }
  // Level 2 miss → 返回 miss 信息供 Level 3 LLM 语义判定
  return { matched: false, level: 'miss', userNorm: uAdv, acceptedNorms: acceptedAdv };
}

const setEq = (a: string[], b: string[]) => {
  const sa = new Set(a.map((x) => x.trim().toUpperCase()));
  const sb = new Set(b.map((x) => x.trim().toUpperCase()));
  return sa.size === sb.size && [...sa].every((x) => sb.has(x));
};

/**
 * 防御性清洗：如果 LLM 把选项写进了题干（A. xxx\nB. xxx\nC. xxx\nD. xxx），
 * 将其从 stem 中移除，合并到 options。
 */
function cleanMultipleChoiceStem(stem: string, existingOptions: { key: string; text: string }[]): { stem: string; options: { key: string; text: string }[] } {
  const source = String(stem ?? '').replace(/\r\n/g, '\n');
  const OPTION_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
  // 匹配行首或空格后的 "A." "A、" "A)" "A．" "A:" 等
  const marker = /(^|[\s\n])([A-G])\s*[.．、:：)]\s*/g;
  const matches = [...source.matchAll(marker)]
    .filter((m) => m.index !== undefined)
    .map((m) => ({ key: m[2], start: m.index! + m[1].length, contentStart: m.index! + m[0].length }));
  if (matches.length < 2) return { stem: source.trim(), options: existingOptions };

  // 检查是否匹配 A,B,C,… 顺序
  const startIdx = OPTION_LETTERS.indexOf(matches[0].key);
  const isSequence = matches.every((m, i) => m.key === OPTION_LETTERS[startIdx + i]);
  if (!isSequence) return { stem: source.trim(), options: existingOptions };

  // 提取选项文本
  const extracted = matches.map((m, i) => {
    const next = matches[i + 1];
    return { key: m.key, text: source.slice(m.contentStart, next ? next.start : source.length).trim() };
  }).filter((o) => o.text.length > 0);
  if (extracted.length < 2) return { stem: source.trim(), options: existingOptions };

  // 去重合并：已存在的选项不覆盖
  const existingKeys = new Set(existingOptions.map((o) => o.key.toUpperCase()));
  const merged = [...existingOptions];
  for (const opt of extracted) {
    if (!existingKeys.has(opt.key)) {
      merged.push(opt);
      existingKeys.add(opt.key);
    }
  }

  return { stem: source.slice(0, matches[0].start).trim(), options: merged };
}

/** 把模型给的工具参数（含答案）转成发给前端的题目（剥离答案） */
export function toQuestionPayload(toolName: string, rawArgs: unknown): QuestionPayload {
  switch (toolName) {
    case 'ask_multiple_choice': {
      const a = multipleChoiceSchema.parse(rawArgs);
      const { stem: cleanedStem, options: cleanedOptions } = cleanMultipleChoiceStem(a.stem, a.options);
      return {
        type: 'multiple_choice',
        stem: cleanedStem,
        passage: a.passage ?? undefined,
        options: cleanedOptions,
        multiSelect: a.multiSelect,
        knowledgePointId: a.knowledgePointId ?? undefined,
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
        knowledgePointId: a.knowledgePointId ?? undefined,
        difficulty: a.difficulty ?? undefined,
      };
    }
    case 'ask_true_false': {
      const a = trueFalseSchema.parse(rawArgs);
      return {
        type: 'true_false',
        stem: a.stem,
        passage: a.passage ?? undefined,
        knowledgePointId: a.knowledgePointId ?? undefined,
        difficulty: a.difficulty ?? undefined,
      };
    }
    case 'ask_short_answer': {
      const a = shortAnswerSchema.parse(rawArgs);
      return {
        type: 'short_answer',
        stem: a.stem,
        passage: a.passage ?? undefined,
        knowledgePointId: a.knowledgePointId ?? undefined,
        difficulty: a.difficulty ?? undefined,
      };
    }
    default:
      throw new Error(`未知出题工具：${toolName}`);
  }
}

/** 服务端判分。返回判分结果 + 回灌给模型的 ToolMessage 内容。 */
export async function gradeAnswer(
  toolName: string,
  rawArgs: unknown,
  answer: AnswerPayload,
  gradeShortAnswer?: ShortAnswerGrader,
): Promise<{ result: GradingResult; toolContent: string }> {
  let result: GradingResult;

  const commonResult = (base: GradingResult): GradingResult => {
    const args = rawArgs as Record<string, unknown>;
    return {
      ...base,
      // 题面、考点、素养分别由服务器的题库和知识图谱回填；不要把模型自报的
      // knowledgePoint / literacies 传给前端或画像系统。
      knowledgePoints: undefined,
      literacies: undefined,
      knowledgePointId: args.knowledgePointId ? Number(args.knowledgePointId) : undefined,
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
    const detailedResults = a.blanks.map((b, i) =>
      fuzzyMatchBlankDetailed(answer.answers[i] ?? '', b.acceptedAnswers),
    );
    const perBlank = detailedResults.map((r) => r.matched);
    const score = perBlank.filter(Boolean).length;
    const reference = a.blanks.map((b, i) => `空${i + 1}：${b.acceptedAnswers.join(' / ')}`).join('；');
    result = commonResult({
      correct: perBlank.every(Boolean),
      score,
      maxScore: a.blanks.length,
      reference,
      explanation: a.explanation,
      perBlank,
      perBlankDetails: detailedResults.map((r) => ({
        matched: r.matched,
        level: r.level,
        userNorm: r.userNorm,
        acceptedNorms: r.acceptedNorms,
      })),
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
    if (gradeShortAnswer) {
      // LLM 评分：由外部回调调用模型进行语义评判
      const graderResult = await gradeShortAnswer({
        stem: a.stem,
        referenceAnswer: a.referenceAnswer,
        keyPoints: a.keyPoints,
        userAnswer: answer.text,
        maxScore: 1,
      });
      result = commonResult({
        correct: graderResult.correct,
        score: graderResult.score,
        maxScore: 1,
        reference: ref,
        explanation: graderResult.explanation || (a.explanation ?? ''),
      });
    } else {
      // 无评分器时保持占位（一般由调用方保证传入）
      result = commonResult({ correct: null, score: 0, maxScore: 1, reference: ref, explanation: a.explanation ?? '' });
    }
  } else {
    throw new Error(`题型与答案不匹配：${toolName}`);
  }

  // 修复常见 LaTeX 反斜杠问题（LLM 在 JSON 中漏转义 \f \n \n 等）
  if (result.explanation) {
    result.explanation = result.explanation
      .replace(/(?<![\\])frac(?=[\d{])/g, '\\\\frac')
      .replace(/(?<![\\])neq/g, '\\\\neq')
      .replace(/(?<![\\])sqrt/g, '\\\\sqrt')
      .replace(/(?<![\\])text\{/g, '\\\\text{');
  }
  if (result.reference) {
    result.reference = result.reference
      .replace(/(?<![\\])frac(?=[\d{])/g, '\\\\frac')
      .replace(/(?<![\\])neq/g, '\\\\neq');
  }

  const toolContent = JSON.stringify({
    userAnswer: answer,
    correct: result.correct,
    reference: result.reference,
    explanation: result.explanation,
  });
  return { result, toolContent };
}
