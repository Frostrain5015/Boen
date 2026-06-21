import { createReadStream, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { SystemMessage, HumanMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import * as OcrPkg from '@alicloud/ocr-api20210707';
// CJS/ESM interop: runtime exports expose both default Client and request classes.
const OcrRuntime = OcrPkg as any;
const OcrClient = (OcrRuntime.default ?? OcrRuntime) as new (config: any) => { recognizeEduPaperStructed(req: any): Promise<any> };
const { RecognizeEduPaperStructedRequest } = OcrRuntime;
import * as OpenApi from '@alicloud/openapi-client';
import type {
  Difficulty,
  MistakeAsset,
  MistakeDetailResponse,
  MistakeItem,
  MistakeKpMapping,
  MistakeKpRole,
  MistakeListResponse,
  MistakeSourceType,
  MistakeStatus,
  MistakeStyleFeature,
} from '@boen/shared';
import db from './db.js';
import { retrieveRelated } from './curriculum.js';
import { blobToVector, cosineSim, embedQuery, embedTexts, vectorToBlob } from './embeddings.js';
import { getProficiencyLevel } from './knowledge-profile.js';

import { ASSET_ROOT } from './paths.js';
const MAX_IMAGE_MB = Number(process.env.ALIYUN_OCR_MAX_IMAGE_MB ?? '8');
const MAX_IMAGE_BYTES = Math.max(1, MAX_IMAGE_MB) * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

type UploadedAsset = {
  bytes: Buffer;
  filename?: string;
  mimeType: string;
};

type CandidateNode = {
  id: number;
  title: string;
  subject: string;
  unitId?: number;
  unitTitle?: string;
};

type AnalysisJson = {
  subject?: string;
  title?: string;
  promptText?: string;
  studentAnswer?: string;
  correctAnswer?: string;
  explanation?: string;
  errorType?: string;
  errorReason?: string;
  confidence?: number;
  knowledgeNodes?: Array<{
    kgNodeId?: number | string;
    title?: string;
    role?: MistakeKpRole;
    confidence?: number;
    evidence?: string;
  }>;
  questionType?: string;
  difficulty?: Difficulty;
  scenarioType?: string;
  reasoningPattern?: string;
  distractorPattern?: string;
  presentationFeatures?: Record<string, unknown>;
  styleText?: string;
};

type OcrResult = {
  provider: string;
  raw: unknown;
  text: string;
};

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function safeSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'user';
}

function ensureDir(path: string) {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

function extForMime(mimeType: string, filename?: string) {
  const fromName = filename ? basename(filename).match(/\.[a-zA-Z0-9]+$/)?.[0]?.toLowerCase() : undefined;
  if (fromName && ['.jpg', '.jpeg', '.png', '.webp'].includes(fromName)) return fromName;
  if (mimeType === 'image/png') return '.png';
  if (mimeType === 'image/webp') return '.webp';
  return '.jpg';
}

function toPublicAsset(row: any): MistakeAsset {
  return {
    id: row.id,
    mistakeId: row.mistake_id,
    assetKind: row.asset_kind,
    mimeType: row.mime_type,
    fileSize: row.file_size,
    width: row.width ?? undefined,
    height: row.height ?? undefined,
    createdAt: row.created_at,
  };
}

function toMistake(row: any): MistakeItem {
  return {
    id: row.id,
    userId: row.user_id,
    subject: row.subject,
    grade: row.grade,
    sourceType: row.source_type,
    status: row.status,
    title: row.title ?? '',
    promptText: row.prompt_text ?? '',
    originalText: row.original_text ?? undefined,
    studentAnswer: row.student_answer ?? undefined,
    correctAnswer: row.correct_answer ?? undefined,
    explanation: row.explanation ?? undefined,
    errorType: row.error_type ?? undefined,
    errorReason: row.error_reason ?? undefined,
    analysisConfidence: row.analysis_confidence ?? undefined,
    answerMatchScore: row.answer_match_score ?? undefined,
    isCorrect: row.is_correct ? true : row.is_correct === 0 ? false : undefined,
    ocrProvider: row.ocr_provider ?? undefined,
    ocrRaw: row.ocr_raw ? safeJson(row.ocr_raw, undefined) : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    proficiencyAppliedAt: row.proficiency_applied_at ?? undefined,
  };
}

function safeJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function normalizeDifficulty(value: unknown): Difficulty {
  return value === 'easy' || value === 'hard' || value === 'medium' ? value : 'medium';
}

function normalizeRole(value: unknown): MistakeKpRole {
  return value === 'primary' || value === 'prerequisite' || value === 'related' ? value : 'related';
}

function clampConfidence(value: unknown, fallback = 0.6) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

/** 答案匹配度判定阈值：达到即视为大概率做对，前端错题列表过滤但题型风格仍沉淀 */
export const ANSWER_MATCH_THRESHOLD = 0.8;

/** Levenshtein 编辑距离（字符级） */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

/** 答案文本归一化：全角转半角、去空白标点、去常见单位量词、去选项前缀 */
function normalizeAnswer(raw: string): string {
  let r = raw.toLowerCase();
  // 全角转半角
  r = r.replace(/[\uff01-\uff5e]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
  r = r.replace(/\u3000/g, ' ');
  // 去空白与标点/符号
  r = r.replace(/[\s\p{P}\p{S}]/gu, '');
  // 去常见单位量词（数学/语文/英语答案中频繁出现，不影响语义）
  r = r.replace(/[元个名次题分秒岁斤克米厘升毫度角只条件张本页篇段落章节课字词语句行步答案解]/g, '');
  // 去选项前缀，如 "A." "B、" "C)"
  r = r.replace(/^([a-z])\s*[.、)]/i, '');
  return r;
}

/**
 * 计算学生答案与正确答案的匹配度 (0-1)。
 * - 任一为空返回 0（无法判定，按错题处理）
 * - 归一化后完全相等返回 1
 * - 否则取字符级 Levenshtein 相似度(0.6) 与 bigram Jaccard(0.4) 的加权最大值
 */
export function computeAnswerMatchScore(studentAnswer?: string, correctAnswer?: string): number {
  const s = (studentAnswer ?? '').trim();
  const c = (correctAnswer ?? '').trim();
  if (!s || !c) return 0;

  const ns = normalizeAnswer(s);
  const nc = normalizeAnswer(c);
  if (!ns || !nc) return 0;
  if (ns === nc) return 1;

  // 子串包含：短答案出现在长答案中，按长度比给分
  if (ns.includes(nc) || nc.includes(ns)) {
    const longer = Math.max(ns.length, nc.length);
    const shorter = Math.min(ns.length, nc.length);
    return shorter / longer;
  }

  // 字符级 Levenshtein 相似度
  const dist = levenshtein(ns, nc);
  const maxLen = Math.max(ns.length, nc.length) || 1;
  const charSim = Math.max(0, 1 - dist / maxLen);

  // bigram Jaccard（适配中文，2-gram 切分）
  const bigrams = (str: string): Set<string> => {
    const set = new Set<string>();
    for (let i = 0; i < str.length - 1; i++) set.add(str.slice(i, i + 2));
    return set;
  };
  const bs = bigrams(ns);
  const bc = bigrams(nc);
  let inter = 0;
  for (const b of bs) if (bc.has(b)) inter++;
  const union = bs.size + bc.size - inter;
  const jaccard = union > 0 ? inter / union : 0;

  return charSim * 0.6 + jaccard * 0.4;
}

function safeParseJson(raw: string): any {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const input = fenced || trimmed;
  try {
    return JSON.parse(input);
  } catch {
    const match = input.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0].replace(/,\s*([}\]])/g, '$1'));
      } catch {
        /* continue */
      }
    }
  }
  throw new Error('LLM 返回的分析 JSON 无法解析');
}

