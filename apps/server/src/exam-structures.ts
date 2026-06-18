/**
 * exam-structures.ts — 年级段试卷结构知识库
 *
 * 基于真实的小升初、中考、高考试卷数据分析整理。
 * 每个年级段有 exam（正式考试）和 quiz（随堂测验）两种模式：
 *   - exam: 综合应用、思维创新、分步设问
 *   - quiz: 概念理解、公式运用、轻量快捷
 */

// ── 类型 ─────────────────────────────────────

export interface QuestionTypeConfig {
  type: string;
  label: string;
  count: number;
  pointsPer: number;
}

export interface DifficultyRatio {
  easy: number;   // 基础题占比 %
  medium: number; // 中等题占比 %
  hard: number;   // 较难题占比 %
}

export interface StructureVariant {
  /** 卷面满分 */
  totalScore: number;
  /** 建议时长（分钟） */
  durationMinutes: number;
  /** 题型配比 */
  questionTypes: QuestionTypeConfig[];
  /** 难度比例 */
  difficultyRatio: DifficultyRatio;
  /** 是否支持分步设问（同一材料/图示下多道小题） */
  supportsPassageGrouping: boolean;
  /** 说明 */
  description: string;
}

export interface ExamStructure {
  band: 'primary' | 'middle' | 'high';
  grades: string[];
  /** 正式考试：综合应用、分步设问、思维创新 */
  exam: StructureVariant;
  /** 随堂测验：概念理解、公式运用、轻量快捷 */
  quiz: StructureVariant;
}

// ── 知识库 ───────────────────────────────────

const PRIMARY: ExamStructure = {
  band: 'primary',
  grades: ['1', '2', '3', '4', '5', '6'],
  exam: {
    totalScore: 100, durationMinutes: 90,
    questionTypes: [
      { type: 'multiple_choice', label: '选择题', count: 8, pointsPer: 2 },
      { type: 'fill_blank',     label: '填空题', count: 8, pointsPer: 3 },
      { type: 'true_false',     label: '判断题', count: 4, pointsPer: 2 },
      { type: 'short_answer',   label: '解答题', count: 4, pointsPer: 6 },
    ],
    difficultyRatio: { easy: 40, medium: 35, hard: 25 },
    supportsPassageGrouping: false,
    description: '正式考试：基础40%中等35%拔高25%。解答题为2-3步简单应用题。',
  },
  quiz: {
    totalScore: 20, durationMinutes: 15,
    questionTypes: [
      { type: 'multiple_choice', label: '选择题', count: 4, pointsPer: 2 },
      { type: 'fill_blank',     label: '填空题', count: 3, pointsPer: 2 },
      { type: 'true_false',     label: '判断题', count: 2, pointsPer: 1 },
      { type: 'short_answer',   label: '解答题', count: 1, pointsPer: 4 },
    ],
    difficultyRatio: { easy: 60, medium: 30, hard: 10 },
    supportsPassageGrouping: false,
    description: '随堂测验：基础60%中等30%。侧重单一概念理解与公式直接运用，1步解答。',
  },
};

const MIDDLE: ExamStructure = {
  band: 'middle',
  grades: ['7', '8', '9'],
  exam: {
    totalScore: 120, durationMinutes: 120,
    questionTypes: [
      { type: 'multiple_choice', label: '选择题', count: 10, pointsPer: 3 },
      { type: 'fill_blank',     label: '填空题', count: 6, pointsPer: 3 },
      { type: 'short_answer',   label: '解答题', count: 8, pointsPer: 7 },
    ],
    difficultyRatio: { easy: 50, medium: 30, hard: 20 },
    supportsPassageGrouping: true,
    description: '正式考试：解答题8题含3-4道分步设问综合题。英语/语文阅读一篇材料配3-5题。',
  },
  quiz: {
    totalScore: 20, durationMinutes: 15,
    questionTypes: [
      { type: 'multiple_choice', label: '选择题', count: 4, pointsPer: 2 },
      { type: 'fill_blank',     label: '填空题', count: 2, pointsPer: 2 },
      { type: 'true_false',     label: '判断题', count: 2, pointsPer: 1 },
      { type: 'short_answer',   label: '简答题', count: 1, pointsPer: 6 },
    ],
    difficultyRatio: { easy: 60, medium: 30, hard: 10 },
    supportsPassageGrouping: false,
    description: '随堂测验：侧重公式运用与概念辨析，短答案为主，1-2步即可完成。',
  },
};

