/**
 * exam-prompts.ts — 考试出题全链路 prompt 集中管理
 *
 * 四阶段流水线的所有 prompt：
 *   1. 蓝图架构师（blueprintArchitectPrompt）
 *   2. 题目编写组（questionWriterPrompt）
 *   3. 审核委员会 5 维度（reviewCorrectness/Similarity/BlueprintMatch/Format/Discrimination）
 *   4. 重出闭环（regenerateQuestionPrompt）
 */

import type { ExamBlueprint, ExamQuestion } from '@boen/shared';

/** 最小 config 类型（PromptConfig 定义在 exam.ts，此处用内联类型避免循环依赖） */
interface PromptConfig {
  subject: string;
  grade: string;
  totalScore?: number;
  notes?: string;
  styleContext?: string;
}

// ── 通用辅助 ─────────────────────────────

const SUBJECT_LABELS: Record<string, string> = { chinese: '语文', math: '数学', english: '英语', science: '科学' };

export function subjectLabel(subject: string): string {
  return SUBJECT_LABELS[subject] ?? subject;
}

export function gradeLabel(grade: string): string {
  const n = Number(grade);
  return n <= 6 ? `小学${'一二三四五六'[n - 1]}年级` : `初${'一二三'[n - 7]}`;
}

/** 通用排版规范（出题/重出共用） */
export const KATEX_FORMAT_GUIDE = [
  '【⚠ 强制格式要求】违反以下任意一条将导致公式无法渲染，直接影响学生体验，严禁违反：',
  '1. 公式/方程一律用 KaTeX。行内用 $...$，行间用 $$...$$ 独占一行。',
  '2. $$ 绝对必须成对出现：有开头就必须有结尾，绝不能只有结尾没有开头，也不能只有开头没有结尾。',
  '3. 定理、定义、重要公式、推导步骤必须用 $$...$$ 行间公式，不得使用 $...$ 行内公式。',
  '4. 涉及几何、函数图像、坐标等可视化内容时，必须在 stem 或 explanation 里用 TikZ 代码块（```tikz）画示意图，严禁用字符拼图代替。',
].join('\n');

/** 小学低年级竖式提示（仅二~四年级） */
export function xlopGuide(grade: string): string {
  return (grade === '2' || grade === '3' || grade === '4')
    ? '\n列竖式计算用 \\opadd / \\opsub / \\opmul / \\opdiv 直接写在题干文本中（如 \\opadd{698}{213}），前端自动渲染为竖式。'
    : '';
}

// ── 阶段一：蓝图架构师 prompt ─────────────

