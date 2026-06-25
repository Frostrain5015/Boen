import db from './db.js';
import { getOutline, lookupKnowledgePoint, retrieveCurriculum } from './curriculum.js';
const grade = process.argv[2] ?? '7';
const subject = process.argv[3] ?? 'math';
const query = process.argv.slice(4).join(' ') || '一元一次方程';
function count(sql, ...params) {
    const row = db.prepare(sql).get(...params);
    return row.n;
}
async function main() {
    const textbooks = count(`SELECT COUNT(*) AS n FROM curriculum_textbooks WHERE grade=? AND subject=?`, grade, subject);
    const units = count(`SELECT COUNT(*) AS n
     FROM curriculum_units u
     JOIN curriculum_textbooks t ON t.id=u.textbook_id
     WHERE t.grade=? AND t.subject=?`, grade, subject);
    const kps = count(`SELECT COUNT(*) AS n FROM knowledge_points WHERE grade=? AND subject=?`, grade, subject);
    const embeddings = count(`SELECT COUNT(*) AS n FROM curriculum_embeddings WHERE grade=? AND subject=?`, grade, subject);
    const missingSources = count(`SELECT COUNT(*) AS n
     FROM curriculum_textbooks
     WHERE grade=? AND subject=? AND (source_url IS NULL OR source_url='')`, grade, subject);
    if (textbooks === 0)
        throw new Error(`没有找到 ${subject} ${grade} 年级教材，请先运行 seed:curriculum。`);
    if (units === 0)
        throw new Error(`没有找到 ${subject} ${grade} 年级章节。`);
    if (kps === 0)
        console.warn(`⚠ ${subject} ${grade} 年级知识点为空，可以补充。`);
    if (embeddings === 0)
        throw new Error(`没有找到 ${subject} ${grade} 年级向量，请检查 seed 是否成功。`);
    if (missingSources > 0)
        throw new Error(`有 ${missingSources} 册教材缺少 sourceUrl。`);
    const outline = getOutline(grade, subject);
    if (!/第[一二三四五六七八九十]+章|[一二三四五六七八九十]+、|第[一二三四五六七八九十]+单元|Unit\s+\d/.test(outline))
        throw new Error('教材 outline 未包含预期章节。');
    const context = await retrieveCurriculum({ grade, subject, query });
    if (!context.includes('当前学情'))
        throw new Error('retrieveCurriculum 未返回课程上下文。');
    const lookup = await lookupKnowledgePoint({ grade, subject, query, limit: 5 });
    if (!lookup.includes(query) && !lookup.includes('向量召回'))
        throw new Error('lookupKnowledgePoint 未返回有效结果。');
    console.log(`课程知识库验证通过：${subject} ${grade} 年级`);
    console.log(`教材 ${textbooks} 册 / 章节 ${units} 条 / 知识点 ${kps} 条 / 向量 ${embeddings} 条`);
    console.log('\n教材 outline 预览：');
    console.log(outline.split('\n').slice(0, 12).join('\n'));
    console.log('\n知识点查询预览：');
    console.log(lookup.split('\n').slice(0, 12).join('\n'));
}
main().then(() => process.exit(0)).catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
});
