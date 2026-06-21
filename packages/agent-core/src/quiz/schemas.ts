import { z } from 'zod';
import { tool } from '@langchain/core/tools';

const diffMap: Record<string, string> = { '简单': 'easy', '中等': 'medium', '困难': 'hard', '容易': 'easy', '较难': 'hard' };
const difficulty = z.preprocess(
  (v) => typeof v === 'string' ? (diffMap[v] ?? v) : v,
  z.enum(['easy', 'medium', 'hard']).nullish(),
).describe('题目难度');
// 知识点与核心素养的展示值由服务端按 ID 从数据库读取。保留旧字段只是为了
// 兼容历史工具调用；它们不应被任何调用方信任或直接展示。
const knowledgePoint = z.string().nullish().describe('兼容字段：服务端不会使用或展示该文本，请勿填写');
const knowledgePointId = z.number().int().positive().nullish().describe('发布课程知识库中的知识点 ID；服务端按此 ID 解析考点和核心素养');
const literacies = z.array(z.string()).nullish().describe('兼容字段：服务端会忽略，核心素养由知识图谱解析');
const richTextDescription = 'Markdown text; math questions may include KaTeX formulas and fenced ```tikz ...``` diagrams.';
const explanation = z.string().describe(
  '答案解析。请用以下结构（Markdown 格式）：\n' +
  '### 📖 解析\n' +
  '本题的完整解析过程，必要时用 $$ LaTeX $$ 排版公式。\n' +
  '### 💡 涉及的学科知识与核心素养\n' +
  '- 知识点：...\n' +
  '- 核心素养：...\n' +
  '- 难度层级：...\n' +
  '### 📝 易错点提醒\n' +
  '学生常见错误与注意事项。'
);

export const passageField = z.string().nullish().describe('阅读材料（语文/英语阅读理解题专用），在此提供文章或对话原文，前端会以特殊字体块渲染');
const groupId = z.number().int().nullish().describe('同一材料或分步设问的小题分组 ID');

export const multipleChoiceSchema = z.object({
  stem: z.string().describe(`题干（只写问题文字，不含选项）。${richTextDescription}`),
  passage: passageField,
  groupId,
  options: z
    .array(z.object({ key: z.string().describe('选项编号，如 A'), text: z.string().describe(`选项文本。${richTextDescription}`) }))
    .min(2)
    .describe('选项列表'),
  correctKeys: z.array(z.string()).min(1).default(['A']).describe('正确选项的 key；多选时填多个'),
  multiSelect: z.boolean().default(false).describe('是否为多选题'),
  knowledgePoint,
  knowledgePointId,
  literacies,
  difficulty,
  explanation: z.string().default('详见解析。').describe(`答案解析。${richTextDescription}`),
});

export const fillBlankSchema = z.object({
  stem: z.string().describe(`题干，每个空用连续四个下划线 ____ 表示。${richTextDescription}`),
  passage: passageField,
  groupId,
  blanks: z
    .array(z.object({ acceptedAnswers: z.array(z.string()).min(1).describe('该空的可接受答案') }))
    .min(1)
    .describe('按题干中空的先后顺序排列'),
  knowledgePoint,
  knowledgePointId,
  literacies,
  difficulty,
  explanation: z.string().default('详见解析。').describe(`答案解析。${richTextDescription}`),
});

export const trueFalseSchema = z.object({
  stem: z.string().describe(`判断题陈述。${richTextDescription}`),
  passage: passageField,
  groupId,
  answer: z.boolean().describe('该陈述是否正确'),
  knowledgePoint,
  knowledgePointId,
  literacies,
  difficulty,
  explanation: z.string().default('详见解析。').describe(`答案解析。${richTextDescription}`),
});

export const shortAnswerSchema = z.object({
  stem: z.string().describe(`简答题题干。${richTextDescription}`),
  passage: passageField,
  groupId,
  referenceAnswer: z.string().nullish().describe(`参考答案。${richTextDescription}`),
  keyPoints: z.array(z.string()).nullish().describe('评分要点'),
  knowledgePoint,
  knowledgePointId,
  literacies,
  difficulty,
  explanation: z.string().nullish().describe(`解析与作答点评。${richTextDescription}`),
});

/** 四个出题工具（仅作结构化输出契约用于绑定；执行由服务端「人类作答」完成，故 func 为空） */
export const quizTools = [
  tool(async () => '', {
    name: 'ask_multiple_choice',
    description: '出一道选择题（单选或多选）让学生作答。不要把题目写进普通文字回复，必须用本工具。注意：stem 只写题干（问题本身），选项只能放在 options 数组中，严禁把选项写进 stem。',
    schema: multipleChoiceSchema,
  }),
  tool(async () => '', {
    name: 'ask_fill_blank',
    description: '出一道填空题让学生作答。题干用 ____ 标记每个空。',
    schema: fillBlankSchema,
  }),
  tool(async () => '', {
    name: 'ask_true_false',
    description: '出一道判断题让学生作答。',
    schema: trueFalseSchema,
  }),
  tool(async () => '', {
    name: 'ask_short_answer',
    description: '出一道简答题让学生作答。',
    schema: shortAnswerSchema,
  }),
];

export const QUIZ_TOOL_NAMES = new Set(quizTools.map((t) => t.name));

export type MultipleChoiceArgs = z.infer<typeof multipleChoiceSchema>;
export type FillBlankArgs = z.infer<typeof fillBlankSchema>;
export type TrueFalseArgs = z.infer<typeof trueFalseSchema>;
export type ShortAnswerArgs = z.infer<typeof shortAnswerSchema>;

// ── 考试批量出题工具（按题型选 schema，一次输出多道题） ──────────

/** 按题型获取对应的 batch question schema */
function batchQuestionSchema(questionType: string): z.ZodArray<z.ZodTypeAny, 'many'> {
  let itemSchema: z.ZodTypeAny;
  switch (questionType) {
    case 'multiple_choice':
      itemSchema = multipleChoiceSchema;
      break;
    case 'fill_blank':
      itemSchema = fillBlankSchema;
      break;
    case 'true_false':
      itemSchema = trueFalseSchema;
      break;
    case 'short_answer':
      itemSchema = shortAnswerSchema;
      break;
    default:
      throw new Error(`不支持的题型: ${questionType}`);
  }
  return z.array(itemSchema).min(1).max(15);
}

/**
 * 构造一个 batch 出题 tool（按题型动态 schema）。
 * 考试出题阶段用 model.bindTools + tool_choice 强制结构化输出，
 * 消除 regex 提取 + 手动 fallback 的脆弱链路。
 */
export function makeGenerateQuestionsTool(questionType: string, count: number) {
  const itemSchema = batchQuestionSchema(questionType);
  return tool(async () => '', {
    name: 'generate_questions',
    description: `按蓝图生成 ${count} 道 ${questionType} 题目。必须通过本工具输出，不要把题目写进普通文字回复。`,
    schema: z.object({
      questions: itemSchema,
    }),
  });
}

/** batch 出题工具的输出类型 */
export type GenerateQuestionsResult = {
  questions: MultipleChoiceArgs[] | FillBlankArgs[] | TrueFalseArgs[] | ShortAnswerArgs[];
};
