/**
 * 题目分类事实层。
 *
 * LLM 可以根据题目和作答生成自然语言内容，但不能成为知识点标题或核心素养标签的来源。
 * 所有学生可见的考点和素养均由这里从 kg_nodes / kg_edges 读取。
 */
import db from './db.js';
function asPositiveInt(value) {
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isInteger(n) && n > 0 ? n : undefined;
}
function cleanTitle(value) {
    if (typeof value !== 'string')
        return undefined;
    const text = value.trim();
    return text || undefined;
}
/** 给定 KG 节点 ID，确认其属于给定学科和年级的已发布教材范围。 */
export function getQuestionTaxonomyById(knowledgePointId, subject, grade) {
    const row = db.prepare(`
    SELECT n.id, n.title
    FROM kg_nodes n
    WHERE n.id=?
      AND n.type='knowledge_point'
      AND n.subject=?
      AND (
        ? IS NULL OR EXISTS (
          SELECT 1
          FROM curriculum_kg_map m
          JOIN curriculum_units u ON u.id=m.unit_id
          JOIN curriculum_textbooks t ON t.id=u.textbook_id
          WHERE m.node_id=n.id AND t.grade=? AND t.subject=?
        )
      )
  `).get(knowledgePointId, subject, grade ?? null, grade ?? null, subject);
    if (!row)
        return null;
    const literacies = db.prepare(`
    SELECT DISTINCT n.title
    FROM kg_edges e
    JOIN kg_nodes n ON n.id=e.target_id
    WHERE e.source_id=? AND e.type='reinforces' AND n.type='literacy'
    ORDER BY n.code, n.title
  `).all(row.id);
    return {
        knowledgePointId: row.id,
        knowledgePoint: row.title,
        literacies: literacies.map((item) => item.title),
    };
}
/**
 * 解析题目分类。
 *
 * 优先只接受明确的知识点 ID；为了兼容旧模型输出，若 ID 缺失，允许在已限定的数据库候选集中按精确标题反查。
 * 无法反查时返回 null，调用方必须拒绝交付该题，而不是展示模型自造标签。
 */
export function resolveQuestionTaxonomy(input) {
    const allowed = [...new Set((input.allowedKnowledgePointIds ?? [])
            .map(asPositiveInt)
            .filter((id) => id !== undefined))];
    const requestedId = asPositiveInt(input.knowledgePointId);
    if (requestedId && (allowed.length === 0 || allowed.includes(requestedId))) {
        const taxonomy = getQuestionTaxonomyById(requestedId, input.subject, input.grade);
        if (taxonomy)
            return taxonomy;
    }
    const requestedTitle = cleanTitle(input.knowledgePointTitle);
    if (requestedTitle && allowed.length > 0) {
        for (const id of allowed) {
            const taxonomy = getQuestionTaxonomyById(id, input.subject, input.grade);
            if (taxonomy?.knowledgePoint === requestedTitle)
                return taxonomy;
        }
    }
    // 单一候选的板块不要求模型重复填写 ID，仍由数据库决定全部展示字段。
    if (!requestedId && !requestedTitle && allowed.length === 1) {
        return getQuestionTaxonomyById(allowed[0], input.subject, input.grade);
    }
    return null;
}
/** 查询一个年级学科实际可出题的知识点，供服务端、测试和提示词共用。 */
export function getPublishedKnowledgePointIds(subject, grade) {
    return db.prepare(`
    SELECT DISTINCT n.id
    FROM kg_nodes n
    JOIN curriculum_kg_map m ON m.node_id=n.id
    JOIN curriculum_units u ON u.id=m.unit_id
    JOIN curriculum_textbooks t ON t.id=u.textbook_id
    WHERE n.type='knowledge_point' AND n.subject=? AND t.subject=? AND t.grade=?
    ORDER BY n.id
  `).all(subject, subject, grade).map((row) => row.id);
}
/** 仅用于不信任历史题目时的展示和结果修复。 */
export function canonicalizeStoredQuestionTaxonomy(question, subject, grade) {
    const taxonomy = resolveQuestionTaxonomy({
        subject,
        grade,
        knowledgePointId: question.knowledgePointId,
        knowledgePointTitle: question.knowledgePoint,
        allowedKnowledgePointIds: grade ? getPublishedKnowledgePointIds(subject, grade) : [],
    });
    if (!taxonomy)
        return null;
    return {
        ...question,
        knowledgePointId: taxonomy.knowledgePointId,
        knowledgePoint: taxonomy.knowledgePoint,
        literacies: taxonomy.literacies,
    };
}
