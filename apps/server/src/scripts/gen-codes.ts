/**
 * gen-codes.ts —— 生成自描述签名兑换码
 *
 * 用法:
 *   npx tsx src/scripts/gen-codes.ts --count 50 --days 30 --uses 1 --batch 1 --expiry-days 90
 *
 * 参数:
 *   --count        生成数量（默认 1）
 *   --days         兑换得到的会员天数（1..65535，默认 30）
 *   --uses         可用次数：0=无限可复用 / 1=一次性 / N=限 N 次（0..255，默认 1）
 *   --batch        批次号（0..65535，默认 0），用于整批撤销/统计
 *   --expiry-days  码自身有效期天数（0=永不过期，默认 0）
 *
 * 自描述码无需入库；输出为 CSV（code,nonce），nonce 留存以便日后按单码撤销。
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { generateCode, expiryDaysToField } from '../redeem.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(__dirname, '../../../../.env') });

const args = process.argv.slice(2);
function getArg(name: string, def: string): string {
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
const expiryDays = Number(getArg('expiry-days', '0'));

if (
  !Number.isInteger(count) || count < 1 ||
  !Number.isInteger(days) || days < 1 || days > 65535 ||
  !Number.isInteger(uses) || uses < 0 || uses > 255 ||
  !Number.isInteger(batch) || batch < 0 || batch > 65535 ||
  !Number.isInteger(expiryDays) || expiryDays < 0
) {
  console.error('❌ 参数超出范围：count≥1, days 1..65535, uses 0..255, batch 0..65535, expiry-days≥0');
  process.exit(1);
}

const codeExpiryDay = expiryDaysToField(expiryDays);
const usesLabel = uses === 0 ? '可复用(无限)' : uses === 1 ? '一次性' : `限 ${uses} 次`;
console.log(
  `# ${count} 个兑换码 | 面值 ${days} 天 | ${usesLabel} | 批次 ${batch} | ${expiryDays > 0 ? `码 ${expiryDays} 天后过期` : '码永不过期'}`,
);
console.log('code,nonce');
for (let i = 0; i < count; i++) {
  const { code, nonce } = generateCode({ maxUses: uses, durationDays: days, codeExpiryDay, batch }, secret);
  console.log(`${code},${nonce}`);
}
