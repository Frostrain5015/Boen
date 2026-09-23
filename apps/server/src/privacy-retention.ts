import type Database from 'better-sqlite3';
import { existsSync, lstatSync, readdirSync, realpathSync, unlinkSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

const DAY = 86400;
export function initPrivacyRetention(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS privacy_deletion_requests (
    user_id TEXT PRIMARY KEY, requested_at INTEGER NOT NULL, purge_after INTEGER NOT NULL, completed_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS privacy_file_deletions (path TEXT PRIMARY KEY);`);
  db.exec(`CREATE TABLE IF NOT EXISTS privacy_retention_holds (user_id TEXT PRIMARY KEY, reason TEXT NOT NULL);`);
}

/** Only use after verifying an explicit user request and resolving active billing. */
export function requestDataDeletion(db: Database.Database, userId: string, now = Math.floor(Date.now() / 1000)): void {
  const paid = db.prepare("SELECT 1 FROM waffo_subscriptions WHERE user_id=? AND status != 'canceled'").get(userId);
  if (paid) throw new Error('Cancel and reconcile existing subscriptions before scheduling deletion');
  db.prepare(`INSERT INTO privacy_deletion_requests(user_id,requested_at,purge_after) VALUES (?,?,?)
    ON CONFLICT(user_id) DO NOTHING`).run(userId, now, now + 30 * DAY);
}

function columns(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map(row => row.name);
}
function hasTable(db: Database.Database, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

export function runPrivacyRetention(db: Database.Database, assetRoot: string, backupRoot: string, now = Math.floor(Date.now() / 1000)): void {
  initPrivacyRetention(db);
  const retained = new Set(['payment_orders', 'payment_consents', 'waffo_subscriptions', 'membership_grants', 'membership_reward_ledger', 'currency_ledger', 'membership_trial_history', 'privacy_deletion_requests', 'privacy_retention_holds']);
  db.transaction(() => {
    // Raw delivery data is not needed for long-term financial audit or replay deduplication.
    db.prepare("UPDATE waffo_webhook_events SET raw='{}',note=NULL WHERE created_at<? AND raw!='{}'").run(now - 180 * DAY);
    const requests = db.prepare('SELECT user_id FROM privacy_deletion_requests WHERE purge_after<=? AND completed_at IS NULL').all(now) as Array<{ user_id: string }>;
    for (const { user_id: userId } of requests) {
      db.prepare(`INSERT OR IGNORE INTO privacy_file_deletions(path)
        SELECT a.file_path FROM mistake_assets a JOIN mistake_items m ON m.id=a.mistake_id WHERE m.user_id=?`).run(userId);
      for (const table of ['writes', 'checkpoints']) {
        if (hasTable(db, table)) db.prepare(`DELETE FROM "${table}" WHERE thread_id IN (SELECT id FROM conversations WHERE user_id=?)`).run(userId);
      }
      // Remove learned examples derived from this user, including their text and identifiers.
      if (hasTable(db, 'style_skills')) {
        const skills = db.prepare('SELECT id,source_user_ids FROM style_skills WHERE source_user_ids IS NOT NULL').all() as Array<{ id: number; source_user_ids: string }>;
        for (const skill of skills) {
          try {
            const users: unknown = JSON.parse(skill.source_user_ids);
            if (Array.isArray(users) && users.includes(userId)) db.prepare('DELETE FROM style_skills WHERE id=?').run(skill.id);
          } catch { if (skill.source_user_ids === userId) db.prepare('DELETE FROM style_skills WHERE id=?').run(skill.id); }
        }
      }
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>;
      for (const { name } of tables) {
        if (!/^[a-z_]+$/.test(name) || retained.has(name) || !columns(db, name).includes('user_id')) continue;
        db.prepare(`DELETE FROM "${name}" WHERE user_id=?`).run(userId);
      }
      db.prepare('UPDATE payment_orders SET buyer_email=NULL,checkout_url=NULL WHERE user_id=?').run(userId);
      db.prepare(`UPDATE waffo_webhook_events SET raw='{}',note=NULL WHERE order_id IN (SELECT order_id FROM payment_orders WHERE user_id=?)`).run(userId);
      db.prepare('UPDATE privacy_deletion_requests SET completed_at=? WHERE user_id=?').run(now, userId);
    }
    // A removed mistake stays recoverable for thirty days, then its content and assets are removed.
    db.prepare(`INSERT OR IGNORE INTO privacy_file_deletions(path) SELECT a.file_path FROM mistake_assets a
      JOIN mistake_items m ON m.id=a.mistake_id WHERE m.status='archived' AND m.updated_at<?`).run(now - 30 * DAY);
    db.prepare("DELETE FROM mistake_items WHERE status='archived' AND updated_at<?").run(now - 30 * DAY);
    const anniversary = new Date(now * 1000);
    anniversary.setUTCFullYear(anniversary.getUTCFullYear() - 7);
    const cutoff = Math.floor(anniversary.getTime() / 1000);
    for (const table of ['payment_orders', 'membership_grants', 'membership_reward_ledger', 'currency_ledger']) {
      const dateColumn = columns(db, table).includes('updated_at') ? 'updated_at' : 'created_at';
      db.prepare(`DELETE FROM "${table}" WHERE ${dateColumn}<? AND NOT EXISTS (SELECT 1 FROM privacy_retention_holds h WHERE h.user_id="${table}".user_id) AND NOT EXISTS (
        SELECT 1 FROM waffo_subscriptions s WHERE s.user_id="${table}".user_id AND (s.status!='canceled' OR s.period_end>=?)
      ) AND NOT EXISTS (SELECT 1 FROM membership_reward_accounts r WHERE r.user_id="${table}".user_id AND (r.balance_seconds>0 OR r.expires_at>?))`).run(cutoff, cutoff, cutoff);
    }
    db.prepare("DELETE FROM waffo_subscriptions WHERE status='canceled' AND period_end<? AND updated_at<? AND user_id NOT IN (SELECT user_id FROM privacy_retention_holds)").run(cutoff, cutoff);
    db.prepare(`DELETE FROM payment_consents WHERE accepted_at<? AND user_id NOT IN (SELECT user_id FROM privacy_retention_holds)
      AND user_id NOT IN (SELECT user_id FROM waffo_subscriptions)`).run(cutoff);
    db.prepare(`DELETE FROM membership_trial_history WHERE user_id IN (SELECT user_id FROM privacy_deletion_requests WHERE completed_at<?)
      AND user_id NOT IN (SELECT user_id FROM privacy_retention_holds)`).run(cutoff);
    db.prepare("DELETE FROM privacy_deletion_requests WHERE completed_at<? AND user_id NOT IN (SELECT user_id FROM privacy_retention_holds)").run(cutoff);
    db.prepare('DELETE FROM waffo_webhook_events WHERE created_at<? AND order_id NOT IN (SELECT order_id FROM waffo_subscriptions)').run(cutoff);
  })();
  // A durable queue makes filesystem failures retryable without orphaning untracked assets.
  const files = db.prepare('SELECT path FROM privacy_file_deletions').all() as Array<{ path: string }>;
  for (const { path } of files) {
    deleteContainedFile(assetRoot, path);
    db.prepare('DELETE FROM privacy_file_deletions WHERE path=?').run(path);
  }
  if (existsSync(backupRoot)) {
    for (const name of readdirSync(backupRoot)) {
      if (!/^boen-\d{8}T\d{6}Z\.db$/.test(name)) continue;
      const path = join(backupRoot, name);
      if (lstatSync(path).mtimeMs / 1000 < now - 30 * DAY) deleteContainedFile(backupRoot, path);
    }
  }
}

function deleteContainedFile(root: string, file: string): void {
  if (!existsSync(file)) return;
  const target = realpathSync(file);
  const directory = realpathSync(root);
  const rel = relative(directory, target);
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || lstatSync(file).isSymbolicLink() || !lstatSync(target).isFile()) {
    throw new Error('Refused retention deletion outside designated data directory');
  }
  unlinkSync(resolve(target));
}
