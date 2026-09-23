import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { DATA_DIR } from '../paths.js';
// Open the existing database directly: importing db.ts would migrate before backing up.
const db = new Database(join(DATA_DIR, 'boen.db'), { readonly: true, fileMustExist: true });
const directory = join(DATA_DIR, 'backups');
mkdirSync(directory, { recursive: true });
const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
const target = join(directory, `boen-${timestamp}.db`);
await db.backup(target);
db.close();
console.log('SQLite backup completed:', target);
