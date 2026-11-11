import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { expect, it } from 'vitest';
import { getLearningGrade, initLearningProfiles, learningProfileRoutes } from '../learning-profile.js';

const url = '/api/account/learning-profile';
const headers = (user: string) => ({ Authorization: `Bearer ${user}`, 'Content-Type': 'application/json' });

function makeApp(db: Database.Database) {
  initLearningProfiles(db);
  const app = new Hono();
  app.route(url, learningProfileRoutes(db, async c => {
    const token = c.req.header('authorization');
    if (token === 'Bearer alice') return 'alice';
    if (token === 'Bearer bob') return 'bob';
    return null;
  }));
  return app;
}

it('requires an explicit valid grade and uses the authenticated account', async () => {
  const db = new Database(':memory:');
  try {
    const app = makeApp(db);
    expect((await app.request(url)).status).toBe(401);
    expect((await app.request(url, { method: 'PUT', body: '{"grade":"4"}' })).status).toBe(401);
    const empty = await app.request(url, { headers: headers('alice') });
    expect(empty.headers.get('Cache-Control')).toBe('no-store');
    expect(await empty.json()).toEqual({ grade: null });

    for (const body of ['{"grade":8}', '{"grade":"10"}', '{"grade":"4","userId":"bob"}', '{']) {
      expect((await app.request(url, { method: 'PUT', headers: headers('alice'), body })).status).toBe(400);
    }
    expect(getLearningGrade(db, 'alice')).toBeNull();
    const saved = await app.request(url, { method: 'PUT', headers: headers('alice'), body: '{"grade":"4"}' });
    expect(await saved.json()).toEqual({ grade: '4' });
    expect(await (await app.request(url, { headers: headers('bob') })).json()).toEqual({ grade: null });
  } finally {
    db.close();
  }
});

it('restores the latest explicitly selected grade after reopening SQLite', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'boen-learning-profile-'));
  const path = join(directory, 'profile.db');
  let db = new Database(path);
  try {
    const app = makeApp(db);
    for (const grade of ['4', 'college']) {
      const response = await app.request(url, { method: 'PUT', headers: headers('alice'), body: JSON.stringify({ grade }) });
      expect(response.status).toBe(200);
    }
    db.close();
    db = new Database(path);
    expect(await (await makeApp(db).request(url, { headers: headers('alice') })).json()).toEqual({ grade: 'college' });
  } finally {
    if (db.open) db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
