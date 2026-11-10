/**
 * game.ts —— 知识跑酷：出题引擎（题目池 + LLM 生成 + 课程知识点选题 + 出题账本）
 *
 * 纯逻辑（解析 / 洗牌 / 题库）在 game-core.ts，可脱离数据库单测；
 * 这里负责「选知识点 → 调模型 → 分池预热 → 记下签发过的题」。
 *
 * **出题账本**是本模块的安全基石：每道题发给学生前先落库正确答案，
 * 结算时按 questionId 重新核对，客户端上报的分数一律不采信。
 */
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { SystemMessage, HumanMessage } from '@langchain/core/messages';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GAME_DAILY_SIZE, GAME_ENDLESS_LIMIT, GAME_QUESTION_BONUS, GAME_STAGE_SIZE, type GameMode } from '@boen/shared';
import db from './db.js';
import { beijingDateStr } from './game-time.js';
import {
  LANE_COUNT,
  gradeLabel,
  parseLLMQuestion,
  shuffleByIndex,
  getFallbackQuestion,
  newQuestionId,
  registerExtraBank,
  normalizeSubject,
  type GameQuestion,
  type GameSubject,
} from './game-core.js';

export * from './game-core.js';

/** 一道题的签发上下文 */
export interface IssueContext {
  userId?: string | null;
  roundId?: string;
  grade?: string;
  mode?: GameMode;
  stage?: number;
  preferKgNodeIds?: number[];
}

export function gameSessionId(userId: string, roundId: string): string {
  return 'g_' + createHash('sha256').update(userId).update('\0').update(roundId).digest('hex');
}

/* ══════════════════════════════════════════════════════════════
 * 出题账本：记录签发过的题（含正确答案），供结算核对
 * ══════════════════════════════════════════════════════════════ */