export function blueprintArchitectPrompt(
  config: PromptConfig,
  weightGuide: string,
  profileContext: string,
  constraintBoundary: string,
): string {
  const totalScore = config.totalScore ?? 100;
  return [
    `你是一位经验丰富的考试命题专家。请为${subjectLabel(config.subject)}（${gradeLabel(config.grade)}）设计一份结构化的试卷蓝图。`,
    '',
    '=== 设计约束边界（必须遵守）===',
    constraintBoundary,
    '',
    `总分：${totalScore} 分。`,
    config.notes ? `用户特殊要求：${config.notes}` : '',
    '',
    '=== 知识点权重分布（用于决定题目分布）===',
    weightGuide,
    '',
    profileContext ? `=== 学生学情 ===\n${profileContext}` : '',
    '',
    '=== 你需要设计的内容 ===',
    '1. 试卷标题',
    '2. 试卷板块（sections）：按知识点大类划分 2-4 个板块（如"数与代数""图形与几何""统计与概率"），每个板块包含：',
    '   - 板块标题',
    '   - 涉及的知识点列表（含 ID 和权重；如果上下文给出了知识点 ID，必须原样填入 id）',
    '   - 该板块的难度倾向',
    '   - 该板块下的题型配比（题型/数量/每题分值/重点知识点）',
    '3. 知识点覆盖计划（coveragePlan）：必考 / 重点 / 拓展',
    '4. 难度分布（difficultyDistribution）：easy/medium/hard 的占比（三者之和 = 1）',
    '',
    '⚠ 重要：各题型 pointsPer × count 之和必须等于总分。选择题不超过 10 道。',
    '⚠ 题型顺序是硬约束：卷面必须先选择题 multiple_choice，再判断题 true_false，再填空题 fill_blank，最后简答/解答题 short_answer；sections[].questionTypes 也按这个顺序输出。',
    '⚠ 各板块的知识点不要重复——同一知识点只应出现在一个板块中。',
    '💡 语文/英语等文科科目必须出综合大题：同一篇阅读材料必须出 2-4 道小题（单选/填空/简答混合），所有小题设相同 groupId（数字），阅读材料只放在第一题的 passage 字段，后续同组小题不要再重复放 passage。这是强制要求，不遵守将导致材料重复显示，整卷作废。',
    KATEX_FORMAT_GUIDE,
    '',
    '=== 你必须严格按以下 JSON 结构输出（字段名不能改，缺一不可） ===',
    `{
  "title": "试卷标题",
  "totalScore": ${totalScore},
  "sections": [
    {
      "title": "板块标题",
      "knowledgePoints": [
        {"id": 123, "title": "知识点名", "weight": 0.5}
      ],
      "difficulty": "easy|medium|hard",
      "questionTypes": [
        {
          "type": "multiple_choice|fill_blank|true_false|short_answer",
          "count": 6,
          "pointsPer": 3,
          "focusKps": ["重点知识点"]
        }
      ]
    }
  ],
  "coveragePlan": {
    "must": ["必考知识点"],
    "focus": ["重点考查"],
    "stretch": ["拓展"]
  },
  "difficultyDistribution": {
    "easy": 0.4,
    "medium": 0.4,
    "hard": 0.2
  }
}`,
  ].filter(Boolean).join('\n');
}

// ── 阶段二：题目编写组 prompt ─────────────

export interface QuestionWriterContext {
  config: PromptConfig;
  sectionTitle: string;
  sectionKnowledgePoints: Array<{ id?: number; title: string; weight: number }>;
  questionType: string;
  questionTypeLabel: string;
  count: number;
  pointsPer: number;
  focusKps: string[];
  difficulty: string;
  blueprintTitle: string;
  /** 其他组正在出的知识点与情景（跨组差异化约束） */
  crossGroupContext: string;
  /** 已出的题目（用于避免知识点重复） */
  existingQuestions: ExamQuestion[];
  /** 错题风格学习上下文 */
  styleContext?: string;
  /** 重试时的格式提醒 */
  formatRetryHint?: string;
}