function collectTextValues(value: unknown, acc: string[] = [], depth = 0): string[] {
  if (depth > 8 || value == null) return acc;
  if (typeof value === 'string') {
    const text = value.trim();
    if (text.length >= 2 && text.length <= 4000) acc.push(text);
    return acc;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectTextValues(item, acc, depth + 1);
    return acc;
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    for (const key of ['content', 'text', 'word', 'words', 'question', 'answer', 'stem', 'value', 'data']) {
      if (key in obj) collectTextValues(obj[key], acc, depth + 1);
    }
    for (const [key, child] of Object.entries(obj)) {
      if (['content', 'text', 'word', 'words', 'question', 'answer', 'stem', 'value', 'data'].includes(key)) continue;
      collectTextValues(child, acc, depth + 1);
    }
  }
  return acc;
}

function normalizeOcrText(rawData: string | undefined): { raw: unknown; text: string } {
  if (!rawData) return { raw: {}, text: '' };
  const raw = safeJson<unknown>(rawData, rawData);
  const texts = collectTextValues(raw)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const seen = new Set<string>();
  const unique = texts.filter((text) => {
    const key = text.slice(0, 120);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { raw, text: unique.slice(0, 80).join('\n') };
}

function subjectForAliyun(subject: string, grade: string) {
  const n = Number(grade);
  const isPrimary = Number.isFinite(n) && n >= 1 && n <= 6;
  const isMiddle = Number.isFinite(n) && n >= 7 && n <= 9;
  if (subject === 'math') return isPrimary ? 'PrimarySchool_Math' : isMiddle ? 'JHighSchool_Math' : 'Math';
  if (subject === 'chinese') return isPrimary ? 'PrimarySchool_Chinese' : 'Chinese';
  if (subject === 'english') return isPrimary ? 'PrimarySchool_English' : isMiddle ? 'JHighSchool_English' : 'English';
  return 'default';
}

let aliyunClient: InstanceType<typeof OcrClient> | null = null;
function getAliyunOcrClient() {
  const accessKeyId = process.env.ALIYUN_ACCESS_KEY_ID;
  const accessKeySecret = process.env.ALIYUN_ACCESS_KEY_SECRET;
  if (!accessKeyId || !accessKeySecret) {
    throw new Error('阿里云 OCR 未配置：请设置 ALIYUN_ACCESS_KEY_ID 和 ALIYUN_ACCESS_KEY_SECRET');
  }
  if (!aliyunClient) {
    const config = new OpenApi.Config({
      accessKeyId,
      accessKeySecret,
      endpoint: process.env.ALIYUN_OCR_ENDPOINT ?? 'ocr-api.cn-hangzhou.aliyuncs.com',
    });
    aliyunClient = new OcrClient(config as any);
  }
  return aliyunClient;
}

async function recognizeWithAliyunEduOcr(filePath: string, subject: string, grade: string): Promise<OcrResult> {
  const client = getAliyunOcrClient();
  const request = new RecognizeEduPaperStructedRequest({
    subject: subjectForAliyun(subject, grade),
    needRotate: (process.env.ALIYUN_OCR_NEED_ROTATE ?? 'true') !== 'false',
    outputOricoord: (process.env.ALIYUN_OCR_OUTPUT_ORICOORD ?? 'true') !== 'false',
    body: createReadStream(filePath) as unknown as Readable,
  });
  const response = await client.recognizeEduPaperStructed(request);
  const body = response.body;
  if (body?.code && body.code !== '200') {
    throw new Error(`阿里云 OCR 识别失败：${body.message ?? body.code}`);
  }
  const normalized = normalizeOcrText(body?.data);
  return {
    provider: 'aliyun:RecognizeEduPaperStructed',
    raw: { requestId: body?.requestId, code: body?.code, data: normalized.raw },
    text: normalized.text,
  };
}

function getCandidateNodes(subject: string, grade: string, limit = 80): CandidateNode[] {
  const rows = db.prepare(`
    SELECT DISTINCT n.id, n.title, n.subject, u.id AS unit_id, u.title AS unit_title, COALESCE(n.weight, 0.5) AS weight
    FROM kg_nodes n
    JOIN curriculum_kg_map m ON m.node_id = n.id
    JOIN curriculum_units u ON u.id = m.unit_id
    JOIN curriculum_textbooks t ON t.id = u.textbook_id
    WHERE n.type='knowledge_point' AND t.subject=? AND t.grade=?
    ORDER BY weight DESC, n.title
    LIMIT ?
  `).all(subject, grade, limit) as any[];
  if (rows.length) {
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      subject: r.subject,
      unitId: r.unit_id ?? undefined,
      unitTitle: r.unit_title ?? undefined,
    }));
  }
  return (db.prepare(`
    SELECT id, title, subject FROM kg_nodes
    WHERE type='knowledge_point' AND subject=?
    ORDER BY COALESCE(weight, 0.5) DESC, title
    LIMIT ?
  `).all(subject, limit) as any[]).map((r) => ({ id: r.id, title: r.title, subject: r.subject }));
}

