/**
 * seed-knowledge-graph.ts
 * 注入知识图谱种子数据 + 从现有课程数据同步映射关系
 *
 * 运行：npm run seed:kg --workspace @boen/server
 */
import { seedKnowledgeGraph, syncUnitMappings, getNodesByType, ensureKnowledgeGraphTables } from './knowledge-graph.js';
async function main() {
    console.log('[知识图谱] 初始化表结构...');
    ensureKnowledgeGraphTables();
    console.log('[知识图谱] 注入种子数据（主题领域 + 核心素养 + 布鲁姆分类）...');
    seedKnowledgeGraph();
    console.log('[知识图谱] 种子数据完成。');
    // 统计各类型节点数
    const themeCount = getNodesByType('theme').length;
    const literacyCount = getNodesByType('literacy').length;
    const bloomCount = getNodesByType('bloom_level').length;
    console.log(`  主题领域 ${themeCount} 个 / 核心素养 ${literacyCount} 个 / 布鲁姆层级 ${bloomCount} 个`);
    // 为存在知识点的年级同步映射关系
    const subjects = ['math', 'chinese', 'english', 'science'];
    const grades = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
    let totalMapped = 0;
    for (const subj of subjects) {
        for (const grade of grades) {
            const { mapped } = syncUnitMappings(subj, grade);
            totalMapped += mapped;
        }
    }
    console.log(`[知识图谱] 已同步 ${totalMapped} 条章节↔知识点映射关系。`);
    console.log('[知识图谱] seed 完成。');
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