export function issueGameQuestion(q: GameQuestion, subject: GameSubject, ctx: IssueContext): GameQuestion {
  if (!ctx.userId || !ctx.roundId) return q;
  const issued = { ...q, id: newQuestionId() };
  db.prepare(`
    INSERT INTO game_question_issue
      (id, user_id, subject, grade, mode, stem, options, correct_key, explain, kg_node_id, round_id, stage, challenge_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    issued.id, ctx.userId, subject, ctx.grade ?? null, ctx.mode ?? 'endless',
    q.stem, JSON.stringify(q.options), q.correctKey, q.explain ?? null, q.kgNodeId ?? null,
    ctx.roundId, ctx.stage ?? null, ctx.mode === 'daily' ? beijingDateStr() : null,
  );
  return issued;
}

export function publicGameQuestion(q: GameQuestion, ranked: boolean): Omit<GameQuestion, 'correctKey' | 'explain'> & {
  correctKey?: string;
  explain?: string;
} {
  if (!ranked) return q;
  const { correctKey: _answer, explain: _explanation, ...question } = q;
  return question;
}

export interface SubmittedAnswer {
  questionId: string;
  /** 学生撞上的选项 key（A/B/C/D）。缺省则无法核验 */
  chosenKey?: string;
}

export interface VerifiedAnswer {
  questionId: string;
  correct: boolean;
  kgNodeId?: number;
  stem: string;
  correctText: string;
  chosenText?: string;
  explain?: string;
}

export interface VerifyResult {
  answers: VerifiedAnswer[];
  correctCount: number;
  maxCombo: number;
  totalQuestions: number;
  /** 服务端重算的分数（不采信客户端） */
  score: number;
  /** 账本里查不到、被判为未核验的题数 */
  unverified: number;
}

interface IssueRow {
  id: string;
  round_id: string;
  mode: GameMode;
  challenge_date: string | null;
  stem: string;
  options: string;
  correct_key: string;
  chosen_key: string | null;
  answer_order: number | null;
  explain: string | null;
  kg_node_id: number | null;
}

export function submitGameAnswer(userId: string, questionId: string, chosenKey: string) {
  return db.transaction(() => {
    const row = db.prepare(`
      SELECT * FROM game_question_issue
      WHERE id=? AND user_id=? AND round_id IS NOT NULL AND issued_at>unixepoch()-86400
    `).get(questionId, userId) as IssueRow | undefined;
    if (!row || !parseOptions(row.options).some(option => option.key === chosenKey)) return null;
    if (row.mode === 'daily' && row.challenge_date !== beijingDateStr()) return null;
    if (row.chosen_key) {
      if (row.chosen_key !== chosenKey) return null;
    } else {
      const sessionId = gameSessionId(userId, row.round_id);
      if (db.prepare('SELECT 1 FROM game_sessions WHERE id=?').get(sessionId)) return null;
      const previous = db.prepare(`
        SELECT COUNT(*) AS count, COALESCE(SUM(chosen_key != correct_key),0) AS wrong
        FROM game_question_issue WHERE user_id=? AND round_id=? AND answer_order IS NOT NULL
      `).get(userId, row.round_id) as { count: number; wrong: number };
      const limit = row.mode === 'daily' ? GAME_DAILY_SIZE : row.mode === 'stage' ? GAME_STAGE_SIZE : GAME_ENDLESS_LIMIT;
      if (previous.wrong >= 3 || previous.count >= limit) return null;
      if (db.prepare(`SELECT 1 FROM game_question_issue
        WHERE user_id=? AND round_id=? AND stem=? AND answer_order IS NOT NULL`).get(userId, row.round_id, row.stem)) return null;
      db.prepare('UPDATE game_question_issue SET chosen_key=?, answer_order=? WHERE id=?')
        .run(chosenKey, previous.count + 1, row.id);
    }
    return { correctKey: row.correct_key, explain: row.explain ?? undefined };
  }).immediate();
}

function parseOptions(json: string): Array<{ key: string; text: string }> {
  try {
    const arr = JSON.parse(json) as Array<{ key?: unknown; text?: unknown }>;
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((o) => typeof o?.key === 'string' && typeof o?.text === 'string')
      .map((o) => ({ key: String(o.key), text: String(o.text) }));
  } catch {
    return [];
  }
}

/**
 * 按出题账本核验作答：正确答案、对错、连击、分数全部由服务端重算。
 * 账本里没有的题目（伪造 / 超过 24 小时 / 换了进程且未落库）不计分。
 */
export function verifySubmittedAnswers(subject: GameSubject, ctx: Required<Pick<IssueContext, 'roundId' | 'mode'>> & {
  userId: string; grade?: string; stage?: number;
}, submitted: SubmittedAnswer[]): VerifyResult | null {
  const rows = db.prepare(`
    SELECT * FROM game_question_issue
    WHERE user_id=? AND round_id=? AND subject=? AND grade IS ? AND mode=? AND stage IS ?
      AND challenge_date IS ? AND issued_at>unixepoch()-86400 AND consumed_at IS NULL AND answer_order IS NOT NULL
    ORDER BY answer_order
  `).all(ctx.userId, ctx.roundId, subject, ctx.grade ?? null, ctx.mode, ctx.stage ?? null,
    ctx.mode === 'daily' ? beijingDateStr() : null) as IssueRow[];
  if (rows.length === 0 || rows.length !== submitted.length
    || rows.some((row, i) => row.answer_order !== i + 1 || row.id !== submitted[i]?.questionId
      || row.chosen_key !== submitted[i]?.chosenKey)) return null;

  const count = db.prepare(`SELECT COUNT(*) AS n FROM game_question_issue
    WHERE user_id=? AND round_id=? AND answer_order IS NOT NULL`).get(ctx.userId, ctx.roundId) as { n: number };
  if (count.n !== rows.length) return null;
  const answers: VerifiedAnswer[] = [];
  let maxCombo = 0;
  let streak = 0;
  for (const row of rows) {
    const chosenKey = row.chosen_key;
    const options = parseOptions(row.options);
    const correct = chosenKey === row.correct_key.toUpperCase();
    if (correct) {
      streak++;
      maxCombo = Math.max(maxCombo, streak);
    } else {
      streak = 0;
    }
    answers.push({
      questionId: row.id,
      correct,
      kgNodeId: row.kg_node_id ?? undefined,
      stem: row.stem,
      correctText: options.find((o) => o.key === row.correct_key)?.text ?? '',
      chosenText: options.find((o) => o.key === chosenKey)?.text ?? '',
      explain: row.explain ?? undefined,
    });
  }

  const correctCount = answers.filter((a) => a.correct).length;
  return {
    answers,
    correctCount,
    maxCombo,
    totalQuestions: answers.length,
    score: correctCount * GAME_QUESTION_BONUS,
    unverified: 0,
  };
}

/** 清理过期账本与冷缓存（由服务端定时任务调用） */
export function purgeOldGameData(nowSec = Math.floor(Date.now() / 1000)): { issues: number; cache: number } {
  try {
    const issues = db.prepare('DELETE FROM game_question_issue WHERE issued_at < ?').run(nowSec - 24 * 3600).changes;
    const cache = db.prepare('DELETE FROM game_question_cache WHERE used_count >= 5 AND created_at < ?')
      .run(nowSec - 30 * 86400).changes;
    const daily = db.prepare("DELETE FROM game_daily_challenges WHERE date < ?")
      .run(new Date((nowSec - 30 * 86400) * 1000).toISOString().slice(0, 10)).changes;
    return { issues, cache: cache + daily };
  } catch (e) {
    console.warn('[game] 过期数据清理失败:', e instanceof Error ? e.message : String(e));
    return { issues: 0, cache: 0 };
  }
}

/* ══════════════════════════════════════════════════════════════
 * 题目缓存：LLM 生成过的题落库，重启 / 多进程复用
 * ══════════════════════════════════════════════════════════════ */

function fingerprint(stem: string): string {
  return createHash('sha1').update(stem.trim()).digest('hex').slice(0, 32);
}

interface CacheRow {
  stem: string;
  options: string;
  correct_key: string;
  explain: string | null;
  kg_node_id: number | null;
  fingerprint: string;
}

function saveToCache(subject: GameSubject, grade: string | undefined, q: GameQuestion): void {
  try {
    db.prepare(`
      INSERT OR IGNORE INTO game_question_cache
        (fingerprint, subject, grade, stem, options, correct_key, explain, kg_node_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      fingerprint(q.stem), subject, grade ?? null, q.stem,
      JSON.stringify(q.options), q.correctKey, q.explain ?? null, q.kgNodeId ?? null,
    );
  } catch (e) {
    console.warn('[game] 题目入库失败:', e instanceof Error ? e.message : String(e));
  }
}

