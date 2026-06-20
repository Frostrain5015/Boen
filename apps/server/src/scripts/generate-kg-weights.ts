/**
 * generate-kg-weights.ts
 *
 * LLM 驱动的知识点权重种子生成器。
 * 为指定学科+年级的知识点评估四维权重：class_hours / exam_weight / foundation / overall。
 *
 * 用法:
 *   npx tsx src/scripts/generate-kg-weights.ts --subject chinese --grade 7
 *
 * 输出: curriculum/kg-mappings/{subject}-G{grade}-weights.json
 *
 * 输出格式与 kg-weights.ts 的 WeightSeed 一致，可直接追加到 WEIGHT_MAP。
 */

import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { config as loadEnv } from 'dotenv';
import { z } from 'zod';
import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import db from '../db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(__dirname, '../../../../.env') });

const CURRICULUM_DIR = resolve(__dirname, '../../curriculum');
const MAPPINGS_DIR = resolve(CURRICULUM_DIR, 'kg-mappings');

const args = process.argv.slice(2);
function getArg(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 ? args[idx + 1] : undefined;
}

const subject = getArg('subject');
const grade = getArg('grade');

if (!subject || !grade) {
  console.error('Usage: npx tsx src/scripts/generate-kg-weights.ts --subject <subject> --grade <grade>');
  process.exit(1);
}

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY ?? '';
if (!DEEPSEEK_API_KEY) { console.error('DEEPSEEK_API_KEY not found'); process.exit(1); }

const llm = new ChatOpenAI({
  model: 'deepseek-chat',
  apiKey: DEEPSEEK_API_KEY,
  temperature: 0.3,
  timeout: 180000,
  maxRetries: 2,
  streamUsage: false,
  configuration: { baseURL: 'https://api.deepseek.com' },
});

// ── Zod Schema（与 kg-weights.ts WeightSeed 一致） ──

const WeightSeedSchema = z.object({
  title: z.string(),
  class_hours: z.number().min(0).max(20),
  exam_weight: z.number().min(0).max(1),
  foundation: z.number().min(0).max(1),
  overall: z.number().min(0).max(1),
});

const WeightArraySchema = z.array(WeightSeedSchema);

// ── 数据加载 ─────────────────────────────────

function loadKPNodes(subj: string, g: string): Array<{ id: number; title: string }> {
  return db.prepare(`
    SELECT DISTINCT n.id, n.title
    FROM kg_nodes n
    JOIN curriculum_kg_map m ON m.node_id = n.id
    JOIN curriculum_units u ON u.id = m.unit_id
    JOIN curriculum_textbooks t ON t.id = u.textbook_id
    WHERE n.type = 'knowledge_point' AND n.subject = ? AND t.grade = ?
    ORDER BY n.id
  `).all(subj, g) as Array<{ id: number; title: string }>;
}

// ── LLM 调用 ─────────────────────────────────

async function generateWeights(kpTitles: string[]) {
  const subjectLabels: Record<string, string> = { chinese: '语文', english: '英语', science: '科学', math: '数学' };
  const gradeLabels: Record<string, string> = {
    '1': '一年级', '2': '二年级', '3': '三年级', '4': '四年级', '5': '五年级', '6': '六年级',
    '7': '七年级', '8': '八年级', '9': '九年级',
  };

  const subjLabel = subjectLabels[subject!] ?? subject;
  const gradeLabel = gradeLabels[grade!] ?? `${grade}年级`;

  const systemPrompt = `你是一位${subjLabel}教学专家和考试命题专家。
请为以下${gradeLabel}${subjLabel}知识点评估四个维度的权重指标：

1. class_hours：典型教学课时数（0-20，整数或半整数如2.5）
2. exam_weight：考试中出现的频率和分值占比（0-1，0.8=核心考点，0.5=常见考点，0.2=偶尔出现）
3. foundation：基础性重要程度（0-1，1.0=后续学习的必备基础，0.5=有用但非必需，0.1=拓展性知识）
4. overall：综合权重（0-1，综合以上三个维度的加权结果）

注意：
- 核心基础概念（如语文的字词基础、英语的基本语法、科学的基本概念）应获得较高的 foundation 值
- 考试高频考点（如语文阅读理解技巧、英语完形填空策略）应获得较高的 exam_weight 值
- overall 应反映该知识点在整个年级中的教学重要度`;

  const userContent = `请为以下${kpTitles.length}个${subjLabel}知识点评估权重：\n\n${kpTitles.map((t, i) => `${i + 1}. ${t}`).join('\n')}\n\n请严格按以下JSON数组格式输出（不要markdown代码块包裹）：\n[{"title":"知识点标题","class_hours":4,"exam_weight":0.8,"foundation":0.9,"overall":0.85}, ...]`;

  console.log(`  → Calling DeepSeek with ${kpTitles.length} KPs...`);
  const response = await llm.invoke([
    new SystemMessage(systemPrompt),
    new HumanMessage(userContent),
  ]);

  const text = typeof response.content === 'string' ? response.content : String(response.content);
  const cleaned = text.replace(/^```json?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();

  try {
    const raw = JSON.parse(cleaned);
    const parsed = WeightArraySchema.parse(raw);
    // 验证所有标题都在 KP 列表中
    const validTitles = new Set(kpTitles);
    const valid = parsed.filter(w => validTitles.has(w.title));
    const invalid = parsed.filter(w => !validTitles.has(w.title));
    if (invalid.length > 0) {
      console.warn(`  ⚠ ${invalid.length} titles not in KP list, filtered out`);
    }
    return valid;
  } catch (err) {
    console.error('  ✗ Validation failed:', err instanceof Error ? err.message : String(err));
    console.error('  Raw output (first 500 chars):', cleaned.slice(0, 500));
    return null;
  }
}

// ── Main ─────────────────────────────────────

async function main() {
  console.log(`\n⚖️  Generating weights for ${subject} G${grade}...\n`);

  const kpNodes = loadKPNodes(subject!, grade!);
  if (kpNodes.length === 0) {
    console.error(`No KP nodes found for ${subject} G${grade}`);
    process.exit(1);
  }
  console.log(`  ✓ ${kpNodes.length} KPs loaded`);

  const kpTitles = kpNodes.map(n => n.title);
  const weights = await generateWeights(kpTitles);
  if (!weights) { console.error('Failed'); process.exit(1); }

  console.log(`\n📊 ${weights.length}/${kpTitles.length} weights generated`);

  if (!existsSync(MAPPINGS_DIR)) mkdirSync(MAPPINGS_DIR, { recursive: true });
  const outPath = join(MAPPINGS_DIR, `${subject}-G${grade}-weights.json`);
  writeFileSync(outPath, JSON.stringify({
    subject, grade,
    generatedAt: new Date().toISOString(),
    weights,
  }, null, 2), 'utf-8');

  console.log(`✅ Written to ${outPath}`);
  console.log(`   Format compatible with kg-weights.ts WeightSeed[].\n`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
