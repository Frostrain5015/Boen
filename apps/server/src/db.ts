import Database from 'better-sqlite3';
import { join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';

const DB_DIR = join(process.cwd(), 'data');
if (!existsSync(DB_DIR)) mkdirSync(DB_DIR, { recursive: true });

const db = new Database(join(DB_DIR, 'boen.db'));

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

// ── 向量表 ──────────────────────────────────
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

// ── 课程知识库 ──────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS curriculum_textbooks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject TEXT NOT NULL,
    grade TEXT NOT NULL,
    volume TEXT NOT NULL DEFAULT '全册',
    publisher TEXT NOT NULL DEFAULT '人教版',
    version TEXT,
    source_url TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE(subject, grade, volume, publisher)
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS curriculum_units (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    textbook_id INTEGER NOT NULL,
    parent_id INTEGER,
    seq INTEGER NOT NULL DEFAULT 0,
    title TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'unit',
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    FOREIGN KEY (textbook_id) REFERENCES curriculum_textbooks(id) ON DELETE CASCADE,
    FOREIGN KEY (parent_id) REFERENCES curriculum_units(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_units_textbook ON curriculum_units(textbook_id);
  CREATE INDEX IF NOT EXISTS idx_units_parent ON curriculum_units(parent_id);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS knowledge_points (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject TEXT NOT NULL,
    grade TEXT,
    code TEXT,
    title TEXT NOT NULL,
    description TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS idx_kp_subject_grade ON knowledge_points(subject, grade);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS unit_knowledge_map (
    unit_id INTEGER NOT NULL,
    knowledge_point_id INTEGER NOT NULL,
    PRIMARY KEY (unit_id, knowledge_point_id),
    FOREIGN KEY (unit_id) REFERENCES curriculum_units(id) ON DELETE CASCADE,
    FOREIGN KEY (knowledge_point_id) REFERENCES knowledge_points(id) ON DELETE CASCADE
  );
`);

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

// ── 知识画像：用户知识点熟练度 ──────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS user_kp_proficiency (
    user_id TEXT NOT NULL,
    kg_node_id INTEGER NOT NULL,
    correct_count INTEGER DEFAULT 0,
    total_count INTEGER DEFAULT 0,
    weighted_score REAL DEFAULT 0,
    last_updated INTEGER DEFAULT (unixepoch()),
    PRIMARY KEY (user_id, kg_node_id)
  );
  CREATE INDEX IF NOT EXISTS idx_kp_prof_user ON user_kp_proficiency(user_id);
`);

// ── 复习课程记录 ────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS review_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    subject TEXT NOT NULL,
    grade TEXT,
    topic TEXT NOT NULL,
    sections_covered TEXT,
    total_questions INTEGER DEFAULT 0,
    correct_answers INTEGER DEFAULT 0,
    overall_score REAL DEFAULT 0,
    started_at INTEGER DEFAULT (unixepoch()),
    completed_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_review_user ON review_sessions(user_id);
`);

// ── 考试会话 ────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS exam_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    subject TEXT NOT NULL,
    grade TEXT,
    title TEXT,
    questions TEXT NOT NULL,
    total_score REAL NOT NULL DEFAULT 100,
    duration_minutes INTEGER DEFAULT 45,
    status TEXT NOT NULL DEFAULT 'pending',
    answers TEXT,
    results TEXT,
    created_at INTEGER DEFAULT (unixepoch()),
    submitted_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_exam_user ON exam_sessions(user_id);
`);

export default db;