function loadFromCache(subject: GameSubject, grade: string | undefined, limit: number): GameQuestion[] {
  try {
    const sql = grade
      ? `SELECT stem, options, correct_key, explain, kg_node_id, fingerprint FROM game_question_cache
         WHERE subject=? AND grade=? ORDER BY used_count ASC, RANDOM() LIMIT ?`
      : `SELECT stem, options, correct_key, explain, kg_node_id, fingerprint FROM game_question_cache
         WHERE subject=? AND grade IS NULL ORDER BY used_count ASC, RANDOM() LIMIT ?`;
    const rows = (grade ? db.prepare(sql).all(subject, grade, limit) : db.prepare(sql).all(subject, limit)) as CacheRow[];
    if (rows.length === 0) return [];

    const bump = db.prepare('UPDATE game_question_cache SET used_count = used_count + 1 WHERE fingerprint=?');
    return rows.flatMap((r) => {
      const options = parseOptions(r.options);
      if (options.length !== LANE_COUNT || !options.some((o) => o.key === r.correct_key)) return [];
      try { bump.run(r.fingerprint); } catch { /* 忽略 */ }
      return [{
        id: newQuestionId(),
        stem: r.stem,
        options,
        correctKey: r.correct_key,
        explain: r.explain ?? undefined,
        kgNodeId: r.kg_node_id ?? undefined,
      }];
    });
  } catch (e) {
    console.warn('[game] 题目缓存读取失败:', e instanceof Error ? e.message : String(e));
    return [];
  }
}

