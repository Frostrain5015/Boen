/**
 * 共享路径常量 — 基于 __dirname，不依赖 process.cwd()
 *
 * 修复审计 C3：此前 db.ts / mistakes.ts / demo-kg.ts 用 process.cwd() 定位 data/，
 * 而 kg-weights.ts / kg-enrich.ts 用 __dirname，导致不同启动方式操作不同 DB 文件。
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** apps/server/data — 数据库与运行时数据 */
export const DATA_DIR = join(__dirname, '../data');
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

/** 错题本附件存储 */
export const ASSET_ROOT = join(DATA_DIR, 'mistake-assets');
if (!existsSync(ASSET_ROOT)) mkdirSync(ASSET_ROOT, { recursive: true });

/** 课程知识库 JSON 文件目录 */
export const CURRICULUM_DIR = join(__dirname, '../curriculum');
