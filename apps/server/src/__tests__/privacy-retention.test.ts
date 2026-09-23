import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { initMembership } from '../membership.js';
import { initPrivacyRetention, requestDataDeletion, runPrivacyRetention } from '../privacy-retention.js';
let db: Database.Database;
let root: string;
const now = 1_800_000_000;
const day = 86400;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'boen-retention-test-'));
  mkdirSync(join(root, 'assets'));
  mkdirSync(join(root, 'backups'));
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  initMembership(db);
  initPrivacyRetention(db);
  db.exec(`CREATE TABLE subscriptions(user_id TEXT PRIMARY KEY,tier TEXT,expires_at INTEGER,activated_at INTEGER);
    CREATE TABLE conversations(id TEXT PRIMARY KEY,user_id TEXT);
    CREATE TABLE checkpoints(thread_id TEXT,content TEXT);
    CREATE TABLE writes(thread_id TEXT,content TEXT);
    CREATE TABLE mistake_items(id TEXT PRIMARY KEY,user_id TEXT,status TEXT,updated_at INTEGER);
    CREATE TABLE mistake_assets(mistake_id TEXT REFERENCES mistake_items(id) ON DELETE CASCADE,file_path TEXT);
    CREATE TABLE payment_orders(user_id TEXT,order_id TEXT,buyer_email TEXT,checkout_url TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE membership_grants(user_id TEXT,created_at INTEGER);
    CREATE TABLE currency_ledger(user_id TEXT,created_at INTEGER);
    CREATE TABLE waffo_webhook_events(raw TEXT,note TEXT,created_at INTEGER,order_id TEXT);`);
});
afterEach(() => {
  db.close();
  const target = resolve(root);
  if (!basename(target).startsWith('boen-retention-test-') || !target.startsWith(resolve(tmpdir()))) throw new Error('Unsafe test cleanup');
  rmSync(target, { recursive: true });
});
describe('privacy retention', () => {
  it('purges only verified requests after thirty days, including saved assets and graph state', () => {
    const file = join(root, 'assets', 'image.png');
    writeFileSync(file, 'test');
    db.exec(`INSERT INTO conversations VALUES ('conversation','alice'),('other','bob');
      INSERT INTO checkpoints VALUES ('conversation','private'),('other','keep');
      INSERT INTO writes VALUES ('conversation','private');
      INSERT INTO mistake_items VALUES ('mistake','alice','analyzed',${now});
      INSERT INTO payment_orders VALUES ('alice','order','personal@example.test','url',${now},${now});`);
    db.prepare('INSERT INTO mistake_assets VALUES (?,?)').run('mistake', file);
    requestDataDeletion(db, 'alice', now);
    runPrivacyRetention(db, join(root, 'assets'), join(root, 'backups'), now + 29 * day);
    expect(existsSync(file)).toBe(true);
    runPrivacyRetention(db, join(root, 'assets'), join(root, 'backups'), now + 30 * day);
    expect(existsSync(file)).toBe(false);
    expect(db.prepare('SELECT * FROM conversations').all()).toEqual([{ id: 'other', user_id: 'bob' }]);
    expect(db.prepare('SELECT * FROM checkpoints').all()).toEqual([{ thread_id: 'other', content: 'keep' }]);
    expect(db.prepare('SELECT buyer_email FROM payment_orders').get()).toEqual({ buyer_email: null });
  });
  it('redacts old raw webhook data while retaining event audit', () => {
    db.prepare('INSERT INTO waffo_webhook_events VALUES (?,?,?,?)').run('{"email":"private"}', 'personal', now - 181 * day, 'order');
    runPrivacyRetention(db, join(root, 'assets'), join(root, 'backups'), now);
    expect(db.prepare('SELECT raw,note FROM waffo_webhook_events').get()).toEqual({ raw: '{}', note: null });
  });
  it('refuses an asset path outside the designated root and retains the retry queue', () => {
    const file = join(root, 'outside.txt');
    writeFileSync(file, 'keep');
    db.prepare('INSERT INTO privacy_file_deletions VALUES (?)').run(file);
    expect(() => runPrivacyRetention(db, join(root, 'assets'), join(root, 'backups'), now)).toThrow('outside');
    expect(existsSync(file)).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS n FROM privacy_file_deletions').get()).toEqual({ n: 1 });
  });
});
