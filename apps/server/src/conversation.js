import db from './db.js';
// ── 对话 CRUD ───────────────────────────────
export function createConversation(userId, title, subject) {
    const id = `conv-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const now = Math.floor(Date.now() / 1000);
    db.prepare('INSERT INTO conversations (id, user_id, title, subject, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, userId, title, subject, now, now);
    return { id, userId, title, subject, createdAt: now, updatedAt: now };
}
export function getConversations(userId) {
    const rows = db.prepare('SELECT id, user_id as userId, title, subject, created_at as createdAt, updated_at as updatedAt FROM conversations WHERE user_id = ? ORDER BY updated_at DESC').all(userId);
    return rows;
}
export function getConversation(id) {
    const row = db.prepare('SELECT id, user_id as userId, title, subject, created_at as createdAt, updated_at as updatedAt FROM conversations WHERE id = ?').get(id);
    return row ?? null;
}
export function updateConversationTitle(id, title) {
    const now = Math.floor(Date.now() / 1000);
    db.prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?').run(title, now, id);
}
export function deleteConversation(id) {
    db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(id);
    db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
}
// ── 消息 CRUD ───────────────────────────────
export function addMessage(conversationId, role, content) {
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
export function getMessages(conversationId) {
    const rows = db.prepare('SELECT id, conversation_id as conversationId, role, content, created_at as createdAt FROM messages WHERE conversation_id = ? ORDER BY created_at ASC').all(conversationId);
    return rows.map(r => ({ ...r, role: r.role }));
}
export function getRecentMessages(conversationId, limit) {
    const rows = db.prepare('SELECT id, conversation_id as conversationId, role, content, created_at as createdAt FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?').all(conversationId, limit);
    return rows.reverse().map(r => ({ ...r, role: r.role }));
}
export function deleteMessages(conversationId) {
    db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(conversationId);
}
/**
 * 更新某条系统消息的内容（按 conversation_id 和 toolCallId 匹配 __boen_type 消息）。
 * 用于答题后把判分结果写回题目消息，避免状态分裂。
 */
export function updateQuestionMessage(conversationId, toolCallId, content) {
    const pattern = `%__boen_type%question%${toolCallId}%`;
    const row = db.prepare(`SELECT id FROM messages WHERE conversation_id = ? AND role = 'system' AND content LIKE ? LIMIT 1`).get(conversationId, pattern);
    if (row) {
        const now = Math.floor(Date.now() / 1000);
        db.prepare('UPDATE messages SET content = ?, created_at = ? WHERE id = ?').run(content, now, row.id);
        db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, conversationId);
    }
}