function findCandidateById(id: number, subject: string, grade: string): CandidateNode | undefined {
  const row = db.prepare(`
    SELECT DISTINCT n.id, n.title, n.subject, u.id AS unit_id, u.title AS unit_title
    FROM kg_nodes n
    LEFT JOIN curriculum_kg_map m ON m.node_id = n.id
    LEFT JOIN curriculum_units u ON u.id = m.unit_id
    LEFT JOIN curriculum_textbooks t ON t.id = u.textbook_id
    WHERE n.id=? AND n.type='knowledge_point' AND n.subject=?
      AND (t.grade=? OR t.grade IS NULL OR t.grade IS ?)
    LIMIT 1
  `).get(id, subject, grade, null) as any;
  if (!row) return undefined;
  return { id: row.id, title: row.title, subject: row.subject, unitId: row.unit_id ?? undefined, unitTitle: row.unit_title ?? undefined };
}

function findCandidateByTitle(title: string, subject: string, grade: string): CandidateNode | undefined {
  const clean = title.trim();
  if (!clean) return undefined;
  const params = [subject, grade];
  const exact = db.prepare(`
    SELECT DISTINCT n.id, n.title, n.subject, u.id AS unit_id, u.title AS unit_title
    FROM kg_nodes n
    JOIN curriculum_kg_map m ON m.node_id = n.id
    JOIN curriculum_units u ON u.id = m.unit_id
    JOIN curriculum_textbooks t ON t.id = u.textbook_id
    WHERE n.type='knowledge_point' AND t.subject=? AND t.grade=? AND n.title=?
    LIMIT 1
  `).get(...params, clean) as any;
  if (exact) return { id: exact.id, title: exact.title, subject: exact.subject, unitId: exact.unit_id, unitTitle: exact.unit_title };

  const fuzzy = db.prepare(`
    SELECT DISTINCT n.id, n.title, n.subject, u.id AS unit_id, u.title AS unit_title
    FROM kg_nodes n
    JOIN curriculum_kg_map m ON m.node_id = n.id
    JOIN curriculum_units u ON u.id = m.unit_id
    JOIN curriculum_textbooks t ON t.id = u.textbook_id
    WHERE n.type='knowledge_point' AND t.subject=? AND t.grade=?
      AND (n.title LIKE ? OR ? LIKE '%' || n.title || '%')
    ORDER BY LENGTH(n.title) ASC
    LIMIT 1
  `).get(...params, `%${clean}%`, clean) as any;
  if (!fuzzy) return undefined;
  return { id: fuzzy.id, title: fuzzy.title, subject: fuzzy.subject, unitId: fuzzy.unit_id, unitTitle: fuzzy.unit_title };
}

async function analyzeWithLlm(model: BaseChatModel, params: {
  subject: string;
  grade: string;
  recognizedText: string;
  studentAnswer?: string;
  candidates: CandidateNode[];
}): Promise<AnalysisJson[]> {
  const related = await retrieveRelated(params.grade, params.subject, params.recognizedText, 8).catch(() => []);
  const candidateText = params.candidates
    .slice(0, 80)
    .map((n) => `- [${n.id}] ${n.title}${n.unitTitle ? `（${n.unitTitle}）` : ''}`)
    .join('\n');
  const prompt = [
    '你是一个教育错题分析系统。请基于真实作业/考试 OCR 文本，抽取其中所有可识别的题目。',
    'OCR 文本可能包含一页上的多道题目，请逐一识别并分别分析。',
    '输出一个 JSON 数组，每个元素对应一道题的完整分析。如果只有一道题，则输出一个元素的数组。',
    '只允许从候选知识点列表选择 kgNodeId，不要编造新 ID。若无法确定，knowledgeNodes 返回空数组。',
    '',
    `学科: ${params.subject}`,
    `年级: ${params.grade}`,
    '',
    'OCR/录入文本:',
    params.recognizedText || '（空）',
    params.studentAnswer ? `\n学生补充答案:\n${params.studentAnswer}` : '',
    related.length ? `\n课程检索上下文:\n${related.map((r) => `- ${r}`).join('\n')}` : '',
    '',
    '候选知识点:',
    candidateText || '（无候选）',
    '',
    `用户当前学科: ${params.subject}（AI 可根据内容修正）`,
    '',
    '请严格输出 JSON 数组，不要 Markdown，不要解释。每个元素的字段如下:',
    JSON.stringify({
      subject: 'chinese | math | english | science — 根据内容判断学科，从候选知识点所在学科推断',
      title: '10字以内标题',
      promptText: '整理后的完整题面',
      studentAnswer: '学生原答案或可见错误作答',
      correctAnswer: '正确答案',
      explanation: '简洁解法',
      errorType: '概念混淆/计算失误/审题遗漏/步骤跳步/表达不完整/其他',
      errorReason: '具体错因，不能只写粗心',
      confidence: 0.82,
      knowledgeNodes: [
        { kgNodeId: 123, title: '候选知识点标题', role: 'primary', confidence: 0.86, evidence: '题面证据' },
      ],
      questionType: '选择题/填空题/解答题/应用题/阅读题/其他',
      difficulty: 'easy|medium|hard',
      scenarioType: '生活情境/计算训练/图形推理/文本阅读/实验探究/其他',
      reasoningPattern: '本题核心推理结构',
      distractorPattern: '常见误导点或干扰项模式',
      presentationFeatures: { hasDiagram: false, hasFormula: true, isMultiStep: true },
      styleText: '用于未来出题的风格摘要，只描述结构和风格，不复述原题具体数字',
    }),
  ].filter(Boolean).join('\n');

  const response = await model.invoke([
    new SystemMessage('你只输出可解析 JSON。'),
    new HumanMessage(prompt),
  ]);
  const content = typeof response.content === 'string' ? response.content : JSON.stringify(response.content);
  const parsed = safeParseJson(content);
  // 兼容：如果 LLM 返回单个对象而非数组，包装成数组
  if (parsed && !Array.isArray(parsed)) {
    return [parsed as AnalysisJson];
  }
  return (parsed as AnalysisJson[]) || [];
}

