import { join } from 'node:path';
import db from '../db.js';
import { ASSET_ROOT, DATA_DIR } from '../paths.js';
import { initPrivacyRetention, requestDataDeletion, runPrivacyRetention } from '../privacy-retention.js';
initPrivacyRetention(db);
const args = process.argv.slice(2);
if (args[0] === '--request-user' && args[1] && args[2] === '--identity-verified') {
  requestDataDeletion(db, args[1]);
  console.log('Verified deletion request scheduled; purge deadline is thirty days.');
} else if (args[0] === '--run') {
  runPrivacyRetention(db, ASSET_ROOT, join(DATA_DIR, 'backups'));
  console.log('Retention completed.');
} else {
  console.log('Usage: --request-user USER_ID --identity-verified | --run');
  process.exitCode = 1;
}
