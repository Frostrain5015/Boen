/**
 * gen-codes.ts —— 生成自描述签名兑换码（16 字符）
 *
 * 用法:
 *   npx tsx src/scripts/gen-codes.ts --count 50 --days 30 --uses 1 --batch 1
 *
 * 参数:
 *   --count   生成数量（默认 1）
 *   --days    星月卡面值，仅 30 或 365（默认 30）
 *   --uses    可用次数：0=无限可复用 / 1=一次性 / N=限 N 次（0..7，默认 1）
 *   --batch   批次号（0..511，默认 0），用于整批撤销/统计
 *
 * 自描述码无需入库；输出为 CSV（code,nonce），nonce 留存以便日后按单码撤销。
 * 码不含自身有效期——作废用 `revoke:codes`（单码 nonce 或整批 batch）。
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { generateCode } from '../redeem.js';
const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(__dirname, '../../../../.env') });
const args = process.argv.slice(2);
function getArg(name, def) {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : def;
}
const secret = process.env.REDEEM_CODE_SECRET ?? '';
if (!secret) {
    console.error('❌ REDEEM_CODE_SECRET 未配置（仓库根 .env）');
    process.exit(1);
}
const count = Number(getArg('count', '1'));
const days = Number(getArg('days', '30'));
const uses = Number(getArg('uses', '1'));
const batch = Number(getArg('batch', '0'));
if (!Number.isInteger(count) || count < 1 ||
    (days !== 30 && days !== 365) ||
    !Number.isInteger(uses) || uses < 0 || uses > 7 ||
    !Number.isInteger(batch) || batch < 0 || batch > 511) {
    console.error('❌ 参数超出范围：count≥1, days∈{30,365}, uses 0..7, batch 0..511');
    process.exit(1);
}
const usesLabel = uses === 0 ? '可复用(无限)' : uses === 1 ? '一次性' : `限 ${uses} 次`;
console.log(`# ${count} 个兑换码 | 面值 ${days} 天 | ${usesLabel} | 批次 ${batch}`);
console.log('code,nonce');
for (let i = 0; i < count; i++) {
    const { code, nonce } = generateCode({ maxUses: uses, durationDays: days, batch }, secret);
    console.log(`${code},${nonce}`);
}
