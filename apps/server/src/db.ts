import Database from 'better-sqlite3';
import { join } from 'node:path';
import { DATA_DIR } from './paths.js';

const db = new Database(join(DATA_DIR, 'boen.db'));

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

// ── Mistake notebook ─────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS mistake_items (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    subject TEXT NOT NULL,
    grade TEXT NOT NULL,
    source_type TEXT NOT NULL CHECK(source_type IN ('image', 'canvas', 'text')),
    status TEXT NOT NULL DEFAULT 'processing' CHECK(status IN ('processing', 'analyzed', 'needs_review', 'archived')),
    title TEXT NOT NULL DEFAULT '',
    prompt_text TEXT NOT NULL DEFAULT '',
    original_text TEXT,
    student_answer TEXT,
    correct_answer TEXT,
    explanation TEXT,
    error_type TEXT,
    error_reason TEXT,
    analysis_confidence REAL DEFAULT 0,
    ocr_provider TEXT,
    ocr_raw TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    proficiency_applied_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_mistakes_user_updated ON mistake_items(user_id, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_mistakes_filter ON mistake_items(user_id, subject, grade, status);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS mistake_assets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mistake_id TEXT NOT NULL,
    asset_kind TEXT NOT NULL DEFAULT 'original' CHECK(asset_kind IN ('original', 'annotated')),
    mime_type TEXT NOT NULL,
    file_path TEXT NOT NULL,
    file_size INTEGER NOT NULL DEFAULT 0,
    width INTEGER,
    height INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    FOREIGN KEY (mistake_id) REFERENCES mistake_items(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_mistake_assets_item ON mistake_assets(mistake_id);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS mistake_kp_map (
    mistake_id TEXT NOT NULL,
    kg_node_id INTEGER NOT NULL,
    unit_id INTEGER,
    role TEXT NOT NULL DEFAULT 'related' CHECK(role IN ('primary', 'related', 'prerequisite')),
    confidence REAL NOT NULL DEFAULT 0,
    before_score REAL,
    after_score REAL,
    evidence_json TEXT,
    PRIMARY KEY (mistake_id, kg_node_id),
    FOREIGN KEY (mistake_id) REFERENCES mistake_items(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_mistake_kp_node ON mistake_kp_map(kg_node_id);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS mistake_style_features (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mistake_id TEXT NOT NULL,
    question_type TEXT NOT NULL DEFAULT '',
    difficulty TEXT NOT NULL DEFAULT 'medium',
    scenario_type TEXT NOT NULL DEFAULT '',
    reasoning_pattern TEXT NOT NULL DEFAULT '',
    distractor_pattern TEXT,
    presentation_features TEXT,
    style_text TEXT NOT NULL DEFAULT '',
    embedding BLOB,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    FOREIGN KEY (mistake_id) REFERENCES mistake_items(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_mistake_style_item ON mistake_style_features(mistake_id);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS mistake_proficiency_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mistake_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    kg_node_id INTEGER NOT NULL,
    before_score REAL,
    after_score REAL,
    before_correct_count REAL,
    before_total_count REAL,
    after_correct_count REAL,
    after_total_count REAL,
    role TEXT NOT NULL DEFAULT 'related',
    confidence REAL NOT NULL DEFAULT 0,
    applied_at INTEGER NOT NULL DEFAULT (unixepoch()),
    reverted_at INTEGER,
    FOREIGN KEY (mistake_id) REFERENCES mistake_items(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_mistake_prof_user_node ON mistake_proficiency_events(user_id, kg_node_id, applied_at);
  CREATE INDEX IF NOT EXISTS idx_mistake_prof_item ON mistake_proficiency_events(mistake_id);
`);

// ── 订阅系统 ─────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS subscriptions (
    user_id TEXT PRIMARY KEY,
    tier TEXT NOT NULL DEFAULT 'free',
    activated_at INTEGER,
    expires_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS daily_chat_usage (
    user_id TEXT NOT NULL,
    date TEXT NOT NULL,
    message_count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, date)
  );
  CREATE INDEX IF NOT EXISTS idx_daily_usage_user_date ON daily_chat_usage(user_id, date);
`);

// ── Mistake notebook 迁移：答案匹配度与正确性标记 ──
// 做对的题（匹配度≥0.8）前端不再作为错题展示，但题型风格仍沉淀
{
  const cols = db.prepare(`PRAGMA table_info(mistake_items)`).all() as Array<{ name: string }>;
  const has = (name: string) => cols.some((c) => c.name === name);
  if (!has('answer_match_score')) {
    db.exec(`ALTER TABLE mistake_items ADD COLUMN answer_match_score REAL NOT NULL DEFAULT 0`);
  }
  if (!has('is_correct')) {
    db.exec(`ALTER TABLE mistake_items ADD COLUMN is_correct INTEGER NOT NULL DEFAULT 0`);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_mistakes_correct ON mistake_items(user_id, is_correct)`);
}

export default db;
