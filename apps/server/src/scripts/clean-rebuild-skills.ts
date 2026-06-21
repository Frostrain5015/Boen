/**
 * clean-rebuild-skills.ts
 *
 * Step 2 + Step 3：清洗错题数据 + LLM 重建全局风格技能库。
 *
 * 用法:
 *   npx tsx src/scripts/clean-rebuild-skills.ts --dry-run   # 只预览将删除/重建的数量，不动数据
 *   npx tsx src/scripts/clean-rebuild-skills.ts             # 真正执行：清空技能库 + 删空壳/去重 + LLM 重建
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(__dirname, '../../../../.env') });

import { getChatModel } from '@boen/agent-core';
import db from '../db.js';
import { purgeEmptyMistakes, dedupeMistakes, rebuildStyleSkillsWithLLM } from '../mistakes.js';

const dryRun = process.argv.includes('--dry-run');

function count(sql: string): number {
  return (db.prepare(sql).get() as { c: number }).c;
}

async function main() {
  console.log(`\n=== clean-rebuild-skills ${dryRun ? '(DRY RUN，不改数据)' : '(执行)'} ===`);
  console.log('现状: mistake_items=%d, style_skills=%d, style_features=%d',
    count('SELECT COUNT(*) c FROM mistake_items'),
    count('SELECT COUNT(*) c FROM style_skills'),
    count('SELECT COUNT(*) c FROM mistake_style_features'));

  // Step 2a：空壳题
  const empties = purgeEmptyMistakes(true).empties;
  console.log(`\n[Step2] 无题面空壳题: ${empties} 条${dryRun ? '（将删除）' : ''}`);

  // Step 2b：重复/高度相似（dry-run 预览样例）
  const preview = await dedupeMistakes({ dryRun: true });
  console.log(`[Step2] 重复/高度相似题: ${preview.duplicates}/${preview.scanned} 条将删除，保留 ${preview.kept} 条`);
  if (preview.sample.length) console.log('  样例:', preview.sample.map((s) => `「${s}」`).join('  '));

  if (dryRun) {
    console.log('\n(dry-run 结束，未改动任何数据。去掉 --dry-run 正式执行。)');
    process.exit(0);
  }

  // 正式执行
  console.log('\n[Step2] 删除空壳题…', purgeEmptyMistakes(false));
  console.log('[Step2] 去重…', await dedupeMistakes({ dryRun: false }));

  // Step 3：LLM 重建技能库
  const apiKey = process.env.BOEN_API_KEY ?? process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error('缺少 BOEN_API_KEY / DEEPSEEK_API_KEY，无法调用 LLM 重建');
  const model = getChatModel({
    provider: (process.env.BOEN_PROVIDER === 'anthropic' || process.env.BOEN_PROVIDER === 'deepseek') ? process.env.BOEN_PROVIDER : 'deepseek',
    model: process.env.BOEN_MODEL ?? 'deepseek-v4-flash',
    apiKey,
    baseUrl: process.env.BOEN_BASE_URL,
    enableThinking: false,
  });
  console.log('\n[Step3] LLM 重建风格技能库…');
  const r = await rebuildStyleSkillsWithLLM(model);
  console.log(`[Step3] 完成：${r.buckets} 个 学科+年级 桶 → 共 ${r.skills} 个技能`);
  process.exit(0);
}

main().catch((err) => {
  console.error('[clean-rebuild-skills] 失败:', err);
  process.exit(1);
});