/* ══════════════════════════════════════════════════════════════
 * 课程知识图谱：为出题挑选知识点
 * ══════════════════════════════════════════════════════════════ */

interface KgCandidate {
  id: number;
  title: string;
}

function listKnowledgePoints(subject: GameSubject, grade?: string): KgCandidate[] {
  try {
    if (!grade) {
      return db.prepare(`
        SELECT DISTINCT n.id, n.title
        FROM kg_nodes n
        WHERE n.type='knowledge_point' AND n.subject=?
        ORDER BY n.id
      `).all(subject) as KgCandidate[];
    }
    return db.prepare(`
      SELECT DISTINCT n.id, n.title
      FROM kg_nodes n
      JOIN curriculum_kg_map m ON m.node_id = n.id
      JOIN curriculum_units u ON u.id = m.unit_id
      JOIN curriculum_textbooks t ON t.id = u.textbook_id
      WHERE n.type='knowledge_point' AND t.subject=? AND t.grade=?
      ORDER BY n.id
    `).all(subject, grade) as KgCandidate[];
  } catch (e) {
    console.warn('[game] 知识点查询失败:', e instanceof Error ? e.message : String(e));
    return [];
  }
}

function pickKnowledgePoint(
  subject: GameSubject,
  grade: string | undefined,
  preferKgNodeIds?: number[],
): KgCandidate | null {
  const all = listKnowledgePoints(subject, grade);
  if (all.length === 0) return null;

  if (preferKgNodeIds && preferKgNodeIds.length > 0) {
    const wanted = new Set(preferKgNodeIds);
    const weak = all.filter((k) => wanted.has(k.id));
    if (weak.length > 0) return weak[Math.floor(Math.random() * weak.length)]!;
  }
  return all[Math.floor(Math.random() * all.length)]!;
}

/* ══════════════════════════════════════════════════════════════
 * LLM 出题
 * ══════════════════════════════════════════════════════════════ */

const SUBJECT_LABEL: Record<GameSubject, string> = {
  math: '数学',
  chinese: '语文',
  english: '英语',
  science: '科学',
};

/** LLM 调用超时（毫秒）。题目池是后台预热，超时不阻塞玩家请求 */
const LLM_TIMEOUT = 8000;

function buildPrompt(subject: GameSubject, opts: IssueContext): { prompt: string; kp: KgCandidate | null } {
  const label = SUBJECT_LABEL[subject];
  const gl = gradeLabel(opts.grade);
  const kp = pickKnowledgePoint(subject, opts.grade, opts.preferKgNodeIds);

  const lines: string[] = [
    `你是一名${label}老师，请出一道${label}单选题，用于课堂游戏抢答。`,
    `1. 面向学段：${gl ?? '中小学生'}；难度与用词必须匹配该学段，不要超纲。`,
  ];
  if (kp) {
    lines.push(`2. 考查知识点：「${kp.title}」——题目必须真正考查该知识点。`);
  } else {
    lines.push('2. 考查该学段的核心知识点。');
  }
  lines.push(
    `3. 恰好 ${LANE_COUNT} 个选项（A/B/C/D），只有一个正确；干扰项要合理，不要出现“以上都对/都不对”这类取巧选项。`,
    '4. 输出 JSON，字段：stem（题干，≤60字）、options（长度 4，每项 {key,text}）、correctKey（"A"~"D"）、explain（≤50字的一句话解析）。',
    '只输出 JSON，不要任何其他文字。',
  );

  return { prompt: lines.join('\n'), kp };
}

