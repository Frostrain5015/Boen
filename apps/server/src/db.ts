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

// Elo 列迁移
const profColumnsMigration = db.prepare(`PRAGMA table_info(user_kp_proficiency)`).all() as Array<{ name: string }>;
const hasProfCol = (name: string) => profColumnsMigration.some((col) => col.name === name);
if (!hasProfCol('rating')) {
  db.exec(`ALTER TABLE user_kp_proficiency ADD COLUMN rating REAL DEFAULT 50`);
}
if (!hasProfCol('rating_sigma')) {
  db.exec(`ALTER TABLE user_kp_proficiency ADD COLUMN rating_sigma REAL DEFAULT 20`);
}
// 将已有的 weighted_score 回填到 rating
db.exec(`UPDATE user_kp_proficiency SET rating = weighted_score WHERE rating = 50 AND weighted_score != 50`);

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

const examSessionColumns = db.prepare(`PRAGMA table_info(exam_sessions)`).all() as Array<{ name: string }>;
const hasExamSessionColumn = (name: string) => examSessionColumns.some((col) => col.name === name);
if (!hasExamSessionColumn('blueprint')) {
  db.exec(`ALTER TABLE exam_sessions ADD COLUMN blueprint TEXT`);
}
if (!hasExamSessionColumn('quality_report')) {
  db.exec(`ALTER TABLE exam_sessions ADD COLUMN quality_report TEXT`);
}
if (!hasExamSessionColumn('grading_checkpoint')) {
  db.exec(`ALTER TABLE exam_sessions ADD COLUMN grading_checkpoint TEXT`);
}

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

// 全服务器「出题风格技能库」：跨用户沉淀的去重风格技能（按 学科+年级 检索）
db.exec(`
  CREATE TABLE IF NOT EXISTS style_skills (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject TEXT NOT NULL,
    grade TEXT NOT NULL,
    kg_node_id INTEGER,
    question_type TEXT NOT NULL DEFAULT '',
    difficulty TEXT NOT NULL DEFAULT 'medium',
    skill_text TEXT NOT NULL,
    embedding BLOB NOT NULL,
    reinforce_count INTEGER NOT NULL DEFAULT 1,
    distinct_user_count INTEGER NOT NULL DEFAULT 1,
    source_user_ids TEXT,
    quality_weight REAL NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    last_seen_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS idx_style_skills_bucket ON style_skills(subject, grade);
  CREATE INDEX IF NOT EXISTS idx_style_skills_node ON style_skills(kg_node_id);
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

// mistake_proficiency_events Elo 列迁移
const mpeColsMigration = db.prepare(`PRAGMA table_info(mistake_proficiency_events)`).all() as Array<{ name: string }>;
const hasMpeCol = (name: string) => mpeColsMigration.some((col) => col.name === name);
if (!hasMpeCol('before_rating')) db.exec(`ALTER TABLE mistake_proficiency_events ADD COLUMN before_rating REAL`);
if (!hasMpeCol('after_rating')) db.exec(`ALTER TABLE mistake_proficiency_events ADD COLUMN after_rating REAL`);
if (!hasMpeCol('before_sigma')) db.exec(`ALTER TABLE mistake_proficiency_events ADD COLUMN before_sigma REAL`);
if (!hasMpeCol('after_sigma')) db.exec(`ALTER TABLE mistake_proficiency_events ADD COLUMN after_sigma REAL`);

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

// ── 兑换码：消费流水 + 撤销 denylist ─────────────────────────
// 兑换码采用「自描述签名码」：可复用?/面值天数/有效期/批次等条款编码进码内并由 HMAC 签名，
// 服务端离线可验，无需在库中预存码。库里只保留逻辑上不属于码本身的「状态」：
//   1) code_redemptions —— 消费流水：审计 + PK(nonce,user_id) 防同人重复兑换；
//      限次上限来自码内 maxUses，已用次数 = COUNT(*) WHERE nonce=?。
//   2) code_revocations —— 撤销名单：按单码 nonce 或整批 batch 作废（batch 在码内，无需存已发码）。
db.exec(`
  CREATE TABLE IF NOT EXISTS code_redemptions (
    nonce         TEXT NOT NULL,
    user_id       TEXT NOT NULL,
    duration_days INTEGER NOT NULL,
    granted_until INTEGER NOT NULL,
    created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (nonce, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_code_redemptions_nonce ON code_redemptions(nonce);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS code_revocations (
    scope      TEXT NOT NULL CHECK(scope IN ('nonce', 'batch')),
    value      TEXT NOT NULL,
    reason     TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (scope, value)
  );
`);

// ── 星月积分（局内货币）───────────────────────────────────────
// 用户做结构化学习/考试 → 知识点 Elo 熟练度提升 → 按提升量并以学科总熟练度线性倍增
// 结算积分；积分累积可兑换皓月卡/星耀卡会员。三张表：
//   1) user_currency        —— 余额（单行/用户）+ 累计赚/花，便于审计与展示。
//   2) currency_ledger      —— 流水账本（earn/spend/grant/adjust），镜像 code_redemptions 审计模式。
//   3) currency_daily_earn  —— 每日已赚计数，用于日上限封顶（镜像 daily_chat_usage）。
db.exec(`
  CREATE TABLE IF NOT EXISTS user_currency (
    user_id      TEXT PRIMARY KEY,
    balance      INTEGER NOT NULL DEFAULT 0,
    total_earned INTEGER NOT NULL DEFAULT 0,
    total_spent  INTEGER NOT NULL DEFAULT 0,
    updated_at   INTEGER NOT NULL DEFAULT (unixepoch())
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS currency_ledger (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       TEXT NOT NULL,
    type          TEXT NOT NULL CHECK(type IN ('earn', 'spend', 'grant', 'adjust')),
    amount        INTEGER NOT NULL,
    balance_after INTEGER NOT NULL,
    reason        TEXT,
    ref_id        TEXT,
    created_at    INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS idx_currency_ledger_user ON currency_ledger(user_id, created_at DESC);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS currency_daily_earn (
    user_id TEXT NOT NULL,
    date    TEXT NOT NULL,
    earned  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, date)
  );
`);

// ── 对话记忆摘要 ──────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS conversation_summaries (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    subject TEXT NOT NULL DEFAULT 'math',
    summary TEXT NOT NULL,
    topics TEXT NOT NULL DEFAULT '',
    proficiency_level TEXT NOT NULL DEFAULT 'unknown',
    unresolved_questions TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    embedding BLOB
  );
  CREATE INDEX IF NOT EXISTS idx_cs_user_subject ON conversation_summaries(user_id, subject);
  CREATE INDEX IF NOT EXISTS idx_cs_created ON conversation_summaries(created_at DESC);
`);

export default db;
