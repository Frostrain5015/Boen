import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
config({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });
const address = process.env.VITE_LEGAL_CONTACT_ADDRESS?.trim();
const issues = [];
if (!address || /placeholder|待填|示例|replace-with|\[.*\]/i.test(address)) issues.push('VITE_LEGAL_CONTACT_ADDRESS must contain the operator-supplied public contact address.');
if (process.env.WAFFO_ALLOW_TEST_CHECKOUT === 'true') issues.push('Disable WAFFO_ALLOW_TEST_CHECKOUT before public deployment.');
if (issues.length) {
  console.error(issues.join('\n'));
  process.exitCode = 1;
} else console.log('Public legal/contact and checkout release checks passed.');