/** 按学科 + 年级出题；任何失败都降级为题库题目 */
export async function generateGameQuestion(
  model: BaseChatModel,
  subject: GameSubject,
  opts: IssueContext = {},
): Promise<GameQuestion> {
  const { prompt, kp } = buildPrompt(subject, opts);

  try {
    const result = await model.invoke([
      new SystemMessage('你是一名有经验的学科教师，擅长按学段出题。只输出 JSON。'),
      new HumanMessage(prompt),
    ], { signal: AbortSignal.timeout(LLM_TIMEOUT) });

    const text = typeof result.content === 'string'
      ? result.content.trim()
      : Array.isArray(result.content)
        ? result.content.map((b) => (typeof b === 'string' ? b : ((b as { text?: string }).text ?? ''))).join('').trim()
        : '';

    const parsed = parseLLMQuestion(text);
    if (parsed) {
      const { options, correctKey } = shuffleByIndex(parsed.options, parsed.correctIndex);
      return {
        id: newQuestionId(),
        stem: parsed.stem,
        options,
        correctKey,
        explain: parsed.explain,
        kgNodeId: kp?.id,
        kgTitle: kp?.title,
      };
    }
  } catch (err) {
    const reason = err instanceof Error ? err.name : 'unknown';
    console.warn(`[game] LLM 出题失败(${reason})，降级内置题库`);
  }

  return getFallbackQuestion(subject, opts.grade);
}

/* ══════════════════════════════════════════════════════════════
 * 题目池：按 (学科, 年级) 分池，缓存 → 题库 → LLM 三级供给
 * ══════════════════════════════════════════════════════════════ */

const POOL_MIN = 6;
const POOL_MAX = 20;
/** 单次补充最多生成的题数 */
const REFILL_BATCH = 6;

interface PoolEntry {
  items: GameQuestion[];
  subject: GameSubject;
  grade?: string;
}

const pools = new Map<string, PoolEntry>();
const refilling = new Set<string>();
let poolModel: BaseChatModel | null = null;
const refillRequests: number[] = [];
const MAX_REFILL_PER_DAY = 120;

function takeRefillBudget(): boolean {
  const now = Date.now();
  while (refillRequests.length && refillRequests[0]! <= now - 86_400_000) refillRequests.shift();
  if (refillRequests.length >= MAX_REFILL_PER_DAY) return false;
  refillRequests.push(now);
  return true;
}

function poolKey(subject: GameSubject, grade?: string): string {
  return `${subject}|${grade ?? '-'}`;
}

/** 加载 curriculum/game-bank/*.json 预生成题库（存在则注册，不存在则跳过） */
function loadOfflineBanks(): void {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const dir = join(here, '..', 'curriculum', 'game-bank');
    if (!existsSync(dir)) return;
    let files = 0;
    let total = 0;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const raw = JSON.parse(readFileSync(join(dir, name), 'utf8')) as {
          subject?: string; grade?: string; items?: unknown[];
        };
        const subject = normalizeSubject(raw.subject);
        if (!subject || !Array.isArray(raw.items)) {
          console.warn(`[game] 离线题库 ${name} 结构不合法，已跳过`);
          continue;
        }
        const merged = registerExtraBank(subject, raw.grade, raw.items);
        if (merged > 0) { files++; total += merged; }
      } catch (e) {
        console.warn(`[game] 离线题库 ${name} 解析失败:`, e instanceof Error ? e.message : String(e));
      }
    }
    if (files > 0) console.log(`[game] 已加载离线题库：${files} 个文件 / ${total} 道题`);
  } catch (e) {
    console.warn('[game] 离线题库加载失败:', e instanceof Error ? e.message : String(e));
  }
}

/** 注入出题模型（服务启动时调用一次） */
export function initQuestionPool(model: BaseChatModel): void {
  poolModel = model;
  loadOfflineBanks();
  console.log('[game] 出题引擎就绪（按 学科 × 年级 懒加载分池）');
}