const HIGH: ExamStructure = {
  band: 'high',
  grades: ['high', 'college'],
  exam: {
    totalScore: 150, durationMinutes: 120,
    questionTypes: [
      { type: 'multiple_choice', label: '单选题', count: 8, pointsPer: 5 },
      { type: 'true_false',     label: '多选题', count: 3, pointsPer: 6 },
      { type: 'fill_blank',     label: '填空题', count: 3, pointsPer: 5 },
      { type: 'short_answer',   label: '解答题', count: 5, pointsPer: 15 },
    ],
    difficultyRatio: { easy: 30, medium: 40, hard: 30 },
    supportsPassageGrouping: true,
    description: '正式考试：解答题均为3小问分步设问，压轴题含跨章节综合与创新。',
  },
  quiz: {
    totalScore: 20, durationMinutes: 15,
    questionTypes: [
      { type: 'multiple_choice', label: '选择题', count: 5, pointsPer: 2 },
      { type: 'true_false',     label: '判断题', count: 2, pointsPer: 1 },
      { type: 'fill_blank',     label: '填空题', count: 2, pointsPer: 2 },
      { type: 'short_answer',   label: '简答题', count: 1, pointsPer: 6 },
    ],
    difficultyRatio: { easy: 50, medium: 35, hard: 15 },
    supportsPassageGrouping: false,
    description: '随堂测验：快速检测概念掌握情况，选择题为主，1步解答。',
  },
};

/** 所有年级段结构索引 */
const STRUCTURES: Record<string, ExamStructure> = {
  primary: PRIMARY,
  middle: MIDDLE,
  high: HIGH,
};

// ── 查询函数 ─────────────────────────────────

/** 根据年级返回对应的试卷结构 */
export function getExamStructure(grade: string): ExamStructure {
  const g = String(grade);
  if (['1','2','3','4','5','6'].includes(g)) return PRIMARY;
  if (['7','8','9'].includes(g)) return MIDDLE;
  return HIGH;
}

/** 根据年级段标识获取结构 */
export function getExamStructureByBand(band: string): ExamStructure | undefined {
  return STRUCTURES[band];
}

/** 根据总分推荐最近似的年级段结构 */
export function getStructureByTotalScore(totalScore: number): ExamStructure {
  if (totalScore <= 60) return PRIMARY;
  if (totalScore <= 120) return MIDDLE;
  return HIGH;
}

/**
 * 根据年级和模式（exam/quiz）获取有效的题型配比。
 * @param grade  年级
 * @param mode   'exam'（考试）或 'quiz'（测验）
 * @param targetScore 目标总分（如 20/50/100），自动按比例缩放题量
 */
export function getQuestionTypesForMode(
  grade: string,
  mode: 'exam' | 'quiz',
  targetScore: number,
): { questionTypes: QuestionTypeConfig[]; totalScore: number } {
  const struct = getExamStructure(grade);
  const variant = mode === 'quiz' ? struct.quiz : struct.exam;
  const ratio = targetScore / variant.totalScore;
  const qts = variant.questionTypes.map(qt => ({
    ...qt,
    count: Math.max(1, Math.round(qt.count * ratio)),
  }));
  const totalScore = qts.reduce((s, qt) => s + qt.count * qt.pointsPer, 0);
  return { questionTypes: qts, totalScore };
}