function loadMistakeRows(mistakeId: string, userId: string) {
  const mistake = db.prepare(`SELECT * FROM mistake_items WHERE id=? AND user_id=?`).get(mistakeId, userId) as any;
  if (!mistake) return null;
  const assets = db.prepare(`SELECT * FROM mistake_assets WHERE mistake_id=? ORDER BY id`).all(mistakeId) as any[];
  const mappings = db.prepare(`
    SELECT m.*, n.title, u.title AS unit_title
    FROM mistake_kp_map m
    JOIN kg_nodes n ON n.id = m.kg_node_id
    LEFT JOIN curriculum_units u ON u.id = m.unit_id
    WHERE m.mistake_id=?
    ORDER BY CASE m.role WHEN 'primary' THEN 0 WHEN 'related' THEN 1 ELSE 2 END, m.confidence DESC
  `).all(mistakeId) as any[];
  const style = db.prepare(`SELECT * FROM mistake_style_features WHERE mistake_id=? ORDER BY id DESC LIMIT 1`).get(mistakeId) as any;
  const item = toMistake(mistake);
  item.assets = assets.map(toPublicAsset);
  item.mappings = mappings.map((m): MistakeKpMapping => ({
    mistakeId: m.mistake_id,
    kgNodeId: m.kg_node_id,
    title: m.title,
    unitId: m.unit_id ?? undefined,
    unitTitle: m.unit_title ?? undefined,
    role: m.role,
    confidence: m.confidence,
    beforeScore: m.before_score ?? undefined,
    afterScore: m.after_score ?? undefined,
    evidence: m.evidence_json ? safeJson<{ evidence?: string }>(m.evidence_json, {}).evidence : undefined,
  }));
  if (style) {
    item.styleFeature = {
      id: style.id,
      mistakeId: style.mistake_id,
      questionType: style.question_type,
      difficulty: normalizeDifficulty(style.difficulty),
      scenarioType: style.scenario_type,
      reasoningPattern: style.reasoning_pattern,
      distractorPattern: style.distractor_pattern ?? undefined,
      presentationFeatures: style.presentation_features ? safeJson(style.presentation_features, {}) : undefined,
      styleText: style.style_text,
      createdAt: style.created_at,
    };
  }
  return item;
}

export function listMistakes(userId: string, filters: {
  subject?: string;
  grade?: string;
  status?: MistakeStatus;
  limit?: number;
  /** 是否包含做对的题（匹配度≥阈值，默认不包含，即从错题列表过滤） */
  includeCorrect?: boolean;
}): MistakeListResponse {
  let sql = `SELECT * FROM mistake_items WHERE user_id=?`;
  const params: unknown[] = [userId];
  if (filters.subject) {
    sql += ` AND subject=?`;
    params.push(filters.subject);
  }
  if (filters.grade) {
    sql += ` AND grade=?`;
    params.push(filters.grade);
  }
  if (filters.status) {
    sql += ` AND status=?`;
    params.push(filters.status);
  } else {
    sql += ` AND status <> 'archived'`;
  }
  // 默认过滤掉做对的题（前端不再作为错题展示）
  if (!filters.includeCorrect) {
    sql += ` AND is_correct = 0`;
  }
  sql += ` ORDER BY updated_at DESC LIMIT ?`;
  params.push(Math.min(Math.max(filters.limit ?? 30, 1), 100));
  const rows = db.prepare(sql).all(...params) as any[];
  const mistakes = rows.map((row) => {
    const item = toMistake(row);
    // 加载映射、资产、风格特征（与 loadMistakeRows 一致，但批量一次查）
    const assets = db.prepare(`SELECT * FROM mistake_assets WHERE mistake_id=? ORDER BY id`).all(item.id) as any[];
    item.assets = assets.map(toPublicAsset);
    const mappings = db.prepare(`
      SELECT m.*, n.title, u.title AS unit_title
      FROM mistake_kp_map m
      JOIN kg_nodes n ON n.id = m.kg_node_id
      LEFT JOIN curriculum_units u ON u.id = m.unit_id
      WHERE m.mistake_id=?
      ORDER BY CASE m.role WHEN 'primary' THEN 0 WHEN 'related' THEN 1 ELSE 2 END, m.confidence DESC
    `).all(item.id) as any[];
    item.mappings = mappings.map((m): MistakeKpMapping => ({
      mistakeId: m.mistake_id,
      kgNodeId: m.kg_node_id,
      title: m.title,
      unitId: m.unit_id ?? undefined,
      unitTitle: m.unit_title ?? undefined,
      role: m.role,
      confidence: m.confidence,
      beforeScore: m.before_score ?? undefined,
      afterScore: m.after_score ?? undefined,
      evidence: m.evidence_json ? safeJson<{ evidence?: string }>(m.evidence_json, {}).evidence : undefined,
    }));
    const style = db.prepare(`SELECT * FROM mistake_style_features WHERE mistake_id=? ORDER BY id LIMIT 1`).get(item.id) as any;
    if (style) {
      item.styleFeature = {
        id: style.id,
        mistakeId: style.mistake_id,
        questionType: style.question_type,
        difficulty: normalizeDifficulty(style.difficulty),
        scenarioType: style.scenario_type,
        reasoningPattern: style.reasoning_pattern,
        distractorPattern: style.distractor_pattern ?? undefined,
        presentationFeatures: style.presentation_features ? safeJson(style.presentation_features, {}) : undefined,
        styleText: style.style_text,
        createdAt: style.created_at,
      };
    }
    return item;
  });
  return { mistakes };
}

export function getMistakeDetail(mistakeId: string, userId: string): MistakeDetailResponse | null {
  const mistake = loadMistakeRows(mistakeId, userId);
  return mistake ? { mistake } : null;
}

