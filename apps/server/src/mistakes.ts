import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { SystemMessage, HumanMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import * as OcrPkg from '@alicloud/ocr-api20210707';
const OcrRuntime = OcrPkg as any;
const OcrClient = (OcrRuntime.default?.default ?? OcrRuntime.default ?? OcrRuntime) as new (config: any) => {
  recognizeEduPaperOcr(req: any): Promise<any>;
  recognizeEduPaperStructed(req: any): Promise<any>;
};
const { RecognizeEduPaperOcrRequest, RecognizeEduPaperStructedRequest } = OcrRuntime;
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
  /** LLM 对该题学生是否答对的语义判断（应用题字符串相似度不可靠时以此为准） */
  isCorrect?: boolean;
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

/**
 * 轻量归一化：仅统一大小写/全角/空白，保留符号、选项字母与序号。
 * 用于在 normalizeAnswer 把符号清空之前先做一次"宽松相等"判断，
 * 修复 "<"、"②"、"A"、"391, 25" 等答案被清空后误判为 0 分的问题。
 */
function looseNormalize(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\s+/g, '');
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

  // 先做保留符号的宽松相等判断，避免 "<"/"②"/"A" 等被后续归一化清空后误判
  if (looseNormalize(s) === looseNormalize(c)) return 1;

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

/**
 * 判定该题学生是否答对（用于把"做对的题"从错题本过滤）。
 * 字符串相似度对应用题不可靠：学生写整段过程、参考答案却很简短，相似度天然偏低，
 * 而 LLM 已对题目做了语义批改。因此优先信任 LLM 的判断，相似度仅作兜底：
 *   1. 学生未作答 → 一定不算做对，保留待复核
 *   2. LLM 显式 isCorrect 布尔值 → 直接采用
 *   3. LLM 错因明确为"无错误" → 视为做对
 *   4. 否则回退到字符串相似度阈值
 */
function resolveIsCorrect(analysis: AnalysisJson, studentAnswer: string | undefined, matchScore: number): boolean {
  const answer = studentAnswer?.trim() ?? '';
  if (!answer || answer === '未提供' || answer === '未作答' || answer === '空') return false;
  if (typeof analysis.isCorrect === 'boolean') return analysis.isCorrect;
  const errorType = (analysis.errorType ?? '').trim().toLowerCase();
  const noErrorMarkers = ['none', 'no_error', 'no error', 'correct', '无', '无错误', '无误', '正确', '正确无误'];
  if (noErrorMarkers.includes(errorType)) return true;
  return matchScore >= ANSWER_MATCH_THRESHOLD;
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
  const payload = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};

  // RecognizeEduPaperOcr returns reading-order text in `content`. Recursively
  // collecting every response string duplicates words and metadata, which
  // causes unreliable downstream question splitting.
  const content = typeof payload.content === 'string' ? payload.content.trim() : '';
  if (content) return { raw, text: content };

  const words = Array.isArray(payload.prism_wordsInfo)
    ? payload.prism_wordsInfo
      .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
      .map((item) => ({
        text: typeof item.word === 'string' ? item.word.trim() : '',
        y: Number(item.y ?? (item.pos as any)?.[0]?.y ?? 0),
        x: Number(item.x ?? (item.pos as any)?.[0]?.x ?? 0),
      }))
      .filter((item) => item.text)
      .sort((a, b) => a.y - b.y || a.x - b.x)
    : [];
  if (words.length) return { raw, text: words.map((item) => item.text).join('\n') };

  const texts = collectTextValues(raw)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  return { raw, text: [...new Set(texts)].slice(0, 80).join('\n') };
}

