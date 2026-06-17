import { z } from 'zod';
import { tool } from '@langchain/core/tools';

const difficulty = z.enum(['easy', 'medium', 'hard']).nullish().describe('题目难度');
const knowledgePoint = z.string().nullish().describe('对应考点');
const explanation = z.string().describe('答案解析，作答后展示给学生');

export const passageField = z.string().nullish().describe('阅读材料（语文/英语阅读理解题专用），在此提供文章或对话原文，前端会以特殊字体块渲染');

export const multipleChoiceSchema = z.object({
  stem: z.string().describe('题干'),
  passage: passageField,
  options: z
    .array(z.object({ key: z.string().describe('选项编号，如 A'), text: z.string() }))
    .min(2)
    .describe('选项列表'),
  correctKeys: z.array(z.string()).min(1).describe('正确选项的 key；多选时填多个'),
  multiSelect: z.boolean().describe('是否为多选题'),
  knowledgePoint,
  difficulty,
  explanation,
});

export const fillBlankSchema = z.object({
  stem: z.string().describe('题干，每个空用连续四个下划线 ____ 表示'),
  passage: passageField,
  blanks: z
    .array(z.object({ acceptedAnswers: z.array(z.string()).min(1).describe('该空的可接受答案') }))
    .min(1)
    .describe('按题干中空的先后顺序排列'),
  knowledgePoint,
  difficulty,
  explanation,
});

export const trueFalseSchema = z.object({
  stem: z.string().describe('判断题陈述'),
  passage: passageField,
  answer: z.boolean().describe('该陈述是否正确'),
  knowledgePoint,
  difficulty,
  explanation,
});

export const shortAnswerSchema = z.object({
  stem: z.string().describe('简答题题干'),
  passage: passageField,
  referenceAnswer: z.string().describe('参考答案'),
  keyPoints: z.array(z.string()).nullish().describe('评分要点'),
  knowledgePoint,
  difficulty,
  explanation,
});

/** 四个出题工具（仅作结构化输出契约用于绑定；执行由服务端「人类作答」完成，故 func 为空） */
export const quizTools = [
  tool(async () => '', {
    name: 'ask_multiple_choice',
    description: '出一道选择题（单选或多选）让学生作答。不要把题目写进普通文字回复，必须用本工具。',
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
