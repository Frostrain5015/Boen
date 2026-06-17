import db from './db.js';

export interface Conversation {
  id: string;
  userId: string;
  title: string;
  subject: string;
  createdAt: number;
  updatedAt: number;
}

export interface ChatMessage {
  id: number;
  conversationId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: number;
}

// ── 对话 CRUD ───────────────────────────────

export function createConversation(userId: string, title: string, subject: string): Conversation {
  const id = `conv-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const now = Math.floor(Date.now() / 1000);
  db.prepare('INSERT INTO conversations (id, user_id, title, subject, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, userId, title, subject, now, now);
  return { id, userId, title, subject, createdAt: now, updatedAt: now };
}

export function getConversations(userId: string): Conversation[] {
  const rows = db.prepare(
    'SELECT id, user_id as userId, title, subject, created_at as createdAt, updated_at as updatedAt FROM conversations WHERE user_id = ? ORDER BY updated_at DESC'
  ).all(userId) as Array<{
    id: string;
    userId: string;
    title: string;
    subject: string;
    createdAt: number;
    updatedAt: number;
  }>;
  return rows;
}

export function getConversation(id: string): Conversation | null {
  const row = db.prepare(
    'SELECT id, user_id as userId, title, subject, created_at as createdAt, updated_at as updatedAt FROM conversations WHERE id = ?'
  ).get(id) as {
    id: string;
    userId: string;
    title: string;
    subject: string;
    createdAt: number;
    updatedAt: number;
  } | undefined;
  return row ?? null;
}

export function updateConversationTitle(id: string, title: string) {
  const now = Math.floor(Date.now() / 1000);
  db.prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?').run(title, now, id);
}

export function deleteConversation(id: string) {
  db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
}

// ── 消息 CRUD ───────────────────────────────

export function addMessage(conversationId: string, role: 'user' | 'assistant' | 'system', content: string): ChatMessage {
  const now = Math.floor(Date.now() / 1000);
  const result = db.prepare('INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)')
    .run(conversationId, role, content, now);

  // 更新对话更新时间
  db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, conversationId);

  return {
    id: Number(result.lastInsertRowid),
    conversationId,
    role,
    content,
    createdAt: now,
  };
}

export function getMessages(conversationId: string): ChatMessage[] {
  const rows = db.prepare(
    'SELECT id, conversation_id as conversationId, role, content, created_at as createdAt FROM messages WHERE conversation_id = ? ORDER BY created_at ASC'
  ).all(conversationId) as Array<{
    id: number;
    conversationId: string;
    role: string;
    content: string;
    createdAt: number;
  }>;
  return rows.map(r => ({ ...r, role: r.role as 'user' | 'assistant' | 'system' }));
}

export function getRecentMessages(conversationId: string, limit: number): ChatMessage[] {
  const rows = db.prepare(
    'SELECT id, conversation_id as conversationId, role, content, created_at as createdAt FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?'
  ).all(conversationId, limit) as Array<{
    id: number;
    conversationId: string;
    role: string;
    content: string;
    createdAt: number;
  }>;
  return rows.reverse().map(r => ({ ...r, role: r.role as 'user' | 'assistant' | 'system' }));
}

export function deleteMessages(conversationId: string) {
  db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(conversationId);
}