export function createMistake(userId: string, params: {
  sourceType: MistakeSourceType;
  subject: string;
  grade: string;
  promptText?: string;
  studentAnswer?: string;
  note?: string;
  asset?: UploadedAsset;
}): MistakeItem {
  const sourceType = params.sourceType;
  if (sourceType === 'image' && !params.asset) {
    throw new Error('图片错题需要上传图片');
  }
  if (params.asset) {
    if (!ALLOWED_IMAGE_TYPES.has(params.asset.mimeType)) throw new Error('仅支持 jpg/png/webp 图片');
    if (params.asset.bytes.byteLength > MAX_IMAGE_BYTES) throw new Error(`图片不能超过 ${MAX_IMAGE_MB}MB`);
  }
  const id = `mistake-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const now = nowSec();
  db.prepare(`
    INSERT INTO mistake_items (id, user_id, subject, grade, source_type, status, title, prompt_text, student_answer, original_text, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'processing', ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    userId,
    params.subject,
    params.grade,
    sourceType,
    params.promptText?.trim() ? params.promptText.trim().slice(0, 24) : '新错题',
    params.promptText?.trim() ?? '',
    params.studentAnswer?.trim() || null,
    params.note?.trim() || null,
    now,
    now,
  );

  if (params.asset) {
    const dir = join(ASSET_ROOT, safeSegment(userId), id);
    ensureDir(dir);
    const filePath = join(dir, `original${extForMime(params.asset.mimeType, params.asset.filename)}`);
    writeFileSync(filePath, params.asset.bytes);
    db.prepare(`
      INSERT INTO mistake_assets (mistake_id, asset_kind, mime_type, file_path, file_size)
      VALUES (?, 'original', ?, ?, ?)
    `).run(id, params.asset.mimeType, filePath, params.asset.bytes.byteLength);
  }

  const created = loadMistakeRows(id, userId);
  if (!created) throw new Error('创建错题失败');
  return created;
}

function getOriginalAssetPath(mistakeId: string) {
  const row = db.prepare(`
    SELECT file_path FROM mistake_assets WHERE mistake_id=? AND asset_kind='original' ORDER BY id LIMIT 1
  `).get(mistakeId) as { file_path: string } | undefined;
  return row?.file_path;
}

function clearAnalysis(mistakeId: string) {
  db.prepare(`DELETE FROM mistake_kp_map WHERE mistake_id=?`).run(mistakeId);
  db.prepare(`DELETE FROM mistake_style_features WHERE mistake_id=?`).run(mistakeId);
}

function revertMistakeProficiencyEvents(mistakeId: string, userId: string) {
  const events = db.prepare(`
    SELECT * FROM mistake_proficiency_events
    WHERE mistake_id=? AND user_id=? AND reverted_at IS NULL
    ORDER BY applied_at DESC, id DESC
  `).all(mistakeId, userId) as any[];
  const mark = db.prepare(`UPDATE mistake_proficiency_events SET reverted_at=? WHERE id=?`);
  const now = nowSec();
  for (const ev of events) {
    const prof = db.prepare(`SELECT * FROM user_kp_proficiency WHERE user_id=? AND kg_node_id=?`).get(userId, ev.kg_node_id) as any;
    const newerMistakeEvent = db.prepare(`
      SELECT COUNT(*) AS count FROM mistake_proficiency_events
      WHERE user_id=? AND kg_node_id=? AND applied_at>? AND reverted_at IS NULL
    `).get(userId, ev.kg_node_id, ev.applied_at) as { count: number };
    const hasNewerProfileUpdate = prof && prof.last_updated > ev.applied_at;
    if (!newerMistakeEvent.count && !hasNewerProfileUpdate) {
      if (ev.before_score == null) {
        db.prepare(`DELETE FROM user_kp_proficiency WHERE user_id=? AND kg_node_id=?`).run(userId, ev.kg_node_id);
      } else {
        db.prepare(`
          UPDATE user_kp_proficiency
          SET correct_count=?, total_count=?, weighted_score=?, rating=?, rating_sigma=?, last_updated=?
          WHERE user_id=? AND kg_node_id=?
        `).run(ev.before_correct_count ?? 0, ev.before_total_count ?? 0, ev.before_score, ev.before_rating ?? 50, ev.before_sigma ?? 20, now, userId, ev.kg_node_id);
      }
    }
    mark.run(now, ev.id);
  }
}