function legacySubjectForAliyun(subject: string, grade: string) {
  const n = Number(grade);
  const isPrimary = Number.isFinite(n) && n >= 1 && n <= 6;
  const isMiddle = Number.isFinite(n) && n >= 7 && n <= 9;
  if (subject === 'math') return isPrimary ? 'PrimarySchool_Math' : isMiddle ? 'JHighSchool_Math' : 'Math';
  if (subject === 'chinese') return isPrimary ? 'PrimarySchool_Chinese' : 'Chinese';
  if (subject === 'english') return isPrimary ? 'PrimarySchool_English' : isMiddle ? 'JHighSchool_English' : 'English';
  return 'default';
}

/** 阿里云 ACK 签名辅助：计算 HMAC-SHA1 */
function subjectForAliyun(subject: string, grade: string) {
  const n = Number(grade);
  const isPrimary = Number.isFinite(n) && n >= 1 && n <= 6;
  const isMiddle = Number.isFinite(n) && n >= 7 && n <= 9;
  if (subject === 'math') return isPrimary ? 'PrimarySchool_Math' : isMiddle ? 'JHighSchool_Math' : 'Math';
  if (subject === 'chinese') return isPrimary ? 'PrimarySchool_Chinese' : 'Chinese';
  if (subject === 'english') return isPrimary ? 'PrimarySchool_English' : isMiddle ? 'JHighSchool_English' : 'English';
  return 'default';
}