export function questionWriterPrompt(ctx: QuestionWriterContext): string {
  const { config, sectionTitle, sectionKnowledgePoints, questionType, questionTypeLabel, count, pointsPer, focusKps, difficulty, blueprintTitle, crossGroupContext, existingQuestions, styleContext, formatRetryHint } = ctx;

  return [
    `你是命题专家。请为${subjectLabel(config.subject)}（${gradeLabel(config.grade)}）编写 ${count} 道${questionTypeLabel}。`,
    `所属板块：${sectionTitle}`,
    `每题 ${pointsPer} 分。难度要求：${difficulty}。`,
    '',
    '=== 本板块知识点 ===',
    sectionKnowledgePoints.map(kp => `  - ${kp.id ? `#${kp.id} ` : ''}${kp.title}（权重 ${Math.round(kp.weight * 100)}%）`).join('\n'),
    focusKps.length ? `\n重点考查：${focusKps.join('、')}` : '',
    '',
    '=== 试卷信息 ===',
    `试卷标题：${blueprintTitle}`,
    config.notes ? `用户特殊要求：${config.notes}` : '',
    '',
    '=== 跨组差异化约束（必须遵守）===',
    crossGroupContext || '（本组是唯一出题组）',
    '⚠ 各题的题干情景、数据、设问必须与上述其他组的内容完全不同。',
    '⚠ 同一应用题情景（如"小明买苹果""火车过桥"）不能在不同题目中出现。',
    '',
    existingQuestions.length ? `已出的题目知识点：${[...new Set(existingQuestions.map(q => q.knowledgePoint))].join('、')}。请避免知识点重复。` : '',
    '',
    '⚠ 重要：各题之间的题干情景、数据、设问必须差异化。同一组数字或同一道应用题情景不能在不同题目中原样出现。',
    styleContext ? `\n=== 错题风格学习 ===\n${styleContext}\n请只学习这些错题样本的题型结构、逻辑搭建、情境选取和干扰方式，严禁照抄原题文字、数字、学生答案或隐私信息。` : '',
    '',
    '=== ⚠ 内容安全约束（必须遵守）===',
    '题干和选项中严禁出现以下内容：',
    '1. 政治人物姓名、政治事件、政治立场或宗教教义',
    '2. 暴力场景、血腥描写或恐怖情节',
    '3. 真实商业品牌名称（可用"某品牌""某公司"替代）',
    '4. 歧视性内容（种族、性别、地域、身体等）',
    '5. 数学/科学题目中的数值应在合理范围内（不出现极端数据如"一辆车时速3000公里"）',
    '6. 题干情景应贴近学生日常生活经验，避免涉及赌博、借贷、烟酒等不适场景',
    '',
    '=== ⚠ 输出要求（硬性规定，不得违反） ===',
    `输出 ${count} 道题。严格按以下 JSON 结构输出，字段名不能改：`,
    `{"questions":[{"stem":"题干","passage":"（有阅读材料时填写，无则省略此字段）","type":"${questionType}","points":${pointsPer},"knowledgePointId":123,"difficulty":"${difficulty}","explanation":"解析"${questionType === 'multiple_choice' ? ',"options":[{"key":"A","text":"选项1"},{"key":"B","text":"选项2"},{"key":"C","text":"选项3"},{"key":"D","text":"选项4"}],"correctKeys":["A"],"multiSelect":false' : ''}${questionType === 'fill_blank' ? ',"blanks":[{"acceptedAnswers":["标准答案1"]},{"acceptedAnswers":["标准答案2"]}]' : ''}${questionType === 'true_false' ? ',"answer":true' : ''}${questionType === 'short_answer' ? ',"referenceAnswer":"参考答案","keyPoints":["要点1","要点2"]' : ''}${['multiple_choice', 'fill_blank', 'true_false', 'short_answer'].includes(questionType) ? ',"groupId":1' : ''}]}`,
    questionType === 'multiple_choice'
      ? '选择题硬性要求：stem 只写题干，绝对不要把 A/B/C/D 选项写进 stem；options 必须写真实选项文本，严禁写 "{选项A}"、"选项A"、"A" 等任何占位符。违者整卷作废。'
      : '',
    questionType === 'fill_blank'
      ? '填空题硬性要求：stem 中每个空必须用 ____ 或（ ）标出；blanks 必须按空的顺序给出 acceptedAnswers，空数必须与题干空位一致。空位与答案数不匹配则整题无效。'
      : '',
    '只填写本板块知识点列表中的 knowledgePointId；不得填写 knowledgePoint 或 literacies。服务端将从数据库解析并展示考点与核心素养。',
    `难度统一为 ${difficulty}。同一篇阅读材料的多道小题必须设相同 groupId。`,
    '【⚠ 阅读材料强制令】阅读理解/完形填空等有原文的题型，原文必须且只能写在 passage 字段中，严禁将原文写进 stem 字段，严禁在 stem 中使用 ** passage ** 等标记来代替 passage 字段。stem 字段只写提问/题干本身。违反此规则将导致学生看不到阅读材料，整题作废。\
	\n   passage 开头可用 `# 标题` 标注文章标题（如有），前端会以标题样式渲染。',
    KATEX_FORMAT_GUIDE,
    xlopGuide(config.grade),
    formatRetryHint ? `\n⚠ 上次输出格式有误：${formatRetryHint}。请严格按照工具 schema 输出，不要输出任何文本。` : '',
  ].filter(Boolean).join('\n');
}

// ── 阶段三：审核委员会 5 维度 prompt ──────

/** 提取文本中的 TikZ 代码块 */
function extractTikzBlocks(text: string): string[] {
  const blocks: string[] = [];
  const re = /```tikz\s*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    blocks.push(m[1].trim());
  }
  return blocks;
}

/** 构造每道题的详细快照供审核 */
export function formatQuestionSnapshot(questions: ExamQuestion[]): string {
  return questions.map((q) => {
    const lines: string[] = [];
    lines.push(`Q${q.index + 1} | ${q.type} | ${q.points}分 | 难度:${q.difficulty} | 考点:${q.knowledgePoint}`);
    lines.push(`  题干: ${q.stem?.slice(0, 300)}`);
    if (q.passage) lines.push(`  材料: ${q.passage.slice(0, 200)}`);
    if (q.type === 'multiple_choice' && q.options) {
      for (const o of q.options) {
        const correct = q.correctKeys?.includes(o.key) ? ' ✓' : '';
        lines.push(`  ${o.key}. ${o.text}${correct}`);
      }
    }
    if (q.type === 'fill_blank' && q.blanks) {
      lines.push(`  答案: ${q.blanks.map((b, i) => `空${i+1}=[${b.acceptedAnswers.join('/')}]`).join('；')}`);
    }
    if (q.type === 'true_false') lines.push(`  答案: ${q.answer ? '正确' : '错误'}`);
    if (q.type === 'short_answer') {
      lines.push(`  参考答案: ${q.referenceAnswer ?? '（无）'}`);
      lines.push(`  要点: ${(q.keyPoints ?? []).join('、') || '（无）'}`);
    }
    if (q.explanation) lines.push(`  解析: ${q.explanation.slice(0, 150)}`);
    // 提取 TikZ 代码供审核
    const tikzBlocks = [
      ...extractTikzBlocks(q.stem ?? ''),
      ...extractTikzBlocks(q.passage ?? ''),
      ...extractTikzBlocks(q.explanation ?? ''),
    ];
    for (const code of tikzBlocks.slice(0, 3)) {
      lines.push(`  TikZ: ${code.slice(0, 200)}`);
    }
    // 提取 \\op 竖式命令供审核
    const opRe = /\\op(?:add|sub|mul|div)\s*(?:\[.*?\])?\s*\{[^}]+\}\s*\{[^}]+\}/g;
    const opCmds = [
      ...(q.stem ?? '').matchAll(opRe),
      ...(q.passage ?? '').matchAll(opRe),
      ...(q.explanation ?? '').matchAll(opRe),
    ].map(m => m[0]).slice(0, 5);
    for (const cmd of opCmds) {
      lines.push(`  \\op: ${cmd}`);
    }
    return lines.join('\n');
  }).join('\n\n');
}

/** A. 正确性审核 */
export function reviewCorrectnessPrompt(questions: ExamQuestion[], config: PromptConfig): string {
  const isMathOrScience = config.subject === 'math' || config.subject === 'science';
  return [
    `你是${subjectLabel(config.subject)}学科专家。请审核以下试卷中每道题的答案和解析是否知识性正确。`,
    `年级：${gradeLabel(config.grade)}。`,
    '',
    '=== 校准说明 ===',
    '这是由 AI 命题系统生成的试卷，答案和解析整体正确性较高。',
    '请只标记有实质性知识错误的题目（如公式写错、计算错误、概念混淆等）。',
    '表达方式不够精确、缺少细节等非知识性问题不应扣分。',
    ...(isMathOrScience ? [
      '',
      '=== TikZ 示意图审核 ===',
      '数学/科学题目常附带 ```tikz 代码块用于绘制示意图（几何图形、函数图像、实验装置等）。',
      '请逐题检查 TikZ 代码绘制的图形是否符合题意（如标注的数值、角度、变量名是否正确）。',
      '若 TikZ 代码与题目描述严重不符（标注错误、图形画错等），在 issues 中指出并要求重写 TikZ 代码。',
      '',
      '=== \\op 竖式计算审核 ===',
      `当前年级：${gradeLabel(config.grade)}。竖式（\\opadd/\\opsub/\\opmul/\\opdiv）仅适用于二~四年级。`,
      ...(!(config.grade === '2' || config.grade === '3' || config.grade === '4') ? [
        '⚠ 当前不是二~四年级，题目中不应出现 \\op 竖式命令。若发现含 \\op 命令的题，正确性维度打低分并指出。',
      ] : [
        '题目中可能包含 \\opadd、\\opsub、\\opmul、\\opdiv 等竖式计算命令。',
        '请检查竖式计算的结果是否正确（加/减/乘/除的得数）。',
        '若计算结果错误，在 issues 中指出并要求修正。',
      ]),
    ] : []),
    '',
    '=== 试卷详情 ===',
    formatQuestionSnapshot(questions),
    '',
    '=== 审核要求 ===',
    '逐题检查：',
    '1. 选择题的 correctKeys 是否真的是正确答案',
    '2. 填空题的 acceptedAnswers 是否完整且正确',
    '3. 判断题的 answer 是否正确',
    '4. 简答题的 referenceAnswer 和 keyPoints 是否准确',
    '5. explanation 中是否有知识性错误、计算错误或逻辑矛盾',
    '',
    '=== 输出格式（必须严格按此 JSON 结构，字段名不能改） ===',
    '{"scores":[{"index":0,"score":100,"issues":[],"similarTo":[]}]}',
    '其中 score=100 完全正确, 80=表述可优化但无实质错误, <40=有实质性错误。',
  ].join('\n');
}

