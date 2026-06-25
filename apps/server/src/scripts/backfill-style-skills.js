/**
 * backfill-style-skills.ts
 *
 * 从现有 mistake_style_features 一次性回填全服务器「出题风格技能库」(style_skills)。
 * 复用已存的 embedding，零重新向量化；幂等（全量清空再重建）。
 *
 * 用法:
 *   npx tsx src/scripts/backfill-style-skills.ts
 */
import { backfillStyleSkills } from '../mistakes.js';
const result = backfillStyleSkills();
console.log(`[backfill-style-skills] 扫描 ${result.scanned} 条风格特征 → 新建 ${result.created} 个技能，强化合并 ${result.reinforced} 次`);
process.exit(0);
