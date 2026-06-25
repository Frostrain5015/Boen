/**
 * revoke-codes.ts —— 撤销已发出的兑换码
 *
 * 用法:
 *   npx tsx src/scripts/revoke-codes.ts --nonce <hex>            # 撤销单码
 *   npx tsx src/scripts/revoke-codes.ts --batch 1 --reason 泄露  # 撤销整批
 *
 * 写入 code_revocations 名单；兑换时命中即返回 code_disabled。
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import db from '../db.js';
const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(__dirname, '../../../../.env') });
const args = process.argv.slice(2);
function getArg(name) {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
}
const nonce = getArg('nonce');
const batch = getArg('batch');
const reason = getArg('reason') ?? null;
if (!nonce && !batch) {
    console.error('❌ 需提供 --nonce <hex> 或 --batch <号>');
    process.exit(1);
}
const stmt = db.prepare(`INSERT OR IGNORE INTO code_revocations (scope, value, reason) VALUES (?, ?, ?)`);
if (nonce) {
    stmt.run('nonce', nonce, reason);
    console.log(`✅ 已撤销单码 nonce=${nonce}`);
}
if (batch) {
    stmt.run('batch', String(batch), reason);
    console.log(`✅ 已撤销整批 batch=${batch}`);
}