/** B. 相似性审核 */
export function reviewSimilarityPrompt(questions: ExamQuestion[]): string {
  return [
    '你是试卷质量审核专家。请检查以下试卷中各题之间是否存在雷同或过度相似的问题。',
    '',
    '=== 校准说明 ===',
    '注意：同一份试卷的题目围绕同一学科和主题是正常的，这不等于雷同。',
    '请重点检查是否在情景、数据、设问角度上实质性雷同，而不是知识点或学科主题相同。',
    '只要题干情景不同、数据不同、设问角度不同，即使知识点相同也应给高分。',
    '',
    '=== 试卷详情 ===',
    formatQuestionSnapshot(questions),
    '',
    '=== 审核要求 ===',
    '重点检查：',
    '1. 题干情景雷同：如多题都用"小明买水果""火车过桥"等相似场景',
    '2. 数据雷同：多题使用相同或接近的数字组合',
    '3. 设问方式雷同：多题的提问角度/结构几乎相同',
    '4. 选项文本与填空/简答题干接近',
    '5. 同一知识点的考查角度是否足够差异化',
    '',
    '注意：不同题型的题目可以用同一知识点，但情景、数据和设问必须差异化。',
    '',
    '=== 输出格式（必须严格按此 JSON 结构，字段名不能改） ===',
    '{"scores":[{"index":0,"score":100,"issues":[],"similarTo":[1]}]}',
    '其中 score=100 完全不同, 80=主题相同但情景/数据/设问不同（正常）, <40=严重雷同, similarTo 列出雷同题号。',
  ].join('\n');
}