function applyMistakeProficiency(userId: string, mistakeId: string, nodeId: number, role: MistakeKpRole, confidence: number) {
  const existing = db.prepare(`SELECT * FROM user_kp_proficiency WHERE user_id=? AND kg_node_id=?`).get(userId, nodeId) as any;
  const beforeScore = existing?.weighted_score ?? null;
  const beforeCorrect = existing?.correct_count ?? null;
  const beforeTotal = existing?.total_count ?? null;
  const beforeRating = existing?.rating ?? 50;
  const beforeSigma = existing?.rating_sigma ?? 20;
  const now = nowSec();

  // ── Elo 惩罚（低 K-factor） ──
  const expected = 1 / (1 + Math.exp(-(beforeRating - 50) / 15));
  const roleK = role === 'primary' ? 4 : role === 'related' ? 2.5 : 1.5;
  const eloDelta = roleK * (1 + confidence * 0.5) * (0 - expected);
  const afterRating = Math.max(0, Math.min(100, Math.round((beforeRating + eloDelta) * 10) / 10));
  const afterSigma = Math.max(3, Math.min(25, Math.round((beforeSigma * 1.15) * 10) / 10));

  // ── 旧 EMA 后向兼容 ──
  const alphaBase = role === 'primary' ? 0.18 : role === 'related' ? 0.1 : 0.08;
  const alphaSpan = role === 'primary' ? 0.12 : 0.08;
  const alpha = alphaBase + alphaSpan * confidence;
  const afterScore = existing
    ? Math.max(0, Math.round(existing.weighted_score * (1 - alpha)))
    : role === 'primary' ? 35 : 45;
  const afterCorrect = existing?.correct_count ?? 0;
  const afterTotal = (existing?.total_count ?? 0) + 1;

  db.prepare(`
    INSERT INTO user_kp_proficiency (user_id, kg_node_id, correct_count, total_count, weighted_score, rating, rating_sigma, last_updated)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, kg_node_id) DO UPDATE SET
      correct_count=excluded.correct_count,
      total_count=excluded.total_count,
      weighted_score=excluded.weighted_score,
      rating=excluded.rating,
      rating_sigma=excluded.rating_sigma,
      last_updated=excluded.last_updated
  `).run(userId, nodeId, afterCorrect, afterTotal, afterScore, afterRating, afterSigma, now);

  db.prepare(`
    INSERT INTO mistake_proficiency_events (
      mistake_id, user_id, kg_node_id, before_score, after_score,
      before_correct_count, before_total_count, after_correct_count, after_total_count,
      role, confidence, applied_at,
      before_rating, after_rating, before_sigma, after_sigma
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(mistakeId, userId, nodeId, beforeScore, afterScore, beforeCorrect, beforeTotal, afterCorrect, afterTotal, role, confidence, now,
    beforeRating, afterRating, beforeSigma, afterSigma);

  return { beforeScore, afterScore, appliedAt: now };
}

function buildStyleText(analysis: AnalysisJson, promptText: string) {
  const parts = [
    `题型: ${analysis.questionType ?? '综合题'}`,
    `难度: ${normalizeDifficulty(analysis.difficulty)}`,
    `情境: ${analysis.scenarioType ?? '常规学习场景'}`,
    `推理结构: ${analysis.reasoningPattern ?? '提取条件并分步求解'}`,
    analysis.distractorPattern ? `干扰模式: ${analysis.distractorPattern}` : '',
    analysis.presentationFeatures ? `呈现特征: ${JSON.stringify(analysis.presentationFeatures)}` : '',
    analysis.styleText ? `风格摘要: ${analysis.styleText}` : '',
    `原题结构摘要: ${promptText.replace(/\s+/g, ' ').slice(0, 240)}`,
  ].filter(Boolean);
  return parts.join('\n');
}

function saveStyleFeature(mistakeId: string, analysis: AnalysisJson, promptText: string) {
  const styleText = buildStyleText(analysis, promptText);
  let embedding: Buffer | null = null;
  return embedTexts([styleText])
    .then(([vec]) => {
      embedding = vec ? vectorToBlob(vec) : null;
    })
    .catch(() => {
      embedding = null;
    })
    .then(() => {
      db.prepare(`
        INSERT INTO mistake_style_features (
          mistake_id, question_type, difficulty, scenario_type, reasoning_pattern,
          distractor_pattern, presentation_features, style_text, embedding
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        mistakeId,
        analysis.questionType ?? '综合题',
        normalizeDifficulty(analysis.difficulty),
        analysis.scenarioType ?? '常规学习场景',
        analysis.reasoningPattern ?? '提取条件并分步求解',
        analysis.distractorPattern ?? null,
        analysis.presentationFeatures ? JSON.stringify(analysis.presentationFeatures) : null,
        styleText,
        embedding,
      );
    });
}

/**
 * 将一道题的分析结果应用到指定 mistake 记录：更新 DB、映射知识点、写熟练度、存风格特征。
 * questionIndex / totalQuestions 用于进度条计算（仅 progress 数值，不做除法）
 */
