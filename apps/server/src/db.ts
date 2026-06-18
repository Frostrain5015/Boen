import Database from 'better-sqlite3';
import { join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';

const DB_DIR = join(process.cwd(), 'data');
if (!existsSync(DB_DIR)) mkdirSync(DB_DIR, { recursive: true });

const db = new Database(join(DB_DIR, 'boen.db'));

// 启用 WAL 模式提升并发性能
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── 对话表 ──────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '新对话',
    subject TEXT DEFAULT 'math',
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id);
  CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at DESC);
`);

// ── 消息表 ──────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
  CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
`);

// ── 向量表（使用 sqlite-vss）─────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS embeddings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    message_id INTEGER NOT NULL,
    embedding BLOB NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_embeddings_conversation ON embeddings(conversation_id);
`);

// ── 课程知识库（人教版）─────────────────────
// 一册教材
db.exec(`
  CREATE TABLE IF NOT EXISTS curriculum_textbooks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject TEXT NOT NULL,                 -- chinese | math | english | science
    grade TEXT NOT NULL,                   -- '1'..'9'
    volume TEXT NOT NULL DEFAULT '全册',    -- 上册 | 下册 | 全册
    publisher TEXT NOT NULL DEFAULT '人教版',
    version TEXT,                          -- 教材版本/年份
    source_url TEXT,                       -- 数据来源，便于核对
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE(subject, grade, volume, publisher)
  );
`);

// 教材内章节树：parent_id 自引用 + seq 保留编排顺序
db.exec(`
  CREATE TABLE IF NOT EXISTS curriculum_units (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    textbook_id INTEGER NOT NULL,
    parent_id INTEGER,                     -- 顶层单元为 NULL
    seq INTEGER NOT NULL DEFAULT 0,        -- 同级排序
    title TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'unit',     -- unit | chapter | lesson | section
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    FOREIGN KEY (textbook_id) REFERENCES curriculum_textbooks(id) ON DELETE CASCADE,
    FOREIGN KEY (parent_id) REFERENCES curriculum_units(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_units_textbook ON curriculum_units(textbook_id);
  CREATE INDEX IF NOT EXISTS idx_units_parent ON curriculum_units(parent_id);
`);

// 知识点条目（独立于教材结构，供未来按薄弱点自适应辅导）
db.exec(`
  CREATE TABLE IF NOT EXISTS knowledge_points (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject TEXT NOT NULL,
    grade TEXT,                            -- 标称年级，可空
    code TEXT,                             -- 课标编码/自定义编码，可空
    title TEXT NOT NULL,
    description TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS idx_kp_subject_grade ON knowledge_points(subject, grade);
`);

// 章节 ↔ 知识点 多对多映射
db.exec(`
  CREATE TABLE IF NOT EXISTS unit_knowledge_map (
    unit_id INTEGER NOT NULL,
    knowledge_point_id INTEGER NOT NULL,
    PRIMARY KEY (unit_id, knowledge_point_id),
    FOREIGN KEY (unit_id) REFERENCES curriculum_units(id) ON DELETE CASCADE,
    FOREIGN KEY (knowledge_point_id) REFERENCES knowledge_points(id) ON DELETE CASCADE
  );
`);

// 向量表：ref_type+ref_id 指向 unit 或 kp；带 subject/grade 供检索前硬过滤
db.exec(`
  CREATE TABLE IF NOT EXISTS curriculum_embeddings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ref_type TEXT NOT NULL CHECK(ref_type IN ('unit', 'kp')),
    ref_id INTEGER NOT NULL,
    subject TEXT NOT NULL,
    grade TEXT,
    content TEXT NOT NULL,
    embedding BLOB NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE(ref_type, ref_id)
  );
  CREATE INDEX IF NOT EXISTS idx_cemb_filter ON curriculum_embeddings(subject, grade);
`);

export default db;
