/**
 * seed-kp.ts — 用 LLM 为所有学科生成知识点并注入课程知识库
 *
 * 对每册教材的章节结构，调用模型提取知识点并关联到对应单元。
 * 运行：npx tsx src/seed-kp.ts
 */
import { config as loadEnv } from 'dotenv';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(__dirname, '../../../.env') });
import db from './db.js';
import { getChatModel } from '@boen/agent-core';
import { SystemMessage } from '@langchain/core/messages';
import { syncUnitMappings } from './knowledge-graph.js';
const SUBJECT_LABEL = { chinese: '语文', math: '数学', english: '英语', science: '科学' };
const GRADE_CN = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];
function gradeLabel(g) {
    const n = Number(g);
    if (n >= 1 && n <= 9)
        return n <= 6 ? `小学${GRADE_CN[n - 1]}年级` : `初中${GRADE_CN[n - 1]}`;
    return g;
}
/** 从 DB 读取某教材的完整章节树 */
function loadUnitTree(textbookId, parentId = null) {
    const rows = db.prepare(`SELECT id, title FROM curriculum_units WHERE textbook_id=? AND parent_id IS ? ORDER BY seq`).all(textbookId, parentId);
    return rows.map((r) => ({ id: r.id, title: r.title, children: loadUnitTree(textbookId, r.id) }));
}
/** 扁平化章节树为标题列表 */
function flattenTree(nodes, depth = 0) {
    const lines = [];
    for (const n of nodes) {
        lines.push('  '.repeat(depth) + '- ' + n.title);
        if (n.children.length)
            lines.push(...flattenTree(n.children, depth + 1));
    }
    return lines;
}
/** 检查某教材是否已有知识点 */
function hasKnowledgePoints(textbookId) {
    const count = db.prepare(`
    SELECT COUNT(*) AS c FROM unit_knowledge_map ukm
    JOIN curriculum_units u ON u.id = ukm.unit_id
    WHERE u.textbook_id=?
  `).get(textbookId);
    return count.c > 0;
}
async function main() {
    const subjects = ['chinese', 'math', 'english', 'science'];
    const grades = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
    const textbooks = db.prepare(`SELECT id, subject, grade, volume FROM curriculum_textbooks ORDER BY subject, grade, volume`).all();
    console.log(`共 ${textbooks.length} 册教材`);
    const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY ?? '';
    const model = DEEPSEEK_API_KEY
        ? getChatModel({ provider: 'deepseek', model: 'deepseek-v4-flash', apiKey: DEEPSEEK_API_KEY, temperature: 0.1 })
        : getChatModel({
            provider: (process.env.BOEN_PROVIDER ?? 'openai'),
            model: process.env.BOEN_MODEL ?? 'astron-code-latest',
            apiKey: process.env.BOEN_API_KEY ?? '',
            baseUrl: process.env.BOEN_BASE_URL,
            temperature: 0.1,
        });
    for (const tb of textbooks) {
        if (hasKnowledgePoints(tb.id)) {
            const existingCount = db.prepare(`SELECT COUNT(*) AS c FROM unit_knowledge_map ukm JOIN curriculum_units u ON u.id=ukm.unit_id WHERE u.textbook_id=?`).get(tb.id).c;
            console.log(`  [跳过] ${SUBJECT_LABEL[tb.subject] ?? tb.subject} ${gradeLabel(tb.grade)} ${tb.volume}（已有 ${existingCount} 条知识点）`);
            continue;
        }
        const tree = loadUnitTree(tb.id);
        const outline = flattenTree(tree).join('\n');
        console.log(`\n  [生成] ${SUBJECT_LABEL[tb.subject] ?? tb.subject} ${gradeLabel(tb.grade)} ${tb.volume}（${tree.length} 章）`);
        const prompt = [
            `你是一位课程设计专家。请为以下教材章节提取核心知识点。`,
            ``,
            `学科：${SUBJECT_LABEL[tb.subject] ?? tb.subject}`,
            `年级：${gradeLabel(tb.grade)}`,
            `教材：${tb.volume}`,
            ``,
            `章节结构：`,
            outline,
            ``,
            `请为每个章节/小节提炼 1-3 个知识点，格式为 JSON：`,
            `[`,
            `  {"title": "知识点名称（6-15字）", "description": "一句话描述这个知识点", "unitTitles": ["对应的小节标题精确匹配"]}`,
            `]`,
            ``,
            `要求：`,
            `- 知识点名称简洁明确，适合作为知识图谱节点`,
            `- 描述一句话说明该知识点的核心内容`,
            `- unitTitles 引用上面章节树中的标题，必须完全一致`,
            `- 同一册下知识点不要重复`,
            `- 每个小节至少覆盖 1 个知识点`,
            `- 只输出 JSON 数组，不要其他文字`,
        ].join('\n');
        let parsed = [];
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                const resp = await model.invoke([new SystemMessage(prompt)]);
                const text = typeof resp.content === 'string' ? resp.content : '';
                const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
                const jsonStr = jsonMatch ? jsonMatch[1] : text;
                const cleaned = jsonStr.replace(/^[^{[]*([\[{])/, '$1').replace(/([\}\]])\s*[^}\]]*$/, '$1');
                parsed = JSON.parse(cleaned);
                if (Array.isArray(parsed) && parsed.length > 0)
                    break;
            }
            catch (e) {
                console.log(`    尝试 ${attempt + 1} 失败: ${e.message?.slice(0, 60)}`);
            }
        }
        if (!parsed.length) {
            console.log('    ❌ 生成失败，跳过');
            continue;
        }
        console.log(`    ✅ 生成 ${parsed.length} 个知识点`);
        // 插入到 knowledge_points 和 unit_knowledge_map
        const insKp = db.prepare(`INSERT OR IGNORE INTO knowledge_points (subject, grade, title, description) VALUES (?, ?, ?, ?)`);
        const findUnit = db.prepare(`SELECT id, title FROM curriculum_units WHERE textbook_id=? AND title=?`);
        const insMap = db.prepare(`INSERT OR IGNORE INTO unit_knowledge_map (unit_id, knowledge_point_id) VALUES (?, ?)`);
        let mapped = 0;
        for (const kp of parsed) {
            const r = insKp.run(tb.subject, tb.grade, kp.title, kp.description || '');
            let kpId = Number(r.lastInsertRowid);
            if (kpId === 0) {
                // 已存在，查找 id
                const existing = db.prepare(`SELECT id FROM knowledge_points WHERE subject=? AND title=?`).get(tb.subject, kp.title);
                if (!existing)
                    continue;
                kpId = existing.id;
            }
            // 映射到章节
            const titles = Array.isArray(kp.unitTitles) ? kp.unitTitles : [kp.unitTitles].filter(Boolean);
            for (const title of titles) {
                // 支持精确匹配和模糊匹配
                const matches = db.prepare(`SELECT id FROM curriculum_units WHERE textbook_id=? AND (title=? OR title LIKE ?) ORDER BY seq LIMIT 1`).all(tb.id, title, `%${title.replace(/[%_]/g, '')}%`);
                for (const m of matches) {
                    insMap.run(m.id, kpId);
                    mapped++;
                }
            }
        }
        // 如果没有精确匹配，用父级章节关联（保底）
        if (mapped === 0) {
            console.log('    无精确匹配，尝试按层级映射...');
            for (const kp of parsed) {
                const kpRow = db.prepare(`SELECT id FROM knowledge_points WHERE subject=? AND title=?`).get(tb.subject, kp.title);
                if (!kpRow)
                    continue;
                // 关联到第一个匹配的父级章节
                const allUnits = db.prepare(`SELECT id, title FROM curriculum_units WHERE textbook_id=? ORDER BY seq`).all(tb.id);
                for (const u of allUnits) {
                    if (kp.title.includes(u.title.replace(/^\d+[、.．]?\s*/, '')) || u.title.includes(kp.title.substring(0, 4))) {
                        insMap.run(u.id, kpRow.id);
                        mapped++;
                        break;
                    }
                }
            }
        }
        console.log(`    ↦ 映射 ${mapped} 条章节关系`);
    }
    // 同步到 kg_nodes
    console.log('\n[知识图谱] 同步 kg_nodes...');
    let total = 0;
    for (const subj of subjects) {
        for (const g of grades) {
            const { mapped } = syncUnitMappings(subj, g);
            total += mapped;
        }
    }
    console.log(`[知识图谱] 同步完成：共 ${total} 条映射`);
    console.log('\n✅ seed-kp 完成');
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