async function applyAnalysisToMistake(
  mistakeId: string,
  userId: string,
  row: any,
  analysis: AnalysisJson,
  recognizedText: string,
  candidates: CandidateNode[],
  ocrProvider: string | null,
  ocrRaw: unknown,
  questionIndex: number,
  totalQuestions: number,
  onProgress?: (event: {
    step: 'ocr' | 'analyze' | 'map' | 'profile' | 'style' | 'complete';
    message: string;
    progress: number;
  }) => void | Promise<void>,
): Promise<MistakeItem> {
  // 进度范围：总进度 100%，OCR + LLM 占 ~35%，剩余 ~65% 按题目平分
  const share = totalQuestions > 1 ? 65 / totalQuestions : 65;
  const basePct = 32 + (questionIndex / (totalQuestions || 1)) * 65;

  function pct(offset: number) {
    return Math.round(basePct + offset * share);
  }

  // ── 知识点映射 ──
  await onProgress?.({ step: 'map', message: `校验章节和知识图谱节点（第 ${questionIndex + 1}/${totalQuestions} 题）`, progress: pct(0.35) });
  const mappings: Array<MistakeKpMapping & { evidenceJson: string }> = [];
  for (const rawMap of analysis.knowledgeNodes ?? []) {
    const directId = Number(rawMap.kgNodeId);
    const candidate = Number.isFinite(directId)
      ? findCandidateById(directId, row.subject, row.grade)
      : undefined;
    const fallback = candidate ?? (rawMap.title ? findCandidateByTitle(rawMap.title, row.subject, row.grade) : undefined);
    if (!fallback) continue;
    const role = normalizeRole(rawMap.role);
    const confidence = clampConfidence(rawMap.confidence, 0.55);
    if (confidence < 0.35) continue;
    if (mappings.some((m) => m.kgNodeId === fallback.id)) continue;
    mappings.push({
      mistakeId,
      kgNodeId: fallback.id,
      title: fallback.title,
      unitId: fallback.unitId,
      unitTitle: fallback.unitTitle,
      role,
      confidence,
      evidence: rawMap.evidence,
      evidenceJson: JSON.stringify({ evidence: rawMap.evidence ?? '', llmTitle: rawMap.title ?? '' }),
    });
  }

  const status: MistakeStatus = mappings.length > 0 ? 'analyzed' : 'needs_review';
  const now = nowSec();

  // ── 答案匹配度：≥阈值视为大概率做对 ──
  // 做对的题：前端错题列表过滤、熟练度不再扣减，但题型风格仍沉淀
  const matchScore = computeAnswerMatchScore(
    analysis.studentAnswer?.trim() || row.student_answer || undefined,
    analysis.correctAnswer?.trim() || undefined,
  );
  const isCorrect = matchScore >= ANSWER_MATCH_THRESHOLD;

  revertMistakeProficiencyEvents(mistakeId, userId);
  clearAnalysis(mistakeId);

  // ── 更新错题记录 ──
  // LLM 检测到的学科可覆盖初始学科
  const detectedSubject = analysis.subject && ['chinese','math','english','science'].includes(analysis.subject)
    ? analysis.subject
    : row.subject;

  db.prepare(`
    UPDATE mistake_items SET
      subject=?, status=?, title=?, prompt_text=?, student_answer=?, correct_answer=?, explanation=?,
      error_type=?, error_reason=?, analysis_confidence=?, answer_match_score=?, is_correct=?,
      ocr_provider=?, ocr_raw=?, updated_at=?
    WHERE id=? AND user_id=?
  `).run(
    detectedSubject,
    status,
    (analysis.title || recognizedText.split(/\n|。|\./)[0] || '错题').slice(0, 32),
    (analysis.promptText || recognizedText).trim(),
    analysis.studentAnswer?.trim() || row.student_answer || null,
    analysis.correctAnswer?.trim() || null,
    analysis.explanation?.trim() || null,
    analysis.errorType?.trim() || null,
    analysis.errorReason?.trim() || null,
    clampConfidence(analysis.confidence, status === 'analyzed' ? 0.7 : 0.3),
    matchScore,
    isCorrect ? 1 : 0,
    ocrProvider,
    ocrRaw ? JSON.stringify(ocrRaw) : null,
    now,
    mistakeId,
    userId,
  );

  // ── 熟练度 ──
  // 做对的题不扣减熟练度，避免错误降低已掌握知识点的画像
  if (isCorrect) {
    await onProgress?.({ step: 'profile', message: `答案匹配度 ${Math.round(matchScore * 100)}%，判定为大概率做对，跳过画像扣减`, progress: pct(0.65) });
  } else {
    await onProgress?.({ step: 'profile', message: status === 'analyzed' ? `写入知识画像（第 ${questionIndex + 1}/${totalQuestions} 题）` : '未找到可信知识点，等待人工修正', progress: pct(0.65) });
    let appliedAt: number | undefined;
    for (const mapping of mappings) {
      const change = applyMistakeProficiency(userId, mistakeId, mapping.kgNodeId, mapping.role, mapping.confidence);
      mapping.beforeScore = change.beforeScore ?? undefined;
      mapping.afterScore = change.afterScore;
      appliedAt = change.appliedAt;
      db.prepare(`
        INSERT INTO mistake_kp_map (mistake_id, kg_node_id, unit_id, role, confidence, before_score, after_score, evidence_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(mistakeId, mapping.kgNodeId, mapping.unitId ?? null, mapping.role, mapping.confidence, change.beforeScore, change.afterScore, mapping.evidenceJson);
    }
    if (appliedAt) {
      db.prepare(`UPDATE mistake_items SET proficiency_applied_at=?, updated_at=? WHERE id=? AND user_id=?`).run(appliedAt, appliedAt, mistakeId, userId);
    }
  }

  // ── 风格特征 ──
  // 题型沉淀逻辑不受答案正确率判断影响：做对的题同样沉淀出题风格
  await onProgress?.({ step: 'style', message: `沉淀题型风格（第 ${questionIndex + 1}/${totalQuestions} 题）`, progress: pct(0.8) });
  if (status === 'analyzed' || isCorrect) {
    await saveStyleFeature(mistakeId, analysis, analysis.promptText || recognizedText);
  }

  await onProgress?.({ step: 'complete', message: status === 'analyzed' ? `第 ${questionIndex + 1} 题分析完成` : '错题已保存，需补充知识点', progress: pct(1) });
  const item = loadMistakeRows(mistakeId, userId);
  if (!item) throw new Error('错题分析结果读取失败');
  return item;
}

function makeMistakeId() {
  const ts = Date.now().toString(36);
  const rand = crypto.getRandomValues(new Uint8Array(4)).reduce((s, b) => s + b.toString(36).padStart(2, '0'), '');
  return `mistake-${ts}-${rand}`;
}

export async function analyzeMistake(
  mistakeId: string, userId: string, model: BaseChatModel,
  onProgress?: (event: {
    step: 'ocr' | 'analyze' | 'map' | 'profile' | 'style' | 'complete';
    message: string;
    progress: number;
  }) => void | Promise<void>,
  onMistake?: (mistake: MistakeItem) => void | Promise<void>,
): Promise<void> {
  const row = db.prepare(`SELECT * FROM mistake_items WHERE id=? AND user_id=?`).get(mistakeId, userId) as any;
  if (!row) throw new Error('错题不存在');
  if (row.status === 'archived') throw new Error('错题已归档');

  // ── 1. OCR ──
  await onProgress?.({ step: 'ocr', message: row.source_type === 'text' ? '读取文本录入' : '调用阿里云教育 OCR 识别', progress: 8 });
  let recognizedText = String(row.prompt_text ?? '').trim();
  let ocrProvider: string | null = row.ocr_provider ?? null;
  let ocrRaw: unknown = row.ocr_raw ? safeJson(row.ocr_raw, {}) : null;
  if (row.source_type === 'image') {
    const assetPath = getOriginalAssetPath(mistakeId);
    if (!assetPath) throw new Error('找不到原始图片');
    const ocr = await recognizeWithAliyunEduOcr(assetPath, row.subject, row.grade);
    recognizedText = ocr.text || recognizedText;
    ocrProvider = ocr.provider;
    ocrRaw = ocr.raw;
  }
  if (!recognizedText.trim()) throw new Error('OCR 未识别到有效题目文本，请换一张更清晰的图片或使用文本补录');

  // ── 2. LLM 分析（返回所有题目） ──
  await onProgress?.({ step: 'analyze', message: 'LLM 识别全部题目', progress: 30 });
  const analyses = await analyzeWithLlm(model, {
    subject: row.subject,
    grade: row.grade,
    recognizedText,
    studentAnswer: row.student_answer ?? undefined,
    candidates: getCandidateNodes(row.subject, row.grade, 80),
  });

  if (!analyses.length) throw new Error('LLM 未能从文本中识别出有效题目');

  // 用 LLM 检测到的学科重新获取候选知识点
  const effectiveSubject = analyses[0].subject && ['chinese','math','english','science'].includes(analyses[0].subject)
    ? analyses[0].subject
    : row.subject;
  const candidates = getCandidateNodes(effectiveSubject, row.grade, 80);

  // ── 3. 逐题应用分析结果 ──
  for (let i = 0; i < analyses.length; i++) {
    const analysis = analyses[i];
    let targetId: string;
    let targetRow: any;

    if (i === 0) {
      // 第一题复写原 mistake 记录（用 LLM 检测的学科覆盖）
      targetId = mistakeId;
      targetRow = { ...row, subject: effectiveSubject };
    } else {
      // 后续题创建新记录（无资产，共享 OCR 文本）
      targetId = makeMistakeId();
      const now = nowSec();
      db.prepare(`
        INSERT INTO mistake_items (id, user_id, subject, grade, source_type, status, prompt_text, student_answer, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'processing', ?, ?, ?, ?)
      `).run(
        targetId, userId, effectiveSubject, row.grade, row.source_type,
        (analysis.promptText || recognizedText).slice(0, 800),
        row.student_answer, now, now,
      );
      targetRow = db.prepare(`SELECT * FROM mistake_items WHERE id=?`).get(targetId) as any;
    }

    const item = await applyAnalysisToMistake(
      targetId, userId, targetRow, analysis, recognizedText, candidates,
      ocrProvider, ocrRaw, i, analyses.length, onProgress,
    );
    await onMistake?.(item);
  }
}

export function updateMistake(mistakeId: string, userId: string, patch: {
  promptText?: string;
  studentAnswer?: string;
  correctAnswer?: string;
  errorReason?: string;
}): MistakeItem {
  const current = db.prepare(`SELECT * FROM mistake_items WHERE id=? AND user_id=?`).get(mistakeId, userId) as any;
  if (!current) throw new Error('错题不存在');
  const now = nowSec();
  db.prepare(`
    UPDATE mistake_items SET
      prompt_text=COALESCE(?, prompt_text),
      student_answer=COALESCE(?, student_answer),
      correct_answer=COALESCE(?, correct_answer),
      error_reason=COALESCE(?, error_reason),
      updated_at=?
    WHERE id=? AND user_id=?
  `).run(
    patch.promptText?.trim() || null,
    patch.studentAnswer?.trim() || null,
    patch.correctAnswer?.trim() || null,
    patch.errorReason?.trim() || null,
    now,
    mistakeId,
    userId,
  );
  const item = loadMistakeRows(mistakeId, userId);
  if (!item) throw new Error('错题更新失败');
  return item;
}

export function archiveMistake(mistakeId: string, userId: string) {
  const info = db.prepare(`UPDATE mistake_items SET status='archived', updated_at=? WHERE id=? AND user_id=?`).run(nowSec(), mistakeId, userId);
  return info.changes > 0;
}

export function getMistakeAssetFile(mistakeId: string, assetId: number, userId: string): { filePath: string; mimeType: string } | null {
  const row = db.prepare(`
    SELECT a.file_path, a.mime_type
    FROM mistake_assets a
    JOIN mistake_items m ON m.id = a.mistake_id
    WHERE a.id=? AND a.mistake_id=? AND m.user_id=?
  `).get(assetId, mistakeId, userId) as { file_path: string; mime_type: string } | undefined;
  if (!row) return null;
  const root = resolve(ASSET_ROOT);
  const filePath = resolve(row.file_path);
  if (!filePath.startsWith(root) || !existsSync(filePath)) return null;
  return { filePath, mimeType: row.mime_type };
}

export async function readMistakeAsset(filePath: string) {
  return readFile(filePath);
}

export async function retrieveMistakeStyleSamples(userId: string, subject: string, grade: string, query: string, kgNodeIds: number[] = [], limit = 3): Promise<string> {
  const rows = db.prepare(`
    SELECT sf.*, mi.prompt_text, mi.error_type, group_concat(km.kg_node_id) AS node_ids
    FROM mistake_style_features sf
    JOIN mistake_items mi ON mi.id = sf.mistake_id
    LEFT JOIN mistake_kp_map km ON km.mistake_id = sf.mistake_id
    WHERE mi.user_id=? AND mi.subject=? AND mi.grade=? AND (mi.status='analyzed' OR mi.is_correct=1)
    GROUP BY sf.id
    ORDER BY sf.created_at DESC
    LIMIT 40
  `).all(userId, subject, grade) as any[];
  if (!rows.length) return '';
  let queryVector: number[] | null = null;
  if (query.trim()) {
    try {
      queryVector = await embedQuery(query);
    } catch (err) {
      console.warn('[mistakes] embedding query failed:', err);
      queryVector = null;
    }
  }
  const targetIds = new Set(kgNodeIds);
  const ranked = rows.map((row) => {
    const ids = String(row.node_ids ?? '').split(',').map(Number).filter(Number.isFinite);
    const overlap = ids.some((id) => targetIds.has(id)) ? 0.35 : 0;
    const sim = queryVector && row.embedding ? cosineSim(queryVector, blobToVector(row.embedding)) : 0;
    const recency = Math.max(0, Math.min(0.12, (row.created_at ?? 0) / Math.max(1, nowSec()) * 0.12));
    return { row, score: sim + overlap + recency };
  }).sort((a, b) => b.score - a.score).slice(0, limit);
  if (!ranked.length) return '';
  return [
    '【真实学校错题风格样本】以下样本仅用于学习题型结构、出题风格、逻辑搭建和情境选取，严禁复刻原题文字、数字、学生答案或隐私信息。',
    ...ranked.map(({ row }, i) => {
      const style: MistakeStyleFeature = {
        id: row.id,
        mistakeId: row.mistake_id,
        questionType: row.question_type,
        difficulty: normalizeDifficulty(row.difficulty),
        scenarioType: row.scenario_type,
        reasoningPattern: row.reasoning_pattern,
        distractorPattern: row.distractor_pattern ?? undefined,
        presentationFeatures: row.presentation_features ? safeJson(row.presentation_features, {}) : undefined,
        styleText: row.style_text,
        createdAt: row.created_at,
      };
      return `${i + 1}. ${style.styleText.slice(0, 420)}`;
    }),
  ].join('\n');
}

export function formatMistakePracticePrompt(mistake: MistakeItem) {
  const kps = mistake.mappings?.map((m) => m.title).join('、') || '这道错题相关知识点';
  return `请围绕我的错题做举一反三集中练习。错题标题：${mistake.title}。知识点：${kps}。先用一句话指出核心错因，再出一道同结构但不照抄原题的变式题。`;
}