/** C. 蓝图匹配审核 */
export function reviewBlueprintMatchPrompt(questions: ExamQuestion[], blueprint: ExamBlueprint): string {
  const blueprintSummary = blueprint.sections.map(s =>
    `  ${s.title}（难度${s.difficulty}）：${s.knowledgePoints.map(kp => kp.title).join('、')}`
  ).join('\n');
  const coveragePlan = `必考：${blueprint.coveragePlan.must.join('、')}；重点：${blueprint.coveragePlan.focus.join('、')}`;
  const diffDist = `easy ${Math.round(blueprint.difficultyDistribution.easy * 100)}% / medium ${Math.round(blueprint.difficultyDistribution.medium * 100)}% / hard ${Math.round(blueprint.difficultyDistribution.hard * 100)}%`;

  const actualSum = questions.reduce((s, q) => s + q.points, 0);

  return [
    '你是试卷审核专家。请检查试卷是否匹配设计蓝图的要求。',
    '',
    '=== 蓝图要求 ===',
    `试卷标题：${blueprint.title}`,
    `目标总分：${blueprint.totalScore} 分（各题分值之和必须精确等于此值）`,
    `当前各题分值合计：${actualSum} 分${actualSum !== blueprint.totalScore ? ' ⚠ 偏差！' : ' ✓'}`,
    `板块划分：`,
    blueprintSummary,
    `知识点覆盖：${coveragePlan}`,
    `难度分布：${diffDist}`,
    '',
    '=== 试卷详情 ===',
    formatQuestionSnapshot(questions),
    '',
    '=== 审核要求 ===',
    '逐题检查：',
    '1. 题目是否考查了蓝图指定的知识点',
    '2. 题目难度是否匹配蓝图要求',
    '3. 是否遗漏了必考知识点',
    '4. 是否有超出蓝图范围的题目',
    `5. 各题 points 之和是否等于目标总分 ${blueprint.totalScore}（当前合计 ${actualSum}，${actualSum === blueprint.totalScore ? '匹配' : '不匹配，需在 issues 中指出'})`,
    '',
    '=== 输出格式（必须严格按此 JSON 结构，字段名不能改） ===',
    '{"scores":[{"index":0,"score":100,"issues":[]}],"overallMatchScore":85}',
    '其中 score=100 完全匹配, <60=偏离蓝图；overallMatchScore 为全卷匹配度。',
    '若总分不匹配，overallMatchScore 应低于 70。',
  ].join('\n');
}

