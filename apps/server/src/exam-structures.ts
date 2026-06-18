/**
 * exam-structures.ts — 年级段试卷结构知识库
 *
 * 基于真实的小升初、中考、高考试卷数据分析整理。
 * 各年级段按需加载，驱动出题引擎的题型配比与分值分配。
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

export interface ExamStructure {
  /** 年级段标识 */
  band: 'primary' | 'middle' | 'high';
  /** 适用年级列表 */
  grades: string[];
  /** 卷面满分 */
  totalScore: number;
  /** 建议时长（分钟） */
  durationMinutes: number;
  /** 建议总题量 */
  totalQuestions: number;
  /** 题型配比 */
  questionTypes: QuestionTypeConfig[];
  /** 难度比例 */
  difficultyRatio: DifficultyRatio;
  /** 是否常见「一篇材料多道题」模式 */
  supportsPassageGrouping: boolean;
  /** 说明 */
  description: string;
}

// ── 知识库 ───────────────────────────────────

const PRIMARY: ExamStructure = {
  band: 'primary',
  grades: ['1', '2', '3', '4', '5', '6'],
  totalScore: 100,
  durationMinutes: 90,
  totalQuestions: 24,
  questionTypes: [
    { type: 'multiple_choice', label: '选择题', count: 8, pointsPer: 2 },
    { type: 'fill_blank',    label: '填空题', count: 8, pointsPer: 3 },
    { type: 'true_false',    label: '判断题', count: 4, pointsPer: 2 },
    { type: 'short_answer',  label: '解答题', count: 4, pointsPer: 6 },
  ],
  difficultyRatio: { easy: 40, medium: 35, hard: 25 },
  supportsPassageGrouping: false,
  description: '小学阶段（小升初）：基础题占 40%，侧重数与代数、几何初步、应用题。解答题以简单应用为主。',
};

const MIDDLE: ExamStructure = {
  band: 'middle',
  grades: ['7', '8', '9'],
  totalScore: 120,
  durationMinutes: 120,
  totalQuestions: 24,
  questionTypes: [
    { type: 'multiple_choice', label: '选择题', count: 10, pointsPer: 3 },
    { type: 'fill_blank',    label: '填空题', count: 6, pointsPer: 3 },
    { type: 'short_answer',  label: '解答题', count: 8, pointsPer: 7 },
  ],
  difficultyRatio: { easy: 50, medium: 30, hard: 20 },
  supportsPassageGrouping: true,
  description: '初中阶段（中考）：选择题 10 题×3 分，填空题 6 题×3 分，解答题 8 题×7 分。解答题含 3-4 道分步设问的综合题，大题与小题比例 7:3 左右。英语/语文阅读一篇材料配 3-5 题。',
};

const HIGH: ExamStructure = {
  band: 'high',
  grades: ['high', 'college'],
  totalScore: 150,
  durationMinutes: 120,
  totalQuestions: 19,
  questionTypes: [
    { type: 'multiple_choice', label: '单选题', count: 8, pointsPer: 5 },
    { type: 'true_false',    label: '多选题', count: 3, pointsPer: 6 },
    { type: 'fill_blank',    label: '填空题', count: 3, pointsPer: 5 },
    { type: 'short_answer',  label: '解答题', count: 5, pointsPer: 15 },
  ],
  difficultyRatio: { easy: 30, medium: 40, hard: 30 },
  supportsPassageGrouping: true,
  description: '高中阶段（高考）：8 单选×5 分 + 3 多选×6 分 + 3 填空×5 分 + 5 解答×~15 分。解答题均为 3 小问分步设问，压轴题含新定义/跨章节综合。阅读一篇材料配 3-5 题。',
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
  // 小学 1-6
  if (['1','2','3','4','5','6'].includes(g)) return PRIMARY;
  // 初中 7-9
  if (['7','8','9'].includes(g)) return MIDDLE;
  // 高中及以上
  return HIGH;
}

/** 根据年级段标识获取结构 */
export function getExamStructureByBand(band: string): ExamStructure | undefined {
  return STRUCTURES[band];
}

/** 根据总分数推荐最接近的年级段结构 */
export function getStructureByTotalScore(totalScore: number): ExamStructure {
  if (totalScore <= 60) return PRIMARY;
  if (totalScore <= 120) return MIDDLE;
  return HIGH;
}
