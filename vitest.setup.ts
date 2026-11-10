import { existsSync, mkdtempSync, rmdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, vi } from 'vitest';

let directory: string | undefined;

vi.mock('./apps/server/src/paths.js', async (importOriginal) => {
  const paths = await importOriginal<typeof import('./apps/server/src/paths.js')>();
  directory = mkdtempSync(join(tmpdir(), 'boen-test-db-'));
  return { ...paths, DATA_DIR: directory, ASSET_ROOT: directory };
});

beforeAll(async () => {
  const { ensureKnowledgeGraphTables } = await import('./apps/server/src/knowledge-graph.js');
  ensureKnowledgeGraphTables();
});

afterAll(async () => {
  if (!directory) return;
  const filename = join(directory, 'boen.db');
  if (existsSync(filename)) {
    const { default: db } = await import('./apps/server/src/db.js');
    db.close();
    unlinkSync(filename);
  }
  rmdirSync(directory);
});