/** D. 格式审核 */
export function reviewFormatPrompt(questions: ExamQuestion[], config: PromptConfig): string {
  const isMathOrScience = config.subject === 'math' || config.subject === 'science';
  const isLowerElementary = config.grade === '2' || config.grade === '3' || config.grade === '4';
  return [
    '你是格式审核专家。请检查试卷中每道题的格式是否完整、正确。',
    ...(isMathOrScience ? [
      '',
      '=== TikZ 代码质量审核 ===',
      '数学/科学题目中 ```tikz 代码块的示意图必须符合题目意图：',
      '1. 图形元素（线段、角度、标注等）与题干描述一致',
      '2. 数值标注（如边长、角度值）与实际计算相符',
      '3. 代码语法正确（\\draw, \\node, \\path 等命令使用正确）',
      '4. TikZ 代码不符合题意或语法错误 → 在 issues 中写明需重写',
      '',
      '=== \\op 竖式渲染审核 ===',
      `当前年级：${gradeLabel(config.grade)}。竖式（\\opadd/\\opsub/\\opmul/\\opdiv）仅适用于二~四年级。`,
      ...(!isLowerElementary ? [
        '⚠ 当前不是二~四年级，题目中不应出现 \\op 竖式命令。若发现含 \\op 命令的题，格式维度打低分并在 issues 中指出。',
      ] : [
        '1. 检查 \\op 命令的参数是否完整（两个花括号参数）',
        '2. 检查竖式排版是否合理（数字对齐、进位/借位显示）',
        '3. \\opdiv 除法竖式应呈现为长除格式，而不是简单的 "÷" 表达式',
        '4. 若竖式格式不正确 → 在 issues 中指出需修正渲染方式',
      ]),
    ] : []),
    '',
    '=== 试卷详情 ===',
    formatQuestionSnapshot(questions),
    '',
    '=== 审核要求 ===',
    '逐题检查：',
    '1. KaTeX 语法：$...$ 和 $$...$$ 是否成对闭合',
    '2. TikZ 代码块：```tikz ... ``` 是否正确闭合',
    '3. 选择题选项是否完整（至少 2 个，通常 4 个）',
    '4. 填空题的 ____ 标记数量是否与 blanks 数量一致',
    '5. 题干是否有实质性内容（非占位符或兜底文本）',
    '6. explanation 是否有实质内容',
    '7. \\opadd 等 op 命令语法是否正确',
    '',
    '=== 输出格式（必须严格按此 JSON 结构，字段名不能改） ===',
    '{"scores":[{"index":0,"score":100,"issues":[]}]}',
    '其中 score=100 格式完美, <60=严重错误。',
  ].join('\n');
}