function ensurePool(subject: GameSubject, grade?: string, preferKgNodeIds?: number[]): PoolEntry {
  const key = poolKey(subject, grade);
  let entry = pools.get(key);
  if (!entry) {
    // 先吃缓存（历史 LLM 生成的好题），再补题库，最后后台用 LLM 预热
    const cached = loadFromCache(subject, grade, POOL_MIN);
    entry = { items: cached, subject, grade };
    pools.set(key, entry);
    fillWithFallback(entry);
    if (poolModel) {
      void refillPool(entry, preferKgNodeIds).catch((e) =>
        console.warn('[game] pool warmup:', e instanceof Error ? e.message : String(e)));
    }
  }
  return entry;
}

/** 用题库补到下限（同步、零延迟） */
function fillWithFallback(entry: PoolEntry): void {
  while (entry.items.length < POOL_MIN) {
    entry.items.push(getFallbackQuestion(entry.subject, entry.grade));
  }
}

/** 后台用 LLM 补充题目池（不阻塞主请求），生成成功的题落缓存 */
async function refillPool(entry: PoolEntry, preferKgNodeIds?: number[]): Promise<void> {
  const key = poolKey(entry.subject, entry.grade);
  if (!poolModel || refilling.has(key) || refilling.size >= 2) return;
  refilling.add(key);
  try {
    let added = 0;
    while (entry.items.length < POOL_MAX && added < REFILL_BATCH && takeRefillBudget()) {
      let q: GameQuestion;
      try {
        q = await generateGameQuestion(poolModel, entry.subject, {
          grade: entry.grade,
          preferKgNodeIds,
        });
      } catch {
        q = getFallbackQuestion(entry.subject, entry.grade);
      }
      // 只有真正由 LLM 生成的题才值得缓存（题库题无需重复存）
      if (q.kgNodeId !== undefined) saveToCache(entry.subject, entry.grade, q);
      entry.items.push(q);
      added++;
    }
  } finally {
    refilling.delete(key);
  }
}

/**
 * 从题目池取一道题（同步、秒出），并写入出题账本。
 * 池子低于下限时后台补充。
 */
function takeQuestion(subject: GameSubject, ctx: IssueContext): GameQuestion {
  if (!ctx.userId || !ctx.roundId) return getFallbackQuestion(subject, ctx.grade);
  const entry = ensurePool(subject, ctx.grade, ctx.preferKgNodeIds);
  if (entry.items.length < POOL_MIN && poolModel) {
    void refillPool(entry, ctx.preferKgNodeIds).catch((e) =>
      console.warn('[game] pool refill:', e instanceof Error ? e.message : String(e)));
  }
  return entry.items.shift() ?? getFallbackQuestion(subject, ctx.grade);
}

export function getPooledQuestion(subject: GameSubject, ctx: IssueContext = {}): GameQuestion {
  return issueGameQuestion(takeQuestion(subject, ctx), subject, ctx);
}

/**
 * 批量取题（count 已由调用方 clamp）。
 * 同一批内按题干去重：随机抽 5 题也可能撞车，去重后一次请求就是 5 道不同的题，
 * 减少前端反复补拉。
 */
export function getPooledQuestions(subject: GameSubject, count: number, ctx: IssueContext = {}): GameQuestion[] {
  const out: GameQuestion[] = [];
  const seen = new Set<string>();
  let guard = 0;
  while (out.length < count && guard < count * 8) {
    guard++;
    const q = takeQuestion(subject, ctx);
    if (seen.has(q.stem)) continue;
    seen.add(q.stem);
    out.push(q);
  }
  // 题库比 count 还小时允许重复补齐，避免返回空数组
  while (out.length < count) out.push(takeQuestion(subject, ctx));
  return out.map(q => issueGameQuestion(q, subject, ctx));
}
