/**
 * seed-kg-mappings.ts
 *
 * 将审核通过的知识图谱映射 JSON 文件灌入 kg-enrich 系统。
 * 读取 curriculum/kg-mappings/{subject}-G{grade}.json，
 * 为每个映射创建对应的 kg_edges 记录。
 *
 * 用法:
 *   npx tsx src/scripts/seed-kg-mappings.ts --subject chinese --grade 7
 *   npx tsx src/scripts/seed-kg-mappings.ts --subject chinese --grade 7 --dry-run
 */
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';
import { config as loadEnv } from 'dotenv';
import db from '../db.js';
const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(__dirname, '../../../../.env') });
const MAPPINGS_DIR = resolve(__dirname, '../../curriculum/kg-mappings');
const args = process.argv.slice(2);
function getArg(name) {
    const idx = args.indexOf(`--${name}`);
    return idx >= 0 ? args[idx + 1] : undefined;
}
const dryRun = args.includes('--dry-run');
const subject = getArg('subject');
const grade = getArg('grade');
if (!subject || !grade) {
    console.error('Usage: npx tsx src/scripts/seed-kg-mappings.ts --subject <subject> --grade <grade> [--dry-run]');
    process.exit(1);
}
// ── DB helpers ───────────────────────────────
function getNodeByTitleSubject(title, subj) {
    return db.prepare(`SELECT id FROM kg_nodes WHERE type='knowledge_point' AND subject=? AND title=?`).get(subj, title);
}
function getNodeByCode(type, code) {
    return db.prepare(`SELECT id FROM kg_nodes WHERE type=? AND code=?`).get(type, code);
}
const insEdge = db.prepare(`INSERT OR IGNORE INTO kg_edges (source_id, target_id, type, weight) VALUES (?, ?, ?, ?)`);
// ── Main ─────────────────────────────────────
const filePath = join(MAPPINGS_DIR, `${subject}-G${grade}.json`);
if (!existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
}
const data = JSON.parse(readFileSync(filePath, 'utf-8'));
console.log(`\n📖 Loading ${filePath}`);
console.log(`   Subject: ${data.subject}, Grade: G${data.grade}, KPs: ${data.kpCount}`);
console.log(`   Generated: ${data.generatedAt}`);
if (dryRun)
    console.log(`   🔸 DRY RUN — no DB writes\n`);
let counts = { prerequisite: 0, theme: 0, literacy: 0, bloom: 0 };
// 1. Prerequisites
console.log('\n── Prerequisites ──');
for (const edge of data.prerequisites) {
    const fromNode = getNodeByTitleSubject(edge.from, subject);
    const toNode = getNodeByTitleSubject(edge.to, subject);
    if (!fromNode) {
        console.warn(`  ⚠ from not found: "${edge.from}"`);
        continue;
    }
    if (!toNode) {
        console.warn(`  ⚠ to not found: "${edge.to}"`);
        continue;
    }
    if (!dryRun)
        insEdge.run(fromNode.id, toNode.id, 'prerequisite', 1.0);
    counts.prerequisite++;
}
console.log(`  ${counts.prerequisite} edges`);
// 2. Themes (belongs_to)
console.log('\n── Themes (belongs_to) ──');
for (const [title, themeCode] of Object.entries(data.themes)) {
    const kpNode = getNodeByTitleSubject(title, subject);
    const themeNode = getNodeByCode('theme', themeCode);
    if (!kpNode) {
        console.warn(`  ⚠ KP not found: "${title}"`);
        continue;
    }
    if (!themeNode) {
        console.warn(`  ⚠ theme not found: "${themeCode}"`);
        continue;
    }
    if (!dryRun)
        insEdge.run(kpNode.id, themeNode.id, 'belongs_to', 1.0);
    counts.theme++;
}
console.log(`  ${counts.theme} edges`);
// 3. Literacies (reinforces)
console.log('\n── Literacies (reinforces) ──');
for (const [title, litCodes] of Object.entries(data.literacies)) {
    const kpNode = getNodeByTitleSubject(title, subject);
    if (!kpNode) {
        console.warn(`  ⚠ KP not found: "${title}"`);
        continue;
    }
    for (const litCode of litCodes) {
        const litNode = getNodeByCode('literacy', litCode);
        if (!litNode) {
            console.warn(`  ⚠ literacy not found: "${litCode}"`);
            continue;
        }
        if (!dryRun)
            insEdge.run(kpNode.id, litNode.id, 'reinforces', 1.0);
        counts.literacy++;
    }
}
console.log(`  ${counts.literacy} edges`);
// 4. Blooms (bloom_at)
console.log('\n── Blooms (bloom_at) ──');
for (const [title, bloomCode] of Object.entries(data.blooms)) {
    const kpNode = getNodeByTitleSubject(title, subject);
    const bloomNode = getNodeByCode('bloom_level', bloomCode);
    if (!kpNode) {
        console.warn(`  ⚠ KP not found: "${title}"`);
        continue;
    }
    if (!bloomNode) {
        console.warn(`  ⚠ bloom not found: "${bloomCode}"`);
        continue;
    }
    if (!dryRun)
        insEdge.run(kpNode.id, bloomNode.id, 'bloom_at', 1.0);
    counts.bloom++;
}
console.log(`  ${counts.bloom} edges`);
// Summary
const total = counts.prerequisite + counts.theme + counts.literacy + counts.bloom;
console.log(`\n${dryRun ? '🔸 DRY RUN' : '✅'} Total: ${total} edges (${counts.prerequisite} prereq + ${counts.theme} theme + ${counts.literacy} literacy + ${counts.bloom} bloom)`);
if (dryRun)
    console.log('   Run without --dry-run to apply.\n');
