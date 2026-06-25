/**
 * generate-kg-mappings.ts
 *
 * LLM 驱动的知识图谱映射数据生成器。
 * 为指定学科+年级的知识点生成 prerequisite / theme / literacy / bloom 四类映射。
 *
 * 用法:
 *   npx tsx src/scripts/generate-kg-mappings.ts --subject chinese --grade 7
 *   npx tsx src/scripts/generate-kg-mappings.ts --subject english --grade 7
 *   npx tsx src/scripts/generate-kg-mappings.ts --subject science --grade 7
 *   npx tsx src/scripts/generate-kg-mappings.ts --subject chinese --grade 7 --semester 上册
 *
 * 输出: curriculum/kg-mappings/{subject}-G{grade}.json
 */
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { config as loadEnv } from 'dotenv';
import { z } from 'zod';
import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import db from '../db.js';
import { themesForSubject, literaciesForSubject, BLOOM_LEVELS, } from '../knowledge-graph.js';
// ── 路径初始化 ────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(__dirname, '../../../../.env') });
const CURRICULUM_DIR = resolve(__dirname, '../../curriculum');
const MAPPINGS_DIR = resolve(CURRICULUM_DIR, 'kg-mappings');
const STANDARDS_DIR = resolve(CURRICULUM_DIR, 'standards');
// ── CLI 参数解析 ──────────────────────────────
const args = process.argv.slice(2);
function getArg(name) {
    const idx = args.indexOf(`--${name}`);
    return idx >= 0 ? args[idx + 1] : undefined;
}
const subject = getArg('subject');
const grade = getArg('grade');
const semester = getArg('semester'); // 可选：上册/下册/全一册
if (!subject || !grade) {
    console.error('Usage: npx tsx src/scripts/generate-kg-mappings.ts --subject <chinese|english|science> --grade <1-9> [--semester 上册|下册]');
    process.exit(1);
}
// ── LLM 初始化 ───────────────────────────────
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY ?? '';
if (!DEEPSEEK_API_KEY) {
    console.error('DEEPSEEK_API_KEY not found in .env');
    process.exit(1);
}
const llm = new ChatOpenAI({
    model: 'deepseek-chat',
    apiKey: DEEPSEEK_API_KEY,
    temperature: 0.3, // 低温度确保稳定输出
    timeout: 180000,
    maxRetries: 2,
    streamUsage: false,
    configuration: { baseURL: 'https://api.deepseek.com' },
});
// ── 数据加载 ─────────────────────────────────
/** 从 DB 读取指定学科+年级的所有 knowledge_point 节点 */
function loadKPNodes(subj, g) {
    // 通过 curriculum_kg_map + curriculum_units + curriculum_textbooks 关联查询
    const rows = db.prepare(`
    SELECT DISTINCT n.id, n.title, n.description
    FROM kg_nodes n
    JOIN curriculum_kg_map m ON m.node_id = n.id
    JOIN curriculum_units u ON u.id = m.unit_id
    JOIN curriculum_textbooks t ON t.id = u.textbook_id
    WHERE n.type = 'knowledge_point'
      AND n.subject = ?
      AND t.grade = ?
    ORDER BY n.id
  `).all(subj, g);
    return rows;
}
/** 读取 curriculum JSON 获取教材结构上下文 */
function loadCurriculumContext(subj, g) {
    const gradeLabel = `g${g}`;
    const patterns = semester
        ? [`${subj}-${gradeLabel}-${semester}.json`]
        : [`${subj}-${gradeLabel}-上册.json`, `${subj}-${gradeLabel}-下册.json`, `${subj}-${gradeLabel}-全一册.json`];
    const contexts = [];
    for (const file of patterns) {
        const path = join(CURRICULUM_DIR, file);
        if (!existsSync(path))
            continue;
        try {
            const data = JSON.parse(readFileSync(path, 'utf-8'));
            const units = data.children || [];
            const lines = [`## ${data.title || file}`];
            for (const unit of units) {
                lines.push(`  - ${unit.title}`);
                if (unit.children) {
                    for (const child of unit.children) {
                        lines.push(`    - ${child.title}`);
                    }
                }
            }
            contexts.push(lines.join('\n'));
        }
        catch { /* skip malformed files */ }
    }
    return contexts.join('\n\n');
}
/** 加载课标参考文本（如果存在） */
function loadStandardText(subj) {
    const path = join(STANDARDS_DIR, `${subj}.md`);
    if (!existsSync(path))
        return '';
    return readFileSync(path, 'utf-8');
}
/** 加载低年级 KP 列表作为跨年级 prerequisite 参考 */
function loadLowerGradeKPs(subj, g) {
    const gradeNum = parseInt(g);
    const titles = [];
    for (let lower = Math.max(1, gradeNum - 2); lower < gradeNum; lower++) {
        const kps = loadKPNodes(subj, String(lower));
        titles.push(...kps.map(k => k.title));
    }
    return titles;
}
// ── Zod 校验 Schema ──────────────────────────
const themeCodes = themesForSubject(subject).map(t => t.id);
const literacyCodes = literaciesForSubject(subject).map(l => l.id);
const bloomCodes = BLOOM_LEVELS.map(b => b.id);
const PrerequisiteSchema = z.array(z.object({
    from: z.string().describe('前置知识点标题'),
    to: z.string().describe('依赖知识点标题'),
}));
const ThemeSchema = z.record(z.string(), z.enum(themeCodes));
const LiteracySchema = z.record(z.string(), z.array(z.enum(literacyCodes)).min(1).max(3));
const BloomSchema = z.record(z.string(), z.enum(bloomCodes));
const MappingsSchema = z.object({
    prerequisites: PrerequisiteSchema,
    themes: ThemeSchema,
    literacies: LiteracySchema,
    blooms: BloomSchema,
});
// ── 学科描述 ─────────────────────────────────
const SUBJECT_LABELS = {
    chinese: '语文',
    english: '英语',
    science: '科学',
    math: '数学',
};
const GRADE_LABELS = {
    '1': '一年级', '2': '二年级', '3': '三年级',
    '4': '四年级', '5': '五年级', '6': '六年级',
    '7': '七年级（初一）', '8': '八年级（初二）', '9': '九年级（初三）',
};
// ── LLM 调用 ─────────────────────────────────
async function generateMappings(kpTitles, context, standardText, lowerGradeKPs) {
    const subjectLabel = SUBJECT_LABELS[subject] ?? subject;
    const gradeLabel = GRADE_LABELS[grade] ?? `${grade}年级`;
    const themeDesc = themeCodes.map(code => {
        const t = themesForSubject(subject).find(x => x.id === code);
        return `  ${code}: ${t?.title}（${t?.description}）`;
    }).join('\n');
    const literacyDesc = literacyCodes.map(code => {
        const l = literaciesForSubject(subject).find(x => x.id === code);
        return `  ${code}: ${l?.title}（${l?.description}）`;
    }).join('\n');
    const bloomDesc = bloomCodes.map(code => {
        const b = BLOOM_LEVELS.find(x => x.id === code);
        return `  ${code}: ${b?.title}（${b?.description}）`;
    }).join('\n');
    const systemPrompt = `你是一位资深的${subjectLabel}教育专家和课程设计师，精通《义务教育${subjectLabel}课程标准（2022年版）》。
你的任务是为${gradeLabel}的${subjectLabel}知识点生成四类教学映射关系。

## 可用代码

### 主题领域（theme）
${themeDesc}

### 核心素养（literacy，每个KP选1-3个）
${literacyDesc}

### 布鲁姆认知层级（bloom）
${bloomDesc}

## 规则
1. prerequisite：学习"to"之前必须先掌握"from"。仅包含直接的教学依赖，不要过度连接。
   每个知识点的直接前置通常0-2个。
2. theme：每个知识点归属一个主题领域，从上述代码中选择。
3. literacy：每个知识点培养1-3个核心素养，从上述代码中选择。
4. bloom：每个知识点的认知要求层级，从上述代码中选择一个。
5. 所有知识点标题必须与输入列表中的标题完全一致，不得修改。
6. 确保每个知识点都有 theme、literacy、bloom 映射。`;
    let userContent = `请为以下${kpTitles.length}个${subjectLabel}知识点生成映射：\n\n`;
    userContent += `### 知识点列表\n`;
    userContent += kpTitles.map((t, i) => `${i + 1}. ${t}`).join('\n');
    if (lowerGradeKPs.length > 0) {
        userContent += `\n\n### 低年级已学知识点（可作为跨年级prerequisite的"from"）\n`;
        userContent += lowerGradeKPs.slice(0, 50).map(t => `- ${t}`).join('\n');
        if (lowerGradeKPs.length > 50)
            userContent += `\n... 共${lowerGradeKPs.length}条`;
    }
    if (context) {
        userContent += `\n\n### 教材章节结构\n${context}`;
    }
    if (standardText) {
        // 截断过长的课标文本
        const truncated = standardText.length > 4000 ? standardText.slice(0, 4000) + '\n...(已截断)' : standardText;
        userContent += `\n\n### 课程标准参考\n${truncated}`;
    }
    userContent += `\n\n请严格按以下JSON格式输出（不要markdown代码块包裹）：
{
  "prerequisites": [{"from": "知识点A", "to": "知识点B"}],
  "themes": {"知识点标题": "theme_code"},
  "literacies": {"知识点标题": ["lit_code1", "lit_code2"]},
  "blooms": {"知识点标题": "bloom_code"}
}`;
    console.log(`  → Calling DeepSeek with ${kpTitles.length} KPs...`);
    const response = await llm.invoke([
        new SystemMessage(systemPrompt),
        new HumanMessage(userContent),
    ]);
    const text = typeof response.content === 'string' ? response.content : String(response.content);
    // 清理可能的 markdown 代码块包裹
    const cleaned = text.replace(/^```json?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
    try {
        const raw = JSON.parse(cleaned);
        return MappingsSchema.parse(raw);
    }
    catch (err) {
        console.error('  ✗ Zod validation failed:', err instanceof Error ? err.message : String(err));
        console.error('  Raw output (first 500 chars):', cleaned.slice(0, 500));
        return null;
    }
}
// ── 验证：确保映射中的 KP 标题存在于 DB ─────
function validateKPTitles(mappings, validTitles, lowerGradeTitles) {
    const warnings = [];
    const validPrereqs = mappings.prerequisites.filter(p => {
        const fromOk = validTitles.has(p.from) || lowerGradeTitles.has(p.from);
        const toOk = validTitles.has(p.to);
        if (!fromOk)
            warnings.push(`prerequisite.from 不存在: "${p.from}"`);
        if (!toOk)
            warnings.push(`prerequisite.to 不存在: "${p.to}"`);
        return fromOk && toOk;
    });
    for (const title of Object.keys(mappings.themes)) {
        if (!validTitles.has(title))
            warnings.push(`theme 映射标题不存在: "${title}"`);
    }
    for (const title of Object.keys(mappings.literacies)) {
        if (!validTitles.has(title))
            warnings.push(`literacy 映射标题不存在: "${title}"`);
    }
    for (const title of Object.keys(mappings.blooms)) {
        if (!validTitles.has(title))
            warnings.push(`bloom 映射标题不存在: "${title}"`);
    }
    return { validPrereqs, warnings };
}
// ── 主流程 ───────────────────────────────────
async function main() {
    console.log(`\n🔍 Generating KG mappings for ${subject} G${grade}${semester ? ` (${semester})` : ''}...\n`);
    // 1. 加载数据
    const kpNodes = loadKPNodes(subject, grade);
    if (kpNodes.length === 0) {
        console.error(`  ✗ No knowledge_point nodes found for ${subject} G${grade}.`);
        console.error(`    Run seed-kp.ts + seed-knowledge-graph.ts first to generate KP nodes.`);
        process.exit(1);
    }
    console.log(`  ✓ Found ${kpNodes.length} KP nodes`);
    const kpTitles = kpNodes.map(n => n.title);
    const curriculumContext = loadCurriculumContext(subject, grade);
    const standardText = loadStandardText(subject);
    const lowerGradeKPs = loadLowerGradeKPs(subject, grade);
    console.log(`  ✓ Curriculum context: ${curriculumContext ? curriculumContext.length + ' chars' : 'none'}`);
    console.log(`  ✓ Standard text: ${standardText ? standardText.length + ' chars' : 'none (place at curriculum/standards/' + subject + '.md)'}`);
    console.log(`  ✓ Lower grade KPs: ${lowerGradeKPs.length} (for cross-grade prerequisites)`);
    // 2. 调用 LLM
    console.log('\n📡 Calling LLM...');
    const result = await generateMappings(kpTitles, curriculumContext, standardText, lowerGradeKPs);
    if (!result) {
        console.error('\n✗ Failed to generate valid mappings. Check LLM output above.');
        process.exit(1);
    }
    // 3. 验证
    const validTitles = new Set(kpTitles);
    const lowerGradeTitleSet = new Set(lowerGradeKPs);
    const { validPrereqs, warnings } = validateKPTitles(result, validTitles, lowerGradeTitleSet);
    if (warnings.length > 0) {
        console.log(`\n⚠ ${warnings.length} validation warnings:`);
        warnings.slice(0, 10).forEach(w => console.log(`  - ${w}`));
        if (warnings.length > 10)
            console.log(`  ... and ${warnings.length - 10} more`);
    }
    // 4. 统计
    const themeCoverage = Object.keys(result.themes).length;
    const literacyCoverage = Object.keys(result.literacies).length;
    const bloomCoverage = Object.keys(result.blooms).length;
    console.log(`\n📊 Results:`);
    console.log(`  Prerequisites: ${validPrereqs.length} edges (${result.prerequisites.length - validPrereqs.length} filtered)`);
    console.log(`  Themes: ${themeCoverage}/${kpTitles.length} KPs mapped`);
    console.log(`  Literacies: ${literacyCoverage}/${kpTitles.length} KPs mapped`);
    console.log(`  Blooms: ${bloomCoverage}/${kpTitles.length} KPs mapped`);
    // 5. 写入文件
    if (!existsSync(MAPPINGS_DIR))
        mkdirSync(MAPPINGS_DIR, { recursive: true });
    const outPath = join(MAPPINGS_DIR, `${subject}-G${grade}.json`);
    const output = {
        subject,
        grade,
        generatedAt: new Date().toISOString(),
        kpCount: kpTitles.length,
        prerequisites: validPrereqs,
        themes: result.themes,
        literacies: result.literacies,
        blooms: result.blooms,
        _warnings: warnings,
    };
    writeFileSync(outPath, JSON.stringify(output, null, 2), 'utf-8');
    console.log(`\n✅ Written to ${outPath}`);
    console.log(`   Review the file and correct any LLM errors before seeding.\n`);
}
main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
