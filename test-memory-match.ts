// 测试 retrieveRelevantMemories 对常见查询的匹配率
import { embedQuery, cosineSim, blobToVector } from './src/embeddings.js';
import db from './src/db.js';

const SIMILARITY_THRESHOLD = 0.45;
const U = 'Ojr0t8md2cuLAQNkdyhNA5zaCTzslk0xXVR5'; // Frostrain 主账号
const testQueries = [
  '你好',
  '1+1等于几',
  '解释一下分数乘法',
  '开始复习',
  '什么是负数',
  '帮我出一道口算题',
  '继续',
  '竖式怎么算',
];

async function main() {
  const rows = db.prepare(
    `SELECT summary, topics, embedding FROM conversation_summaries WHERE user_id = ? ORDER BY created_at DESC LIMIT 20`
  ).all(U) as Array<{ summary: string; topics: string; embedding: Buffer }>;

  console.log(`数据库中 ${rows.length} 条摘要\n`);

  for (const q of testQueries) {
    const qv = await embedQuery(q);
    const scored = rows.map(r => ({
      score: cosineSim(qv, blobToVector(r.embedding)),
      topics: r.topics,
      summary: r.summary.slice(0, 60),
    })).sort((a, b) => b.score - a.score);

    const best = scored[0];
    const matched = best && best.score >= SIMILARITY_THRESHOLD;
    console.log(`"${q}" → 最高 ${best?.score.toFixed(3)} [${best?.topics}] ${matched ? '✅ 会注入' : '❌ 跳过'}`);
  }
}

main().then(() => process.exit(0));
