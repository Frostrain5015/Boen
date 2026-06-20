/**
 * Production contract check: LLM-authored labels must never cross the question
 * boundary.  It runs against one published Math G7 node and exercises every
 * interactive question payload converter.
 */
import { toQuestionPayload } from '@boen/agent-core';
import db from './db.js';
import { getPublishedKnowledgePointIds, resolveQuestionTaxonomy } from './question-taxonomy.js';

const row = db.prepare(`
  SELECT DISTINCT n.id, n.title
  FROM kg_nodes n
  JOIN curriculum_kg_map m ON m.node_id=n.id
  JOIN curriculum_units u ON u.id=m.unit_id
  JOIN curriculum_textbooks t ON t.id=u.textbook_id
  WHERE n.type='knowledge_point' AND t.subject='math' AND t.grade='7'
  LIMIT 1
`).get() as { id: number; title: string } | undefined;
if (!row) throw new Error('缺少 Math G7 的已发布知识点，无法验证题目分类契约');

const forged = { knowledgePointId: row.id, knowledgePoint: '模型伪造考点', literacies: ['模型伪造素养'] };
const payloads = [
  toQuestionPayload('ask_multiple_choice', {
    stem: '测试题干', options: [{ key: 'A', text: '甲' }, { key: 'B', text: '乙' }], correctKeys: ['A'], explanation: '测试解析', ...forged,
  }),
  toQuestionPayload('ask_fill_blank', {
    stem: '测试 ____', blanks: [{ acceptedAnswers: ['答案'] }], explanation: '测试解析', ...forged,
  }),
  toQuestionPayload('ask_true_false', { stem: '测试判断题', answer: true, explanation: '测试解析', ...forged }),
  toQuestionPayload('ask_short_answer', { stem: '测试简答题', referenceAnswer: '答案', explanation: '测试解析', ...forged }),
];

for (const payload of payloads) {
  if (payload.knowledgePoint || payload.literacies?.length) {
    throw new Error('原始模型标签穿透了 QuestionPayload');
  }
  const taxonomy = resolveQuestionTaxonomy({
    subject: 'math',
    grade: '7',
    knowledgePointId: payload.knowledgePointId,
    allowedKnowledgePointIds: getPublishedKnowledgePointIds('math', '7'),
  });
  if (!taxonomy || taxonomy.knowledgePointId !== row.id || taxonomy.knowledgePoint === forged.knowledgePoint) {
    throw new Error('未能将题目分类回填为数据库事实');
  }
}

console.log(JSON.stringify({
  check: 'db-only-question-taxonomy',
  subject: 'math',
  grade: '7',
  knowledgePointId: row.id,
  questionTypes: payloads.length,
}));