/** 用 Buffer 替代 ReadStream 传给 SDK（避免 @alicloud/openapi-core v1.0.7 的 stream 兼容问题） */
function readableFromBuffer(buf: Buffer): Readable {
  return Readable.from(buf);
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

export async function recognizeWithAliyunEduOcr(filePath: string, subject: string, grade: string): Promise<OcrResult> {
  const client = getAliyunOcrClient();
  const imageBuf = readFileSync(filePath);
  const request = new RecognizeEduPaperOcrRequest({
    subject: subjectForAliyun(subject, grade),
    imageType: process.env.ALIYUN_OCR_IMAGE_TYPE ?? 'photo',
    outputOricoord: (process.env.ALIYUN_OCR_OUTPUT_ORICOORD ?? 'true') !== 'false',
    // 用 Buffer 创建的 Readable 替代 createReadStream，避免 SDK 的 stream 兼容问题
    body: readableFromBuffer(imageBuf) as any,
  });
  console.log(`[OCR] SDK 请求, 图片 ${imageBuf.length} bytes, subject=${request.subject}`);
  const response = await client.recognizeEduPaperOcr(request);
  const body = response.body;
  console.log(`[OCR] SDK 响应 code=${body?.code}, msg=${String(body?.message ?? '').slice(0, 200)}`);
  if (response.statusCode !== 200 || (body?.code && body.code !== '200')) {
    throw new Error(`阿里云 OCR 识别失败：${body.message ?? body.code}`);
  }
  const normalized = normalizeOcrText(body?.data);
  if (!normalized.text.trim()) {
    throw new Error('阿里云 OCR 未返回可用题目文本');
  }

  // Structed returns layout/cut coordinates rather than text. Keep it as
  // optional traceability metadata, never as the source of LLM input.
  let structure: unknown = undefined;
  if ((process.env.ALIYUN_OCR_USE_STRUCTURE ?? 'true') !== 'false') {
    try {
      const structureResponse = await client.recognizeEduPaperStructed(new RecognizeEduPaperStructedRequest({
        subject: subjectForAliyun(subject, grade),
        needRotate: (process.env.ALIYUN_OCR_NEED_ROTATE ?? 'true') !== 'false',
        outputOricoord: (process.env.ALIYUN_OCR_OUTPUT_ORICOORD ?? 'true') !== 'false',
        body: readableFromBuffer(imageBuf) as any,
      }));
      if (structureResponse.statusCode === 200 && (!structureResponse.body?.code || structureResponse.body.code === '200')) {
        structure = safeJson<unknown>(structureResponse.body?.data ?? '', structureResponse.body?.data ?? null);
      }
    } catch (err) {
      console.warn('[OCR] 结构化切题元数据不可用，将继续使用整页识别结果:', err instanceof Error ? err.message : String(err));
    }
  }
  return {
    provider: 'aliyun:RecognizeEduPaperOcr+RecognizeEduPaperStructed',
    raw: { requestId: body?.requestId, code: body?.code, data: normalized.raw, structure },
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

function redactOcrPersonalInfo(text: string): string {
  // Photos of school papers often put a name, student number, and class on the
  // same line as the title. Keep the question body local and do not send those
  // identifiers to the analysis model.
  return text
    .replace(
      /(?:班级|姓名|学号|考号|座位号)\s*[：:][\s\S]{0,100}?(?=(?:基础知识|积累与运用|一[、.．]|二[、.．]|三[、.．]|四[、.．]|五[、.．]|\d+[、.．]))/g,
      '',
    )
    .replace(/(?:姓名|学号|考号|座位号)\s*[：:]\s*[^\n]{0,40}/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function analyzeWithLlm(model: BaseChatModel, params: {
  subject: string;
  grade: string;
  recognizedText: string;
  studentAnswer?: string;
  candidates: CandidateNode[];
}): Promise<AnalysisJson[]> {
  const analysisText = redactOcrPersonalInfo(params.recognizedText);
  // Embedding retrieval initializes an ONNX runtime in-process. Keep the OCR
  // transaction independent from that optional enrichment so a local embedding
  // failure cannot terminate the model request or block mistake intake.
  const related: string[] = [];
  const compactCandidates = '';
  const concisePrompt = [
    'Extract every question from this school-paper OCR text. Return only a compact JSON array.',
    'Each item must include subject, title, promptText, studentAnswer, correctAnswer, explanation, errorType, errorReason, isCorrect, confidence, questionType, difficulty, and knowledgeNodes.',
    'isCorrect is a boolean judging whether the student actually answered correctly. Word/application problems: the student often writes full working such as "740-492=248(个) 答：北区有248个洞窟。" while the reference answer is terse like "248个" — judge by whether the final result is right, never by text overlap. When correct, set isCorrect=true and errorType="none". Set isCorrect=false only for genuine errors; if the student left the answer blank, set isCorrect=false and errorType="unanswered".',
    'knowledgeNodes is an array of { kgNodeId, title, role, confidence, evidence }. Only use IDs from the candidate list. Keep explanations under 100 Chinese characters.',
    `Subject: ${params.subject}; grade: ${params.grade}`,
    `Candidates: ${compactCandidates || 'none'}`,
    `OCR text:\n${analysisText}`,
    params.studentAnswer ? `Student answer:\n${params.studentAnswer}` : '',
    related.length ? `Curriculum context:\n${related.join('\n')}` : '',
  ].filter(Boolean).join('\n\n');
  console.log(`[mistakes] LLM analysis input: ${concisePrompt.length} characters, ${params.candidates.length} candidate nodes`);
  const conciseResponse = await model.invoke([
    new SystemMessage('Return valid JSON only.'),
    new HumanMessage(concisePrompt),
  ]);
  const conciseContent = typeof conciseResponse.content === 'string' ? conciseResponse.content : String(JSON.stringify(conciseResponse.content ?? null));
  const conciseParsed = safeParseJson(String(conciseContent || '[]'));
  return Array.isArray(conciseParsed) ? conciseParsed as AnalysisJson[] : conciseParsed ? [conciseParsed as AnalysisJson] : [];

  const candidateText = params.candidates
    .slice(0, 24)
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
    analysisText || '（空）',
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

  console.log(`[mistakes] LLM analysis input: ${prompt.length} characters, ${params.candidates.length} candidate nodes`);
  const response = await model.invoke([
    new SystemMessage('你只输出可解析 JSON。'),
    new HumanMessage(prompt),
  ]);
  const content = typeof response.content === 'string' ? response.content : String(JSON.stringify(response.content ?? null));
  const parsed = safeParseJson(String(content || '[]'));
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

/** 抽象风格字段（题型/难度/情境/推理/干扰/呈现/摘要），不含原题原文 */
function styleFields(analysis: AnalysisJson): string[] {
  return [
    `题型: ${analysis.questionType ?? '综合题'}`,
    `难度: ${normalizeDifficulty(analysis.difficulty)}`,
    `情境: ${analysis.scenarioType ?? '常规学习场景'}`,
    `推理结构: ${analysis.reasoningPattern ?? '提取条件并分步求解'}`,
    analysis.distractorPattern ? `干扰模式: ${analysis.distractorPattern}` : '',
    analysis.presentationFeatures ? `呈现特征: ${JSON.stringify(analysis.presentationFeatures)}` : '',
    analysis.styleText ? `风格摘要: ${analysis.styleText}` : '',
  ].filter(Boolean);
}

/** 单题风格文本（含原题结构摘要切片，仅存入 per-user 审计表 mistake_style_features） */
function buildStyleText(analysis: AnalysisJson, promptText: string) {
  return [
    ...styleFields(analysis),
    `原题结构摘要: ${promptText.replace(/\s+/g, ' ').slice(0, 240)}`,
  ].join('\n');
}

/** 全局技能文本：去掉原题原文切片，作为跨用户外泄的隐私保险 */
function buildSkillText(analysis: AnalysisJson) {
  return styleFields(analysis).join('\n');
}

/**
 * 写入单题风格审计行（mistake_style_features），并把算好的向量返回，
 * 供全局技能库 create-or-reinforce 复用（避免二次 embedding）。
 */
async function saveStyleFeature(
  mistakeId: string,
  analysis: AnalysisJson,
  promptText: string,
): Promise<{ styleText: string; vector: number[] | null }> {
  const styleText = buildStyleText(analysis, promptText);
  let vector: number[] | null = null;
  try {
    const [vec] = await embedTexts([styleText]);
    vector = vec ?? null;
  } catch {
    vector = null;
  }
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
    vector ? vectorToBlob(vector) : null,
  );
  return { styleText, vector };
}

// ── 全局「出题风格技能库」参数 ──
/** 向量相似度达到即合并进同一技能（bge-small-zh 归一化向量） */
const STYLE_SKILL_MERGE_THRESHOLD = 0.86;
/** 单次 create-or-reinforce / 检索的候选扫描上限，封顶内存 cosine 量 */
const STYLE_SKILL_CANDIDATE_LIMIT = 200;
/** source_user_ids 记录的来源用户数上限，封顶单行体积 */
const STYLE_SKILL_SOURCE_USER_CAP = 50;

/** 向量归一化（质心更新后恢复单位长度，使 cosine=点积成立） */
function normalizeVector(v: number[]): number[] {
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  return v.map((x) => x / norm);
}

/** 技能排序/门槛权重：被反复强化、被多人验证的风格更靠前（封顶 0.25 防爆款霸屏） */
function computeStyleSkillWeight(reinforceCount: number, distinctUserCount: number): number {
  return Math.min(0.25, Math.log2(1 + reinforceCount) * 0.05 + Math.min(distinctUserCount, 5) * 0.02);
}

/**
 * 全局风格技能 create-or-reinforce：在同 学科+年级 桶内找最相近技能，
 * 相似度≥阈值则强化（计数+1、质心增量更新），否则新建。同步、纯 DB + 内存向量扫描，
 * 复用 saveStyleFeature 已算好的向量，绝不抛异常进 analyze/SSE 流。
 */
function sedimentGlobalStyleSkill(opts: {
  subject: string;
  grade: string;
  userId: string;
  kgNodeId: number | null;
  analysis: AnalysisJson;
  vector: number[] | null;
}): void {
  const { subject, grade, userId, kgNodeId, analysis, vector } = opts;
  if (!vector) return;
  try {
    const candidates = db.prepare(`
      SELECT id, embedding, reinforce_count, distinct_user_count, source_user_ids
      FROM style_skills
      WHERE subject=? AND grade=?
      ORDER BY quality_weight DESC, last_seen_at DESC
      LIMIT ?
    `).all(subject, grade, STYLE_SKILL_CANDIDATE_LIMIT) as Array<{
      id: number; embedding: Buffer; reinforce_count: number; distinct_user_count: number; source_user_ids: string | null;
    }>;

    let best: { sim: number; row: (typeof candidates)[number] } | null = null;
    for (const row of candidates) {
      const sim = cosineSim(vector, blobToVector(row.embedding));
      if (!best || sim > best.sim) best = { sim, row };
    }

    const now = nowSec();
    if (best && best.sim >= STYLE_SKILL_MERGE_THRESHOLD) {
      const row = best.row;
      const sources = row.source_user_ids ? safeJson<string[]>(row.source_user_ids, []) : [];
      const isNewUser = !sources.includes(userId);
      if (isNewUser && sources.length < STYLE_SKILL_SOURCE_USER_CAP) sources.push(userId);
      const reinforceCount = row.reinforce_count + 1;
      const distinctUserCount = row.distinct_user_count + (isNewUser ? 1 : 0);
      // 质心增量更新：旧向量按旧计数加权 + 新向量，再归一化
      const oldVec = blobToVector(row.embedding);
      const merged = normalizeVector(oldVec.map((x, i) => x * row.reinforce_count + vector[i]));
      db.prepare(`
        UPDATE style_skills SET
          embedding=?, reinforce_count=?, distinct_user_count=?, source_user_ids=?,
          quality_weight=?, updated_at=?, last_seen_at=?
        WHERE id=?
      `).run(
        vectorToBlob(merged), reinforceCount, distinctUserCount, JSON.stringify(sources),
        computeStyleSkillWeight(reinforceCount, distinctUserCount), now, now, row.id,
      );
    } else {
      db.prepare(`
        INSERT INTO style_skills (
          subject, grade, kg_node_id, question_type, difficulty, skill_text,
          embedding, reinforce_count, distinct_user_count, source_user_ids, quality_weight,
          created_at, updated_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?, ?)
      `).run(
        subject, grade, kgNodeId ?? null,
        analysis.questionType ?? '综合题',
        normalizeDifficulty(analysis.difficulty),
        buildSkillText(analysis),
        vectorToBlob(vector),
        JSON.stringify([userId]),
        computeStyleSkillWeight(1, 1), now, now, now,
      );
    }
  } catch (err) {
    console.warn('[mistakes] 全局风格技能沉淀失败（已忽略）:', err instanceof Error ? err.message : String(err));
  }
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

  // Some compatible models omit the candidate IDs even when they correctly
  // extract the question. Retain a low-confidence, auditable lexical fallback
  // so the item is still filed and can improve from later user corrections.
  if (!mappings.length && candidates.length) {
    const questionText = `${analysis.title ?? ''} ${analysis.promptText ?? recognizedText}`;
    const scored = candidates.map((candidate) => {
      const terms = candidate.title.match(/[\u4e00-\u9fff]{2,}|[A-Za-z0-9]+/g) ?? [];
      const score = terms.reduce((total, term) => total + (questionText.includes(term) ? term.length : 0), 0);
      return { candidate, score };
    }).sort((a, b) => b.score - a.score || a.candidate.id - b.candidate.id);
    const best = scored[0]?.candidate;
    if (best) {
      mappings.push({
        mistakeId,
        kgNodeId: best.id,
        title: best.title,
        unitId: best.unitId,
        unitTitle: best.unitTitle,
        role: 'primary',
        confidence: Math.max(0.35, Math.min(0.58, 0.35 + (scored[0].score > 0 ? 0.15 : 0))),
        evidence: '根据题面关键词自动匹配，待后续复核',
        evidenceJson: JSON.stringify({ evidence: 'lexical fallback', llmTitle: analysis.title ?? '' }),
      });
    }
  }

  const status: MistakeStatus = mappings.length > 0 ? 'analyzed' : 'needs_review';
  const now = nowSec();

  // ── 是否做对：以 LLM 语义判断为主，字符串相似度兜底 ──
  // 做对的题：前端错题列表过滤、熟练度不再扣减，但题型风格仍沉淀
  const studentAnswerForMatch = analysis.studentAnswer?.trim() || row.student_answer || undefined;
  const matchScore = computeAnswerMatchScore(studentAnswerForMatch, analysis.correctAnswer?.trim() || undefined);
  const isCorrect = resolveIsCorrect(analysis, studentAnswerForMatch, matchScore);

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
    const { vector } = await saveStyleFeature(mistakeId, analysis, analysis.promptText || recognizedText);
    // 复用刚算好的向量，把风格沉淀进全服务器风格技能库（create-or-reinforce）
    // 用 detectedSubject 入桶，与错题记录最终学科保持一致
    const primaryKgNodeId = (mappings.find((m) => m.role === 'primary') ?? mappings[0])?.kgNodeId ?? null;
    sedimentGlobalStyleSkill({ subject: detectedSubject, grade: row.grade, userId, kgNodeId: primaryKgNodeId, analysis, vector });
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
  await onProgress?.({ step: 'ocr', message: row.source_type === 'text' ? '读取文本录入' : '调用 OCR 识别', progress: 8 });
  let recognizedText = String(row.prompt_text ?? '').trim();
  let ocrProvider: string | null = row.ocr_provider ?? null;
  let ocrRaw: unknown = row.ocr_raw ? safeJson(row.ocr_raw, {}) : null;
  if (!recognizedText.trim() && row.source_type === 'image') {
    const assetPath = getOriginalAssetPath(mistakeId);
    if (!assetPath) throw new Error('找不到原始图片');
    const ocr = await recognizeWithAliyunEduOcr(assetPath, row.subject, row.grade);
    recognizedText = ocr.text || recognizedText;
    ocrProvider = ocr.provider;
    ocrRaw = ocr.raw;
    // 写回 DB 供前端展示
    if (recognizedText.trim()) {
      db.prepare(`UPDATE mistake_items SET prompt_text=?, ocr_provider=?, updated_at=? WHERE id=?`).run(recognizedText, ocrProvider, Math.floor(Date.now() / 1000), mistakeId);
    }
  }
  if (!recognizedText.trim()) throw new Error('OCR 未识别到有效题目文本，请补充题面后重试');

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

/**
 * 全服务器出题风格技能检索（纯全局池，按 学科+年级 跨用户共享）。
 * 排序 = 向量相似度 + 知识点命中(0.35) + 强化权重(热门/多人验证更靠前) + 新鲜度(≤0.12)。
 * 候选先按权重/新鲜度截断 200 行再算 cosine，使单次扫描量恒定。
 */
export async function retrieveGlobalStyleSkills(subject: string, grade: string, query: string, kgNodeIds: number[] = [], limit = 3): Promise<string> {
  const rows = db.prepare(`
    SELECT id, kg_node_id, skill_text, embedding, reinforce_count, distinct_user_count, quality_weight, last_seen_at
    FROM style_skills
    WHERE subject=? AND grade=?
    ORDER BY quality_weight DESC, last_seen_at DESC
    LIMIT ?
  `).all(subject, grade, STYLE_SKILL_CANDIDATE_LIMIT) as Array<{
    id: number; kg_node_id: number | null; skill_text: string; embedding: Buffer;
    reinforce_count: number; distinct_user_count: number; quality_weight: number; last_seen_at: number;
  }>;
  if (!rows.length) return '';
  let queryVector: number[] | null = null;
  if (query.trim()) {
    try {
      queryVector = await embedQuery(query);
    } catch (err) {
      console.warn('[mistakes] global style embedding query failed:', err);
      queryVector = null;
    }
  }
  const targetIds = new Set(kgNodeIds);
  const ranked = rows.map((row) => {
    const overlap = row.kg_node_id != null && targetIds.has(row.kg_node_id) ? 0.35 : 0;
    const sim = queryVector ? cosineSim(queryVector, blobToVector(row.embedding)) : 0;
    const reinforceWeight = computeStyleSkillWeight(row.reinforce_count, row.distinct_user_count);
    const recency = Math.max(0, Math.min(0.12, (row.last_seen_at ?? 0) / Math.max(1, nowSec()) * 0.12));
    return { row, score: sim + overlap + reinforceWeight + recency };
  }).sort((a, b) => b.score - a.score).slice(0, limit);
  if (!ranked.length) return '';
  return [
    '【跨校沉淀出题风格技能】以下为全平台真实错题沉淀的题型风格，仅用于学习题型结构、出题逻辑、情境选取与干扰方式，严禁复刻原题文字、数字、学生答案或隐私信息。',
    ...ranked.map(({ row }, i) => `${i + 1}. ${row.skill_text.slice(0, 420)}`),
  ].join('\n');
}

/**
 * 从现有 mistake_style_features 一次性回填全局风格技能库。
 * 复用已存的 embedding BLOB（零重新 embedding），按时间顺序走同一套 create-or-reinforce 逻辑。
 * 幂等：先全量清空再重建，可反复运行。
 */
export function backfillStyleSkills(): { created: number; reinforced: number; scanned: number } {
  const rows = db.prepare(`
    SELECT sf.style_text, sf.embedding, sf.question_type, sf.difficulty, sf.scenario_type,
           sf.reasoning_pattern, sf.distractor_pattern, sf.presentation_features,
           mi.user_id, mi.subject, mi.grade,
           (SELECT km.kg_node_id FROM mistake_kp_map km
            WHERE km.mistake_id = sf.mistake_id
            ORDER BY CASE km.role WHEN 'primary' THEN 0 WHEN 'related' THEN 1 ELSE 2 END, km.confidence DESC
            LIMIT 1) AS primary_kg_node_id
    FROM mistake_style_features sf
    JOIN mistake_items mi ON mi.id = sf.mistake_id
    WHERE (mi.status='analyzed' OR mi.is_correct=1)
    ORDER BY sf.created_at ASC
  `).all() as Array<{
    style_text: string; embedding: Buffer | null; question_type: string; difficulty: string;
    scenario_type: string; reasoning_pattern: string; distractor_pattern: string | null;
    presentation_features: string | null; user_id: string; subject: string; grade: string;
    primary_kg_node_id: number | null;
  }>;

  db.exec(`DELETE FROM style_skills`);

  let scanned = 0;
  for (const r of rows) {
    if (!r.embedding) continue;
    scanned++;
    const analysis: AnalysisJson = {
      questionType: r.question_type,
      difficulty: normalizeDifficulty(r.difficulty),
      scenarioType: r.scenario_type,
      reasoningPattern: r.reasoning_pattern,
      distractorPattern: r.distractor_pattern ?? undefined,
      presentationFeatures: r.presentation_features ? safeJson(r.presentation_features, undefined) : undefined,
    };
    sedimentGlobalStyleSkill({
      subject: r.subject,
      grade: r.grade,
      userId: r.user_id,
      kgNodeId: r.primary_kg_node_id ?? null,
      analysis,
      vector: blobToVector(r.embedding),
    });
  }
  const created = (db.prepare(`SELECT COUNT(*) AS c FROM style_skills`).get() as { c: number }).c;
  return { created, reinforced: Math.max(0, scanned - created), scanned };
}

export function formatMistakePracticePrompt(mistake: MistakeItem) {
  const kps = mistake.mappings?.map((m) => m.title).join('、') || '这道错题相关知识点';
  return `请围绕我的错题做举一反三集中练习。错题标题：${mistake.title}。知识点：${kps}。先用一句话指出核心错因，再出一道同结构但不照抄原题的变式题。`;
}