/** E. 区分度审核 */
export function reviewDiscriminationPrompt(questions: ExamQuestion[], config: PromptConfig): string {
  const isChineseOrEnglish = config.subject === 'chinese' || config.subject === 'english';
  // 计算整卷 passage 总字数
  const totalPassageChars = isChineseOrEnglish
    ? questions.reduce((sum, q) => sum + (q.passage?.length ?? 0) + (q.stem?.length ?? 0), 0)
    : 0;
  return [
    `你是教育测量学专家。请审核以下${subjectLabel(config.subject)}（${gradeLabel(config.grade)}）试卷的区分度。`,
    '',
    '=== 校准说明 ===',
    '注意：期末考试题考查的是本学期所学内容，题目必然围绕学科范围内出题。',
    '不要因为题目专业性强或知识点集中就判低分。请侧重检查：干扰项是否明显不合理、',
    '设问是否有效、是否真的没有区分度。正常难度的期末题应给 70-85 分。',
    ...(isChineseOrEnglish ? [
      '',
      `=== 阅读量审核 ===`,
      `当前整卷题干+材料总字数约 ${totalPassageChars} 字。`,
      '语文/英语考试需评估整卷阅读量是否适中：',
      `- 阅读量过大（总字数过多）→ 学生负担太重，应在 issues 中注明需精简材料`,
      `- 阅读量过小（总字数过少）→ 起不到考查阅读能力的作用，应在 issues 中注明需补充阅读材料`,
      '评分标准：阅读量适中不扣分；明显过多或过少时在该维度酌情扣分（总分仍可高于 60）。',
    ] : []),
    '',
    '=== 试卷详情 ===',
    formatQuestionSnapshot(questions),
    '',
    '=== 审核要求 ===',
    '逐题检查：',
    '1. 题目是否太 trivial（如选项有常识性送分答案、答案一眼可辨）',
    '2. 题目是否超纲（超出该年级课程标准）',
    '3. 选择题干扰项质量：是否有明显不合理的干扰项',
    '4. 题目是否能区分不同水平的学生',
    '5. 题目难度是否与标注的 difficulty 一致',
    '',
    '=== 输出格式（必须严格按此 JSON 结构，字段名不能改） ===',
    '{"scores":[{"index":0,"score":100,"issues":[]}]}',
    '其中 score=100 区分度优秀, <40=无区分度。80 以上说明区分度良好。',
  ].join('\n');
}

// ── 阶段四：重出 prompt ───────────────────

export function regenerateQuestionPrompt(
  question: ExamQuestion,
  feedback: string,
  config: PromptConfig,
  crossGroupContext: string,
): string {
  return [
    `你是命题专家。以下这道题在审核中未通过，需要重新出题。`,
    '',
    '=== 原题 ===',
    formatQuestionSnapshot([question]),
    '',
    '=== 审核反馈 ===',
    feedback,
    '',
    '=== 重出要求 ===',
    `请针对上述审核反馈重新出一道同题型、同分值（${question.points}分）的题目。`,
    `学科：${subjectLabel(config.subject)}（${gradeLabel(config.grade)}）。`,
    `原考点：${question.knowledgePoint ?? '综合'}。新题应考查同一知识点但用完全不同的情景和设问。`,
    '',
    '=== 跨组差异化约束 ===',
    crossGroupContext || '（无其他组）',
    '⚠ 新题的情景和数据必须与上述其他题目完全不同。',
    '',
    '=== 输出要求（必须严格按此 JSON 结构） ===',
    `{"questions":[{"stem":"题干","passage":"（有阅读材料时填写，无则省略此字段）","type":"${question.type}","points":${question.points},"knowledgePointId":${question.knowledgePointId ?? 123},"difficulty":"medium","explanation":"解析"${question.type === 'multiple_choice' ? ',"options":[{"key":"A","text":"选项1"},{"key":"B","text":"选项2"},{"key":"C","text":"选项3"},{"key":"D","text":"选项4"}],"correctKeys":["A"],"multiSelect":false' : ''}${question.type === 'fill_blank' ? ',"blanks":[{"acceptedAnswers":["答案"]}]' : ''}${question.type === 'true_false' ? ',"answer":true' : ''}${question.type === 'short_answer' ? ',"referenceAnswer":"参考答案","keyPoints":["要点"]' : ''}]}`,
    '直接输出 JSON，不要 markdown 代码块，不要其他文字。',
    KATEX_FORMAT_GUIDE,
    xlopGuide(config.grade),
  ].filter(Boolean).join('\n');
}
