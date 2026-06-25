import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { SystemMessage, HumanMessage } from '@langchain/core/messages';
import * as OcrPkg from '@alicloud/ocr-api20210707';
const OcrRuntime = OcrPkg;
const OcrClient = (OcrRuntime.default?.default ?? OcrRuntime.default ?? OcrRuntime);
const { RecognizeEduPaperOcrRequest, RecognizeEduPaperStructedRequest } = OcrRuntime;
import * as OpenApi from '@alicloud/openapi-client';
import db from './db.js';
import { blobToVector, cosineSim, embedQuery, embedTexts, vectorToBlob } from './embeddings.js';
import { ASSET_ROOT } from './paths.js';
const MAX_IMAGE_MB = Number(process.env.ALIYUN_OCR_MAX_IMAGE_MB ?? '8');
const MAX_IMAGE_BYTES = Math.max(1, MAX_IMAGE_MB) * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
function nowSec() {
    return Math.floor(Date.now() / 1000);
}
function safeSegment(value) {
    return value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'user';
}
function ensureDir(path) {
    if (!existsSync(path))
        mkdirSync(path, { recursive: true });
}
function extForMime(mimeType, filename) {
    const fromName = filename ? basename(filename).match(/\.[a-zA-Z0-9]+$/)?.[0]?.toLowerCase() : undefined;
    if (fromName && ['.jpg', '.jpeg', '.png', '.webp'].includes(fromName))
        return fromName;
    if (mimeType === 'image/png')
        return '.png';
    if (mimeType === 'image/webp')
        return '.webp';
    return '.jpg';
}
function toPublicAsset(row) {
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
function toMistake(row) {
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
function safeJson(raw, fallback) {
    try {
        return JSON.parse(raw);
    }
    catch {
        return fallback;
    }
}
function normalizeDifficulty(value) {
    return value === 'easy' || value === 'hard' || value === 'medium' ? value : 'medium';
}
function normalizeRole(value) {
    return value === 'primary' || value === 'prerequisite' || value === 'related' ? value : 'related';
}
function clampConfidence(value, fallback = 0.6) {
    const n = Number(value);
    if (!Number.isFinite(n))
        return fallback;
    return Math.max(0, Math.min(1, n));
}
/** 答案匹配度判定阈值：达到即视为大概率做对，前端错题列表过滤但题型风格仍沉淀 */
export const ANSWER_MATCH_THRESHOLD = 0.8;
/** Levenshtein 编辑距离（字符级） */
function levenshtein(a, b) {
    const m = a.length;
    const n = b.length;
    if (!m)
        return n;
    if (!n)
        return m;
    let prev = Array.from({ length: n + 1 }, (_, i) => i);
    let curr = new Array(n + 1);
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
function looseNormalize(raw) {
    return raw
        .toLowerCase()
        .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
        .replace(/\s+/g, '');
}
/** 答案文本归一化：全角转半角、去空白标点、去常见单位量词、去选项前缀 */
function normalizeAnswer(raw) {
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
export function computeAnswerMatchScore(studentAnswer, correctAnswer) {
    const s = (studentAnswer ?? '').trim();
    const c = (correctAnswer ?? '').trim();
    if (!s || !c)
        return 0;
    // 先做保留符号的宽松相等判断，避免 "<"/"②"/"A" 等被后续归一化清空后误判
    if (looseNormalize(s) === looseNormalize(c))
        return 1;
    const ns = normalizeAnswer(s);
    const nc = normalizeAnswer(c);
    if (!ns || !nc)
        return 0;
    if (ns === nc)
        return 1;
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
    const bigrams = (str) => {
        const set = new Set();
        for (let i = 0; i < str.length - 1; i++)
            set.add(str.slice(i, i + 2));
        return set;
    };
    const bs = bigrams(ns);
    const bc = bigrams(nc);
    let inter = 0;
    for (const b of bs)
        if (bc.has(b))
            inter++;
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
function resolveIsCorrect(analysis, studentAnswer, matchScore) {
    const answer = studentAnswer?.trim() ?? '';
    if (!answer || answer === '未提供' || answer === '未作答' || answer === '空')
        return false;
    if (typeof analysis.isCorrect === 'boolean')
        return analysis.isCorrect;
    const errorType = (analysis.errorType ?? '').trim().toLowerCase();
    const noErrorMarkers = ['none', 'no_error', 'no error', 'correct', '无', '无错误', '无误', '正确', '正确无误'];
    if (noErrorMarkers.includes(errorType))
        return true;
    return matchScore >= ANSWER_MATCH_THRESHOLD;
}
function safeParseJson(raw) {
    const trimmed = raw.trim();
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
    const input = fenced || trimmed;
    try {
        return JSON.parse(input);
    }
    catch {
        const match = input.match(/\{[\s\S]*\}/);
        if (match) {
            try {
                return JSON.parse(match[0].replace(/,\s*([}\]])/g, '$1'));
            }
            catch {
                /* continue */
            }
        }
    }
    throw new Error('LLM 返回的分析 JSON 无法解析');
}
function collectTextValues(value, acc = [], depth = 0) {
    if (depth > 8 || value == null)
        return acc;
    if (typeof value === 'string') {
        const text = value.trim();
        if (text.length >= 2 && text.length <= 4000)
            acc.push(text);
        return acc;
    }
    if (Array.isArray(value)) {
        for (const item of value)
            collectTextValues(item, acc, depth + 1);
        return acc;
    }
    if (typeof value === 'object') {
        const obj = value;
        for (const key of ['content', 'text', 'word', 'words', 'question', 'answer', 'stem', 'value', 'data']) {
            if (key in obj)
                collectTextValues(obj[key], acc, depth + 1);
        }
        for (const [key, child] of Object.entries(obj)) {
            if (['content', 'text', 'word', 'words', 'question', 'answer', 'stem', 'value', 'data'].includes(key))
                continue;
            collectTextValues(child, acc, depth + 1);
        }
    }
    return acc;
}
function normalizeOcrText(rawData) {
    if (!rawData)
        return { raw: {}, text: '' };
    const raw = safeJson(rawData, rawData);
    const payload = raw && typeof raw === 'object' && !Array.isArray(raw)
        ? raw
        : {};
    // RecognizeEduPaperOcr returns reading-order text in `content`. Recursively
    // collecting every response string duplicates words and metadata, which
    // causes unreliable downstream question splitting.
    const content = typeof payload.content === 'string' ? payload.content.trim() : '';
    if (content)
        return { raw, text: content };
    const words = Array.isArray(payload.prism_wordsInfo)
        ? payload.prism_wordsInfo
            .filter((item) => Boolean(item && typeof item === 'object'))
            .map((item) => ({
            text: typeof item.word === 'string' ? item.word.trim() : '',
            y: Number(item.y ?? item.pos?.[0]?.y ?? 0),
            x: Number(item.x ?? item.pos?.[0]?.x ?? 0),
        }))
            .filter((item) => item.text)
            .sort((a, b) => a.y - b.y || a.x - b.x)
        : [];
    if (words.length)
        return { raw, text: words.map((item) => item.text).join('\n') };
    const texts = collectTextValues(raw)
        .map((s) => s.replace(/\s+/g, ' ').trim())
        .filter(Boolean);
    return { raw, text: [...new Set(texts)].slice(0, 80).join('\n') };
}
function legacySubjectForAliyun(subject, grade) {
    const n = Number(grade);
    const isPrimary = Number.isFinite(n) && n >= 1 && n <= 6;
    const isMiddle = Number.isFinite(n) && n >= 7 && n <= 9;
    if (subject === 'math')
        return isPrimary ? 'PrimarySchool_Math' : isMiddle ? 'JHighSchool_Math' : 'Math';
    if (subject === 'chinese')
        return isPrimary ? 'PrimarySchool_Chinese' : 'Chinese';
    if (subject === 'english')
        return isPrimary ? 'PrimarySchool_English' : isMiddle ? 'JHighSchool_English' : 'English';
    return 'default';
}
/** 阿里云 ACK 签名辅助：计算 HMAC-SHA1 */
function subjectForAliyun(subject, grade) {
    const n = Number(grade);
    const isPrimary = Number.isFinite(n) && n >= 1 && n <= 6;
    const isMiddle = Number.isFinite(n) && n >= 7 && n <= 9;
    if (subject === 'math')
        return isPrimary ? 'PrimarySchool_Math' : isMiddle ? 'JHighSchool_Math' : 'Math';
    if (subject === 'chinese')
        return isPrimary ? 'PrimarySchool_Chinese' : 'Chinese';
    if (subject === 'english')
        return isPrimary ? 'PrimarySchool_English' : isMiddle ? 'JHighSchool_English' : 'English';
    return 'default';
}
/** 用 Buffer 替代 ReadStream 传给 SDK（避免 @alicloud/openapi-core v1.0.7 的 stream 兼容问题） */
function readableFromBuffer(buf) {
    return Readable.from(buf);
}
let aliyunClient = null;
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
        aliyunClient = new OcrClient(config);
    }
    return aliyunClient;
}
export async function recognizeWithAliyunEduOcr(filePath, subject, grade) {
    const client = getAliyunOcrClient();
    const imageBuf = readFileSync(filePath);
    const request = new RecognizeEduPaperOcrRequest({
        subject: subjectForAliyun(subject, grade),
        imageType: process.env.ALIYUN_OCR_IMAGE_TYPE ?? 'photo',
        outputOricoord: (process.env.ALIYUN_OCR_OUTPUT_ORICOORD ?? 'true') !== 'false',
        // 用 Buffer 创建的 Readable 替代 createReadStream，避免 SDK 的 stream 兼容问题
        body: readableFromBuffer(imageBuf),
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
    let structure = undefined;
    if ((process.env.ALIYUN_OCR_USE_STRUCTURE ?? 'true') !== 'false') {
        try {
            const structureResponse = await client.recognizeEduPaperStructed(new RecognizeEduPaperStructedRequest({
                subject: subjectForAliyun(subject, grade),
                needRotate: (process.env.ALIYUN_OCR_NEED_ROTATE ?? 'true') !== 'false',
                outputOricoord: (process.env.ALIYUN_OCR_OUTPUT_ORICOORD ?? 'true') !== 'false',
                body: readableFromBuffer(imageBuf),
            }));
            if (structureResponse.statusCode === 200 && (!structureResponse.body?.code || structureResponse.body.code === '200')) {
                structure = safeJson(structureResponse.body?.data ?? '', structureResponse.body?.data ?? null);
            }
        }
        catch (err) {
            console.warn('[OCR] 结构化切题元数据不可用，将继续使用整页识别结果:', err instanceof Error ? err.message : String(err));
        }
    }
    return {
        provider: 'aliyun:RecognizeEduPaperOcr+RecognizeEduPaperStructed',
        raw: { requestId: body?.requestId, code: body?.code, data: normalized.raw, structure },
        text: normalized.text,
    };
}
function getCandidateNodes(subject, grade, limit = 80) {
    const rows = db.prepare(`
    SELECT DISTINCT n.id, n.title, n.subject, u.id AS unit_id, u.title AS unit_title, COALESCE(n.weight, 0.5) AS weight
    FROM kg_nodes n
    JOIN curriculum_kg_map m ON m.node_id = n.id
    JOIN curriculum_units u ON u.id = m.unit_id
    JOIN curriculum_textbooks t ON t.id = u.textbook_id
    WHERE n.type='knowledge_point' AND t.subject=? AND t.grade=?
    ORDER BY weight DESC, n.title
    LIMIT ?
  `).all(subject, grade, limit);
    if (rows.length) {
        return rows.map((r) => ({
            id: r.id,
            title: r.title,
            subject: r.subject,
            unitId: r.unit_id ?? undefined,
            unitTitle: r.unit_title ?? undefined,
        }));
    }
    return db.prepare(`
    SELECT id, title, subject FROM kg_nodes
    WHERE type='knowledge_point' AND subject=?
    ORDER BY COALESCE(weight, 0.5) DESC, title
    LIMIT ?
  `).all(subject, limit).map((r) => ({ id: r.id, title: r.title, subject: r.subject }));
}
function findCandidateById(id, subject, grade) {
    const row = db.prepare(`
    SELECT DISTINCT n.id, n.title, n.subject, u.id AS unit_id, u.title AS unit_title
    FROM kg_nodes n
    LEFT JOIN curriculum_kg_map m ON m.node_id = n.id
    LEFT JOIN curriculum_units u ON u.id = m.unit_id
    LEFT JOIN curriculum_textbooks t ON t.id = u.textbook_id
    WHERE n.id=? AND n.type='knowledge_point' AND n.subject=?
      AND (t.grade=? OR t.grade IS NULL OR t.grade IS ?)
    LIMIT 1
  `).get(id, subject, grade, null);
    if (!row)
        return undefined;
    return { id: row.id, title: row.title, subject: row.subject, unitId: row.unit_id ?? undefined, unitTitle: row.unit_title ?? undefined };
}
function findCandidateByTitle(title, subject, grade) {
    const clean = title.trim();
    if (!clean)
        return undefined;
    const params = [subject, grade];
    const exact = db.prepare(`
    SELECT DISTINCT n.id, n.title, n.subject, u.id AS unit_id, u.title AS unit_title
    FROM kg_nodes n
    JOIN curriculum_kg_map m ON m.node_id = n.id
    JOIN curriculum_units u ON u.id = m.unit_id
    JOIN curriculum_textbooks t ON t.id = u.textbook_id
    WHERE n.type='knowledge_point' AND t.subject=? AND t.grade=? AND n.title=?
    LIMIT 1
  `).get(...params, clean);
    if (exact)
        return { id: exact.id, title: exact.title, subject: exact.subject, unitId: exact.unit_id, unitTitle: exact.unit_title };
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
  `).get(...params, `%${clean}%`, clean);
    if (!fuzzy)
        return undefined;
    return { id: fuzzy.id, title: fuzzy.title, subject: fuzzy.subject, unitId: fuzzy.unit_id, unitTitle: fuzzy.unit_title };
}
function redactOcrPersonalInfo(text) {
    // Photos of school papers often put a name, student number, and class on the
    // same line as the title. Keep the question body local and do not send those
    // identifiers to the analysis model.
    return text
        .replace(/(?:班级|姓名|学号|考号|座位号)\s*[：:][\s\S]{0,100}?(?=(?:基础知识|积累与运用|一[、.．]|二[、.．]|三[、.．]|四[、.．]|五[、.．]|\d+[、.．]))/g, '')
        .replace(/(?:姓名|学号|考号|座位号)\s*[：:]\s*[^\n]{0,40}/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}
async function analyzeWithLlm(model, params) {
    const analysisText = redactOcrPersonalInfo(params.recognizedText);
    // Embedding retrieval initializes an ONNX runtime in-process. Keep the OCR
    // transaction independent from that optional enrichment so a local embedding
    // failure cannot terminate the model request or block mistake intake.
    const related = [];
    const compactCandidates = '';
    const concisePrompt = [
        'Extract every question from this school-paper OCR text. Return a JSON object with a "questions" field containing the array.',
        'Each item must include subject, title, promptText, studentAnswer, correctAnswer, explanation, errorType, errorReason, isCorrect, confidence, questionType, difficulty, scenarioType, reasoningPattern, distractorPattern, styleText, and knowledgeNodes.',
        'isCorrect is a boolean judging whether the student actually answered correctly. Word/application problems: the student often writes full working such as "740-492=248(个) 答：北区有248个洞窟。" while the reference answer is terse like "248个" — judge by whether the final result is right, never by text overlap. When correct, set isCorrect=true and errorType="none". Set isCorrect=false only for genuine errors; if the student left the answer blank, set isCorrect=false and errorType="unanswered".',
        'questionType MUST be one of the Chinese enum: 选择题/填空题/判断题/计算题/应用题/解答题/阅读题/其他 (never English).',
        'scenarioType = the concrete real-world context in Chinese (e.g. 购物找零/行程问题/图形周长/分类计数); reasoningPattern = the core reasoning structure (e.g. 逆运算求未知数/分步累加); distractorPattern = the common pitfall/wrong-answer pattern (e.g. 加减混淆/进退位出错); styleText = a generalized style summary within 50 Chinese characters describing structure and style ONLY — never copy specific numbers or original wording. These fields are required for every item.',
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
    const conciseParsed = safeParseJson(String(conciseContent || '{}'));
    // 兼容裸数组（旧版 DS）和 {"questions": [...]}（Kimi JSON Mode）
    const arr = Array.isArray(conciseParsed) ? conciseParsed : (conciseParsed && typeof conciseParsed === 'object' ? conciseParsed.questions ?? conciseParsed.items ?? [conciseParsed] : []);
    return arr;
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
        return [parsed];
    }
    return parsed || [];
}
function loadMistakeRows(mistakeId, userId) {
    const mistake = db.prepare(`SELECT * FROM mistake_items WHERE id=? AND user_id=?`).get(mistakeId, userId);
    if (!mistake)
        return null;
    const assets = db.prepare(`SELECT * FROM mistake_assets WHERE mistake_id=? ORDER BY id`).all(mistakeId);
    const mappings = db.prepare(`
    SELECT m.*, n.title, u.title AS unit_title
    FROM mistake_kp_map m
    JOIN kg_nodes n ON n.id = m.kg_node_id
    LEFT JOIN curriculum_units u ON u.id = m.unit_id
    WHERE m.mistake_id=?
    ORDER BY CASE m.role WHEN 'primary' THEN 0 WHEN 'related' THEN 1 ELSE 2 END, m.confidence DESC
  `).all(mistakeId);
    const style = db.prepare(`SELECT * FROM mistake_style_features WHERE mistake_id=? ORDER BY id DESC LIMIT 1`).get(mistakeId);
    const item = toMistake(mistake);
    item.assets = assets.map(toPublicAsset);
    item.mappings = mappings.map((m) => ({
        mistakeId: m.mistake_id,
        kgNodeId: m.kg_node_id,
        title: m.title,
        unitId: m.unit_id ?? undefined,
        unitTitle: m.unit_title ?? undefined,
        role: m.role,
        confidence: m.confidence,
        beforeScore: m.before_score ?? undefined,
        afterScore: m.after_score ?? undefined,
        evidence: m.evidence_json ? safeJson(m.evidence_json, {}).evidence : undefined,
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
export function listMistakes(userId, filters) {
    let sql = `SELECT * FROM mistake_items WHERE user_id=?`;
    const params = [userId];
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
    }
    else {
        sql += ` AND status <> 'archived'`;
    }
    // 默认过滤掉做对的题（前端不再作为错题展示）
    if (!filters.includeCorrect) {
        sql += ` AND is_correct = 0`;
    }
    sql += ` ORDER BY updated_at DESC LIMIT ?`;
    params.push(Math.min(Math.max(filters.limit ?? 30, 1), 100));
    const rows = db.prepare(sql).all(...params);
    const mistakes = rows.map((row) => {
        const item = toMistake(row);
        // 加载映射、资产、风格特征（与 loadMistakeRows 一致，但批量一次查）
        const assets = db.prepare(`SELECT * FROM mistake_assets WHERE mistake_id=? ORDER BY id`).all(item.id);
        item.assets = assets.map(toPublicAsset);
        const mappings = db.prepare(`
      SELECT m.*, n.title, u.title AS unit_title
      FROM mistake_kp_map m
      JOIN kg_nodes n ON n.id = m.kg_node_id
      LEFT JOIN curriculum_units u ON u.id = m.unit_id
      WHERE m.mistake_id=?
      ORDER BY CASE m.role WHEN 'primary' THEN 0 WHEN 'related' THEN 1 ELSE 2 END, m.confidence DESC
    `).all(item.id);
        item.mappings = mappings.map((m) => ({
            mistakeId: m.mistake_id,
            kgNodeId: m.kg_node_id,
            title: m.title,
            unitId: m.unit_id ?? undefined,
            unitTitle: m.unit_title ?? undefined,
            role: m.role,
            confidence: m.confidence,
            beforeScore: m.before_score ?? undefined,
            afterScore: m.after_score ?? undefined,
            evidence: m.evidence_json ? safeJson(m.evidence_json, {}).evidence : undefined,
        }));
        const style = db.prepare(`SELECT * FROM mistake_style_features WHERE mistake_id=? ORDER BY id LIMIT 1`).get(item.id);
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
export function getMistakeDetail(mistakeId, userId) {
    const mistake = loadMistakeRows(mistakeId, userId);
    return mistake ? { mistake } : null;
}
export function createMistake(userId, params) {
    const sourceType = params.sourceType;
    if (sourceType === 'image' && !params.asset) {
        throw new Error('图片错题需要上传图片');
    }
    if (params.asset) {
        if (!ALLOWED_IMAGE_TYPES.has(params.asset.mimeType))
            throw new Error('仅支持 jpg/png/webp 图片');
        if (params.asset.bytes.byteLength > MAX_IMAGE_BYTES)
            throw new Error(`图片不能超过 ${MAX_IMAGE_MB}MB`);
    }
    const id = `mistake-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const now = nowSec();
    db.prepare(`
    INSERT INTO mistake_items (id, user_id, subject, grade, source_type, status, title, prompt_text, student_answer, original_text, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'processing', ?, ?, ?, ?, ?, ?)
  `).run(id, userId, params.subject, params.grade, sourceType, params.promptText?.trim() ? params.promptText.trim().slice(0, 24) : '新错题', params.promptText?.trim() ?? '', params.studentAnswer?.trim() || null, params.note?.trim() || null, now, now);
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
    if (!created)
        throw new Error('创建错题失败');
    return created;
}
function getOriginalAssetPath(mistakeId) {
    const row = db.prepare(`
    SELECT file_path FROM mistake_assets WHERE mistake_id=? AND asset_kind='original' ORDER BY id LIMIT 1
  `).get(mistakeId);
    return row?.file_path;
}
function clearAnalysis(mistakeId) {
    db.prepare(`DELETE FROM mistake_kp_map WHERE mistake_id=?`).run(mistakeId);
    db.prepare(`DELETE FROM mistake_style_features WHERE mistake_id=?`).run(mistakeId);
}
function revertMistakeProficiencyEvents(mistakeId, userId) {
    const events = db.prepare(`
    SELECT * FROM mistake_proficiency_events
    WHERE mistake_id=? AND user_id=? AND reverted_at IS NULL
    ORDER BY applied_at DESC, id DESC
  `).all(mistakeId, userId);
    const mark = db.prepare(`UPDATE mistake_proficiency_events SET reverted_at=? WHERE id=?`);
    const now = nowSec();
    for (const ev of events) {
        const prof = db.prepare(`SELECT * FROM user_kp_proficiency WHERE user_id=? AND kg_node_id=?`).get(userId, ev.kg_node_id);
        const newerMistakeEvent = db.prepare(`
      SELECT COUNT(*) AS count FROM mistake_proficiency_events
      WHERE user_id=? AND kg_node_id=? AND applied_at>? AND reverted_at IS NULL
    `).get(userId, ev.kg_node_id, ev.applied_at);
        const hasNewerProfileUpdate = prof && prof.last_updated > ev.applied_at;
        if (!newerMistakeEvent.count && !hasNewerProfileUpdate) {
            if (ev.before_score == null) {
                db.prepare(`DELETE FROM user_kp_proficiency WHERE user_id=? AND kg_node_id=?`).run(userId, ev.kg_node_id);
            }
            else {
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
function applyMistakeProficiency(userId, mistakeId, nodeId, role, confidence) {
    const existing = db.prepare(`SELECT * FROM user_kp_proficiency WHERE user_id=? AND kg_node_id=?`).get(userId, nodeId);
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
  `).run(mistakeId, userId, nodeId, beforeScore, afterScore, beforeCorrect, beforeTotal, afterCorrect, afterTotal, role, confidence, now, beforeRating, afterRating, beforeSigma, afterSigma);
    return { beforeScore, afterScore, appliedAt: now };
}
/** 抽象风格字段（题型/难度/情境/推理/干扰/呈现/摘要），不含原题原文 */
function styleFields(analysis) {
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
function buildStyleText(analysis, promptText) {
    return [
        ...styleFields(analysis),
        `原题结构摘要: ${promptText.replace(/\s+/g, ' ').slice(0, 240)}`,
    ].join('\n');
}
/** 全局技能文本：去掉原题原文切片，作为跨用户外泄的隐私保险 */
function buildSkillText(analysis) {
    return styleFields(analysis).join('\n');
}
/**
 * 写入单题风格审计行（mistake_style_features），并把算好的向量返回，
 * 供全局技能库 create-or-reinforce 复用（避免二次 embedding）。
 */
async function saveStyleFeature(mistakeId, analysis, promptText) {
    const styleText = buildStyleText(analysis, promptText);
    let vector = null;
    try {
        const [vec] = await embedTexts([styleText]);
        vector = vec ?? null;
    }
    catch {
        vector = null;
    }
    db.prepare(`
    INSERT INTO mistake_style_features (
      mistake_id, question_type, difficulty, scenario_type, reasoning_pattern,
      distractor_pattern, presentation_features, style_text, embedding
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(mistakeId, analysis.questionType ?? '综合题', normalizeDifficulty(analysis.difficulty), analysis.scenarioType ?? '常规学习场景', analysis.reasoningPattern ?? '提取条件并分步求解', analysis.distractorPattern ?? null, analysis.presentationFeatures ? JSON.stringify(analysis.presentationFeatures) : null, styleText, vector ? vectorToBlob(vector) : null);
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
function normalizeVector(v) {
    let norm = 0;
    for (const x of v)
        norm += x * x;
    norm = Math.sqrt(norm) || 1;
    return v.map((x) => x / norm);
}
/** 技能排序/门槛权重：被反复强化、被多人验证的风格更靠前（封顶 0.25 防爆款霸屏） */
function computeStyleSkillWeight(reinforceCount, distinctUserCount) {
    return Math.min(0.25, Math.log2(1 + reinforceCount) * 0.05 + Math.min(distinctUserCount, 5) * 0.02);
}
/**
 * 全局风格技能 create-or-reinforce：在同 学科+年级 桶内找最相近技能，
 * 相似度≥阈值则强化（计数+1、质心增量更新），否则新建。同步、纯 DB + 内存向量扫描，
 * 复用 saveStyleFeature 已算好的向量，绝不抛异常进 analyze/SSE 流。
 */
function sedimentGlobalStyleSkill(opts) {
    const { subject, grade, userId, kgNodeId, analysis, vector } = opts;
    if (!vector)
        return;
    try {
        const candidates = db.prepare(`
      SELECT id, embedding, reinforce_count, distinct_user_count, source_user_ids
      FROM style_skills
      WHERE subject=? AND grade=?
      ORDER BY quality_weight DESC, last_seen_at DESC
      LIMIT ?
    `).all(subject, grade, STYLE_SKILL_CANDIDATE_LIMIT);
        let best = null;
        for (const row of candidates) {
            const sim = cosineSim(vector, blobToVector(row.embedding));
            if (!best || sim > best.sim)
                best = { sim, row };
        }
        const now = nowSec();
        if (best && best.sim >= STYLE_SKILL_MERGE_THRESHOLD) {
            const row = best.row;
            const sources = row.source_user_ids ? safeJson(row.source_user_ids, []) : [];
            const isNewUser = !sources.includes(userId);
            if (isNewUser && sources.length < STYLE_SKILL_SOURCE_USER_CAP)
                sources.push(userId);
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
      `).run(vectorToBlob(merged), reinforceCount, distinctUserCount, JSON.stringify(sources), computeStyleSkillWeight(reinforceCount, distinctUserCount), now, now, row.id);
        }
        else {
            db.prepare(`
        INSERT INTO style_skills (
          subject, grade, kg_node_id, question_type, difficulty, skill_text,
          embedding, reinforce_count, distinct_user_count, source_user_ids, quality_weight,
          created_at, updated_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?, ?)
      `).run(subject, grade, kgNodeId ?? null, analysis.questionType ?? '综合题', normalizeDifficulty(analysis.difficulty), buildSkillText(analysis), vectorToBlob(vector), JSON.stringify([userId]), computeStyleSkillWeight(1, 1), now, now, now);
        }
    }
    catch (err) {
        console.warn('[mistakes] 全局风格技能沉淀失败（已忽略）:', err instanceof Error ? err.message : String(err));
    }
}
// ── LLM 驱动的风格技能整合 ──
/** 一次流程最多生成的技能数（激进合并） */
const MAX_BATCH_SKILLS = 3;
/** 单桶技能数超过此值触发 LLM 二次整合 */
const MAX_SKILLS_PER_BUCKET = 12;
function coerceConsolidatedSkill(s) {
    const o = (s && typeof s === 'object' ? s : {});
    const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
    return {
        questionType: str(o.questionType) ?? '其他',
        difficulty: normalizeDifficulty(o.difficulty),
        scenarioType: str(o.scenarioType),
        reasoningPattern: str(o.reasoningPattern),
        distractorPattern: str(o.distractorPattern),
        styleText: str(o.styleText),
    };
}
/**
 * 把一份作业里多道题的风格信息激进归并成 ≤MAX_BATCH_SKILLS 个可复用技能。
 * 相似题型/情境/推理结构必须合并为一条，不逐题罗列。
 */
async function consolidateBatchSkills(model, questionSummaries, subject, grade) {
    if (!questionSummaries.length)
        return [];
    const prompt = [
        `你是出题风格归纳器。以下是同一批 ${subject} ${grade}年级 题目的风格信息。`,
        `请激进地把它们归并成【最多 ${MAX_BATCH_SKILLS} 个】可复用的"出题风格技能"：相似的题型/情境/推理结构必须合并为一条，绝不逐题罗列。`,
        '每个技能字段：questionType(中文枚举:选择题/填空题/判断题/计算题/应用题/解答题/阅读题/其他)、difficulty(easy|medium|hard)、scenarioType(具体情境,如"购物找零""行程问题")、reasoningPattern(核心推理结构)、distractorPattern(常见易错/干扰点)、styleText(50字内泛化风格摘要,只描述结构与风格,不含具体数字或原文)。',
        '输出 JSON 对象，skills 字段为技能数组，如 {"skills": [...]}。不要解释、不要 Markdown。',
        '题目风格信息：',
        questionSummaries.slice(0, 80).map((s, i) => `${i + 1}. ${s}`).join('\n'),
    ].join('\n\n');
    const resp = await model.invoke([
        new SystemMessage('你只输出可解析 JSON。'),
        new HumanMessage(prompt),
    ]);
    const content = typeof resp.content === 'string' ? resp.content : String(JSON.stringify(resp.content ?? null));
    let parsed;
    try {
        parsed = safeParseJson(String(content || '{}'));
    }
    catch (err) {
        console.warn('[mistakes] consolidateBatchSkills JSON 解析失败，回退为逐条独立技能。原始响应前 300 字符:', content.slice(0, 300));
        parsed = questionSummaries.map(() => ({}));
    }
    // 兼容 {"skills": [...]} 和裸数组
    const skillArr = Array.isArray(parsed) ? parsed : (parsed && typeof parsed === 'object' ? parsed.skills ?? parsed.items ?? [] : []);
    const arr = Array.isArray(skillArr) ? skillArr : [];
    return arr.slice(0, MAX_BATCH_SKILLS).map(coerceConsolidatedSkill);
}
/** 把整合出的技能逐个 embedding 后沉淀进全局库（create-or-reinforce） */
async function sedimentConsolidatedSkills(skills, subject, grade, userId) {
    for (const skill of skills) {
        const skillText = buildSkillText(skill);
        let vector = null;
        try {
            const [v] = await embedTexts([skillText]);
            vector = v ?? null;
        }
        catch {
            vector = null;
        }
        sedimentGlobalStyleSkill({ subject, grade, userId, kgNodeId: null, analysis: skill, vector });
    }
}
/**
 * LLM 二次整合：当某桶技能过多时，把高度相似的技能聚类合并，计数累加保留，明显收敛技能数。
 * 返回 { before, after }。失败时安全 no-op。
 */
export async function consolidateGlobalSkills(model, subject, grade) {
    const rows = db.prepare(`
    SELECT id, skill_text, reinforce_count, distinct_user_count, source_user_ids, kg_node_id, created_at
    FROM style_skills WHERE subject=? AND grade=? ORDER BY reinforce_count DESC, id
  `).all(subject, grade);
    if (rows.length <= MAX_BATCH_SKILLS)
        return { before: rows.length, after: rows.length };
    const target = Math.max(MAX_BATCH_SKILLS, Math.ceil(rows.length / 3));
    const listText = rows.map((r, i) => `${i + 1}. ${r.skill_text.replace(/\s+/g, ' ').slice(0, 120)}`).join('\n');
    const prompt = [
        `下面是 ${subject} ${grade}年级 已沉淀的 ${rows.length} 个出题风格技能（带编号）。`,
        `请把高度相似的技能聚类合并，输出合并后的技能组，组数明显减少（目标不超过 ${target} 组）。`,
        '每组输出 { memberIndexes:[原编号...], questionType, difficulty(easy|medium|hard), scenarioType, reasoningPattern, distractorPattern, styleText(50字内泛化摘要) }。',
        '每个原编号必须且只能出现在一组里；不可遗漏、不可重复。输出 JSON 对象，groups 字段放数组。不要解释。',
        '技能列表：',
        listText,
    ].join('\n\n');
    let groups = [];
    try {
        const resp = await model.invoke([
            new SystemMessage('你只输出可解析 JSON。'),
            new HumanMessage(prompt),
        ]);
        const content = typeof resp.content === 'string' ? resp.content : String(JSON.stringify(resp.content ?? null));
        const parsed = safeParseJson(String(content || '{}'));
        // 兼容 {"groups": [...]} 和裸数组
        const arr = Array.isArray(parsed) ? parsed : (parsed && typeof parsed === 'object' ? parsed.groups ?? [] : []);
        groups = arr.map((g) => ({
            memberIndexes: Array.isArray(g?.memberIndexes) ? g.memberIndexes.map(Number).filter(Number.isFinite) : [],
            skill: coerceConsolidatedSkill(g),
        })).filter((g) => g.memberIndexes.length > 0);
    }
    catch (err) {
        console.warn('[mistakes] 二次整合 LLM 调用失败（跳过）:', err instanceof Error ? err.message : String(err));
        return { before: rows.length, after: rows.length };
    }
    // 校验分组覆盖：每个编号恰好出现一次，否则放弃（安全 no-op）
    const seen = new Set();
    let valid = groups.length > 0 && groups.length < rows.length;
    for (const g of groups) {
        for (const idx of g.memberIndexes) {
            if (idx < 1 || idx > rows.length || seen.has(idx)) {
                valid = false;
                break;
            }
            seen.add(idx);
        }
    }
    if (!valid || seen.size !== rows.length) {
        console.warn('[mistakes] 二次整合分组未完整覆盖，跳过');
        return { before: rows.length, after: rows.length };
    }
    // embedding 不能在 sqlite 事务里 await：先把每组合并技能的向量算好（失败用首个成员旧向量兜底，保证 NOT NULL）
    const prepared = [];
    for (const g of groups) {
        const members = g.memberIndexes.map((i) => rows[i - 1]);
        const skillText = buildSkillText(g.skill);
        let embedding = null;
        try {
            const [v] = await embedTexts([skillText]);
            embedding = v ? vectorToBlob(v) : null;
        }
        catch {
            embedding = null;
        }
        if (!embedding) {
            const fallback = db.prepare(`SELECT embedding FROM style_skills WHERE id=?`).get(members[0].id);
            embedding = fallback?.embedding ?? null;
        }
        if (!embedding) {
            console.warn('[mistakes] 二次整合无法获得向量，跳过');
            return { before: rows.length, after: rows.length };
        }
        prepared.push({ members, skill: g.skill, embedding });
    }
    const now = nowSec();
    db.transaction(() => {
        for (const { members, skill, embedding } of prepared) {
            const reinforce = members.reduce((s, m) => s + m.reinforce_count, 0);
            const users = new Set();
            for (const m of members)
                for (const u of (m.source_user_ids ? safeJson(m.source_user_ids, []) : []))
                    users.add(u);
            const distinctUsers = Math.max(users.size, ...members.map((m) => m.distinct_user_count));
            const kgNodeId = members.find((m) => m.kg_node_id != null)?.kg_node_id ?? null;
            const createdAt = Math.min(...members.map((m) => m.created_at));
            for (const m of members)
                db.prepare(`DELETE FROM style_skills WHERE id=?`).run(m.id);
            db.prepare(`
        INSERT INTO style_skills (
          subject, grade, kg_node_id, question_type, difficulty, skill_text,
          embedding, reinforce_count, distinct_user_count, source_user_ids, quality_weight,
          created_at, updated_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(subject, grade, kgNodeId, skill.questionType ?? '其他', normalizeDifficulty(skill.difficulty), buildSkillText(skill), embedding, reinforce, distinctUsers, JSON.stringify([...users].slice(0, STYLE_SKILL_SOURCE_USER_CAP)), computeStyleSkillWeight(reinforce, distinctUsers), createdAt, now, now);
        }
    })();
    return { before: rows.length, after: prepared.length };
}
/** 桶内技能数超阈值时触发 LLM 二次整合 */
async function maybeConsolidateBucket(model, subject, grade) {
    const count = db.prepare(`SELECT COUNT(*) AS c FROM style_skills WHERE subject=? AND grade=?`).get(subject, grade).c;
    if (count <= MAX_SKILLS_PER_BUCKET)
        return;
    try {
        const r = await consolidateGlobalSkills(model, subject, grade);
        console.log(`[mistakes] 二次整合 ${subject}/G${grade}: ${r.before} → ${r.after} 个技能`);
    }
    catch (err) {
        console.warn('[mistakes] 二次整合失败（已忽略）:', err instanceof Error ? err.message : String(err));
    }
}
/**
 * 将一道题的分析结果应用到指定 mistake 记录：更新 DB、映射知识点、写熟练度、存风格特征。
 * questionIndex / totalQuestions 用于进度条计算（仅 progress 数值，不做除法）
 */
async function applyAnalysisToMistake(mistakeId, userId, row, analysis, recognizedText, candidates, ocrProvider, ocrRaw, questionIndex, totalQuestions, onProgress) {
    // 进度范围：总进度 100%，OCR + LLM 占 ~35%，剩余 ~65% 按题目平分
    const share = totalQuestions > 1 ? 65 / totalQuestions : 65;
    const basePct = 32 + (questionIndex / (totalQuestions || 1)) * 65;
    function pct(offset) {
        return Math.round(basePct + offset * share);
    }
    // ── 知识点映射 ──
    await onProgress?.({ step: 'map', message: `校验章节和知识图谱节点（第 ${questionIndex + 1}/${totalQuestions} 题）`, progress: pct(0.35) });
    const mappings = [];
    for (const rawMap of analysis.knowledgeNodes ?? []) {
        const directId = Number(rawMap.kgNodeId);
        const candidate = Number.isFinite(directId)
            ? findCandidateById(directId, row.subject, row.grade)
            : undefined;
        const fallback = candidate ?? (rawMap.title ? findCandidateByTitle(rawMap.title, row.subject, row.grade) : undefined);
        if (!fallback)
            continue;
        const role = normalizeRole(rawMap.role);
        const confidence = clampConfidence(rawMap.confidence, 0.55);
        if (confidence < 0.35)
            continue;
        if (mappings.some((m) => m.kgNodeId === fallback.id))
            continue;
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
    const status = mappings.length > 0 ? 'analyzed' : 'needs_review';
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
    const detectedSubject = analysis.subject && ['chinese', 'math', 'english', 'science'].includes(analysis.subject)
        ? analysis.subject
        : row.subject;
    db.prepare(`
    UPDATE mistake_items SET
      subject=?, status=?, title=?, prompt_text=?, student_answer=?, correct_answer=?, explanation=?,
      error_type=?, error_reason=?, analysis_confidence=?, answer_match_score=?, is_correct=?,
      ocr_provider=?, ocr_raw=?, updated_at=?
    WHERE id=? AND user_id=?
  `).run(detectedSubject, status, (analysis.title || recognizedText.split(/\n|。|\./)[0] || '错题').slice(0, 32), (analysis.promptText || recognizedText).trim(), analysis.studentAnswer?.trim() || row.student_answer || null, analysis.correctAnswer?.trim() || null, analysis.explanation?.trim() || null, analysis.errorType?.trim() || null, analysis.errorReason?.trim() || null, clampConfidence(analysis.confidence, status === 'analyzed' ? 0.7 : 0.3), matchScore, isCorrect ? 1 : 0, ocrProvider, ocrRaw ? JSON.stringify(ocrRaw) : null, now, mistakeId, userId);
    // ── 熟练度 ──
    // 做对的题不扣减熟练度，避免错误降低已掌握知识点的画像
    if (isCorrect) {
        await onProgress?.({ step: 'profile', message: `答案匹配度 ${Math.round(matchScore * 100)}%，判定为大概率做对，跳过画像扣减`, progress: pct(0.65) });
    }
    else {
        await onProgress?.({ step: 'profile', message: status === 'analyzed' ? `写入知识画像（第 ${questionIndex + 1}/${totalQuestions} 题）` : '未找到可信知识点，等待人工修正', progress: pct(0.65) });
        let appliedAt;
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
    // ── 风格特征（仅写 per-user 审计行；全局技能改为流程末尾批量 LLM 整合）──
    // 题型沉淀逻辑不受答案正确率判断影响：做对的题同样沉淀出题风格
    await onProgress?.({ step: 'style', message: `沉淀题型风格（第 ${questionIndex + 1}/${totalQuestions} 题）`, progress: pct(0.8) });
    if (status === 'analyzed' || isCorrect) {
        await saveStyleFeature(mistakeId, analysis, analysis.promptText || recognizedText);
    }
    await onProgress?.({ step: 'complete', message: status === 'analyzed' ? `第 ${questionIndex + 1} 题分析完成` : '错题已保存，需补充知识点', progress: pct(1) });
    const item = loadMistakeRows(mistakeId, userId);
    if (!item)
        throw new Error('错题分析结果读取失败');
    return item;
}
function makeMistakeId() {
    const ts = Date.now().toString(36);
    const rand = crypto.getRandomValues(new Uint8Array(4)).reduce((s, b) => s + b.toString(36).padStart(2, '0'), '');
    return `mistake-${ts}-${rand}`;
}
export async function analyzeMistake(mistakeId, userId, model, onProgress, onMistake) {
    const row = db.prepare(`SELECT * FROM mistake_items WHERE id=? AND user_id=?`).get(mistakeId, userId);
    if (!row)
        throw new Error('错题不存在');
    if (row.status === 'archived')
        throw new Error('错题已归档');
    // ── 1. OCR ──
    await onProgress?.({ step: 'ocr', message: row.source_type === 'text' ? '读取文本录入' : '调用 OCR 识别', progress: 8 });
    let recognizedText = String(row.prompt_text ?? '').trim();
    let ocrProvider = row.ocr_provider ?? null;
    let ocrRaw = row.ocr_raw ? safeJson(row.ocr_raw, {}) : null;
    if (!recognizedText.trim() && row.source_type === 'image') {
        const assetPath = getOriginalAssetPath(mistakeId);
        if (!assetPath)
            throw new Error('找不到原始图片');
        const ocr = await recognizeWithAliyunEduOcr(assetPath, row.subject, row.grade);
        recognizedText = ocr.text || recognizedText;
        ocrProvider = ocr.provider;
        ocrRaw = ocr.raw;
        // 写回 DB 供前端展示
        if (recognizedText.trim()) {
            db.prepare(`UPDATE mistake_items SET prompt_text=?, ocr_provider=?, updated_at=? WHERE id=?`).run(recognizedText, ocrProvider, Math.floor(Date.now() / 1000), mistakeId);
        }
    }
    if (!recognizedText.trim())
        throw new Error('OCR 未识别到有效题目文本，请补充题面后重试');
    // ── 2. LLM 分析（返回所有题目） ──
    await onProgress?.({ step: 'analyze', message: 'LLM 识别全部题目', progress: 30 });
    const analyses = await analyzeWithLlm(model, {
        subject: row.subject,
        grade: row.grade,
        recognizedText,
        studentAnswer: row.student_answer ?? undefined,
        candidates: getCandidateNodes(row.subject, row.grade, 80),
    });
    if (!analyses.length)
        throw new Error('LLM 未能从文本中识别出有效题目');
    // 用 LLM 检测到的学科重新获取候选知识点
    const effectiveSubject = analyses[0].subject && ['chinese', 'math', 'english', 'science'].includes(analyses[0].subject)
        ? analyses[0].subject
        : row.subject;
    const candidates = getCandidateNodes(effectiveSubject, row.grade, 80);
    // ── 3. 逐题应用分析结果 ──
    for (let i = 0; i < analyses.length; i++) {
        const analysis = analyses[i];
        let targetId;
        let targetRow;
        if (i === 0) {
            // 第一题复写原 mistake 记录（用 LLM 检测的学科覆盖）
            targetId = mistakeId;
            targetRow = { ...row, subject: effectiveSubject };
        }
        else {
            // 后续题创建新记录（无资产，共享 OCR 文本）
            targetId = makeMistakeId();
            const now = nowSec();
            db.prepare(`
        INSERT INTO mistake_items (id, user_id, subject, grade, source_type, status, prompt_text, student_answer, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'processing', ?, ?, ?, ?)
      `).run(targetId, userId, effectiveSubject, row.grade, row.source_type, (analysis.promptText || recognizedText).slice(0, 800), row.student_answer, now, now);
            targetRow = db.prepare(`SELECT * FROM mistake_items WHERE id=?`).get(targetId);
        }
        const item = await applyAnalysisToMistake(targetId, userId, targetRow, analysis, recognizedText, candidates, ocrProvider, ocrRaw, i, analyses.length, onProgress);
        await onMistake?.(item);
    }
    // ── 4. 批量整合风格技能：每流程激进合并成 ≤3 个有效技能，沉淀进全局库 ──
    try {
        await onProgress?.({ step: 'style', message: '整合并沉淀出题风格技能', progress: 99 });
        const summaries = analyses
            .filter((a) => (a.promptText || a.title))
            .map((a) => [
            `题型:${a.questionType ?? '?'}`,
            `难度:${a.difficulty ?? '?'}`,
            a.scenarioType ? `情境:${a.scenarioType}` : '',
            a.reasoningPattern ? `推理:${a.reasoningPattern}` : '',
            a.distractorPattern ? `易错:${a.distractorPattern}` : '',
            `题面:${(a.promptText || a.title || '').replace(/\s+/g, ' ').slice(0, 60)}`,
        ].filter(Boolean).join(' '));
        if (summaries.length) {
            const skills = await consolidateBatchSkills(model, summaries, effectiveSubject, row.grade);
            await sedimentConsolidatedSkills(skills, effectiveSubject, row.grade, userId);
            await maybeConsolidateBucket(model, effectiveSubject, row.grade);
        }
    }
    catch (err) {
        console.warn('[mistakes] 批量风格技能整合失败（已忽略）:', err instanceof Error ? err.message : String(err));
    }
}
export function updateMistake(mistakeId, userId, patch) {
    const current = db.prepare(`SELECT * FROM mistake_items WHERE id=? AND user_id=?`).get(mistakeId, userId);
    if (!current)
        throw new Error('错题不存在');
    const now = nowSec();
    db.prepare(`
    UPDATE mistake_items SET
      prompt_text=COALESCE(?, prompt_text),
      student_answer=COALESCE(?, student_answer),
      correct_answer=COALESCE(?, correct_answer),
      error_reason=COALESCE(?, error_reason),
      updated_at=?
    WHERE id=? AND user_id=?
  `).run(patch.promptText?.trim() || null, patch.studentAnswer?.trim() || null, patch.correctAnswer?.trim() || null, patch.errorReason?.trim() || null, now, mistakeId, userId);
    const item = loadMistakeRows(mistakeId, userId);
    if (!item)
        throw new Error('错题更新失败');
    return item;
}
export function archiveMistake(mistakeId, userId) {
    const info = db.prepare(`UPDATE mistake_items SET status='archived', updated_at=? WHERE id=? AND user_id=?`).run(nowSec(), mistakeId, userId);
    return info.changes > 0;
}
export function getMistakeAssetFile(mistakeId, assetId, userId) {
    const row = db.prepare(`
    SELECT a.file_path, a.mime_type
    FROM mistake_assets a
    JOIN mistake_items m ON m.id = a.mistake_id
    WHERE a.id=? AND a.mistake_id=? AND m.user_id=?
  `).get(assetId, mistakeId, userId);
    if (!row)
        return null;
    const root = resolve(ASSET_ROOT);
    const filePath = resolve(row.file_path);
    if (!filePath.startsWith(root) || !existsSync(filePath))
        return null;
    return { filePath, mimeType: row.mime_type };
}
export async function readMistakeAsset(filePath) {
    return readFile(filePath);
}
export async function retrieveMistakeStyleSamples(userId, subject, grade, query, kgNodeIds = [], limit = 3) {
    const rows = db.prepare(`
    SELECT sf.*, mi.prompt_text, mi.error_type, group_concat(km.kg_node_id) AS node_ids
    FROM mistake_style_features sf
    JOIN mistake_items mi ON mi.id = sf.mistake_id
    LEFT JOIN mistake_kp_map km ON km.mistake_id = sf.mistake_id
    WHERE mi.user_id=? AND mi.subject=? AND mi.grade=? AND (mi.status='analyzed' OR mi.is_correct=1)
    GROUP BY sf.id
    ORDER BY sf.created_at DESC
    LIMIT 40
  `).all(userId, subject, grade);
    if (!rows.length)
        return '';
    let queryVector = null;
    if (query.trim()) {
        try {
            queryVector = await embedQuery(query);
        }
        catch (err) {
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
    if (!ranked.length)
        return '';
    return [
        '【真实学校错题风格样本】以下样本仅用于学习题型结构、出题风格、逻辑搭建和情境选取，严禁复刻原题文字、数字、学生答案或隐私信息。',
        ...ranked.map(({ row }, i) => {
            const style = {
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
export async function retrieveGlobalStyleSkills(subject, grade, query, kgNodeIds = [], limit = 3) {
    const rows = db.prepare(`
    SELECT id, kg_node_id, skill_text, embedding, reinforce_count, distinct_user_count, quality_weight, last_seen_at
    FROM style_skills
    WHERE subject=? AND grade=?
    ORDER BY quality_weight DESC, last_seen_at DESC
    LIMIT ?
  `).all(subject, grade, STYLE_SKILL_CANDIDATE_LIMIT);
    if (!rows.length)
        return '';
    let queryVector = null;
    if (query.trim()) {
        try {
            queryVector = await embedQuery(query);
        }
        catch (err) {
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
    if (!ranked.length)
        return '';
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
export function backfillStyleSkills() {
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
  `).all();
    db.exec(`DELETE FROM style_skills`);
    let scanned = 0;
    for (const r of rows) {
        if (!r.embedding)
            continue;
        scanned++;
        const analysis = {
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
    const created = db.prepare(`SELECT COUNT(*) AS c FROM style_skills`).get().c;
    return { created, reinforced: Math.max(0, scanned - created), scanned };
}
/** 删除无题面的空壳错题（含级联的风格特征/映射）。dryRun 只统计不删。 */
export function purgeEmptyMistakes(dryRun = false) {
    const rows = db.prepare(`SELECT id FROM mistake_items WHERE prompt_text IS NULL OR trim(prompt_text)=''`).all();
    if (!dryRun && rows.length) {
        const del = db.prepare(`DELETE FROM mistake_items WHERE id=?`);
        db.transaction(() => { for (const r of rows)
            del.run(r.id); })();
    }
    return { empties: rows.length };
}
/**
 * 清洗重复/高度相似题目，避免重复题干扰技能权重。
 * 同 用户+学科+年级 桶内：题面归一化完全相同 = 重复；或题面 embedding 余弦≥阈值 = 高度相似。
 * 保留最早一条，删除其余（级联删风格特征/映射）。dryRun 只统计与给样例。
 */
export async function dedupeMistakes(opts = {}) {
    const dryRun = opts.dryRun ?? false;
    // 仅按题面归一化精确去重（只删真正重复上传的同一道题）。
    // 不用 embedding 近似：现存风格向量多为旧版空壳模板（情境/推理全默认），
    // 不同题目向量也高度相似，近似去重会误删distinct题。
    const rows = db.prepare(`
    SELECT id, user_id, subject, grade, prompt_text, created_at
    FROM mistake_items
    WHERE prompt_text IS NOT NULL AND trim(prompt_text)<>''
    ORDER BY created_at ASC, id
  `).all();
    if (!rows.length)
        return { scanned: 0, duplicates: 0, kept: 0, sample: [] };
    const dupIds = [];
    const sample = [];
    const seen = new Map();
    for (const r of rows) {
        const norm = `${r.user_id}|${r.subject}|${r.grade}|` + r.prompt_text.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
        if (seen.has(norm)) {
            dupIds.push(r.id);
            if (sample.length < 8)
                sample.push(r.prompt_text.replace(/\s+/g, ' ').slice(0, 50));
        }
        else {
            seen.set(norm, true);
        }
    }
    if (!dryRun && dupIds.length) {
        const del = db.prepare(`DELETE FROM mistake_items WHERE id=?`);
        db.transaction(() => { for (const id of dupIds)
            del.run(id); })();
    }
    return { scanned: rows.length, duplicates: dupIds.length, kept: rows.length - dupIds.length, sample };
}
/**
 * 用 LLM 从现存原题重建全局风格技能库（Step 3）。
 * 清空 style_skills → 按 学科+年级 分桶 → 每桶分块(15题)激进整合成 ≤3 技能 → 沉淀 → 桶内二次整合。
 */
export async function rebuildStyleSkillsWithLLM(model) {
    db.exec(`DELETE FROM style_skills`);
    const buckets = db.prepare(`
    SELECT DISTINCT subject, grade FROM mistake_items
    WHERE prompt_text IS NOT NULL AND trim(prompt_text)<>'' AND (status='analyzed' OR is_correct=1)
  `).all();
    const CHUNK = 15;
    for (const b of buckets) {
        const items = db.prepare(`
      SELECT user_id, prompt_text, student_answer, correct_answer, error_type, error_reason
      FROM mistake_items
      WHERE subject=? AND grade=? AND prompt_text IS NOT NULL AND trim(prompt_text)<>'' AND (status='analyzed' OR is_correct=1)
      ORDER BY created_at ASC
    `).all(b.subject, b.grade);
        for (let i = 0; i < items.length; i += CHUNK) {
            const chunk = items.slice(i, i + CHUNK);
            const summaries = chunk.map((r) => [
                `题面:${(r.prompt_text || '').replace(/\s+/g, ' ').slice(0, 80)}`,
                r.student_answer ? `学生:${r.student_answer}` : '',
                r.correct_answer ? `正确:${r.correct_answer}` : '',
                (r.error_reason || r.error_type) ? `错因:${r.error_reason || r.error_type}` : '',
            ].filter(Boolean).join(' '));
            try {
                const skills = await consolidateBatchSkills(model, summaries, b.subject, b.grade);
                await sedimentConsolidatedSkills(skills, b.subject, b.grade, chunk[0]?.user_id ?? 'rebuild');
            }
            catch (err) {
                console.warn(`[mistakes] rebuild 桶 ${b.subject}/${b.grade} chunk ${i}-${i + CHUNK} 失败（跳过）:`, err instanceof Error ? err.message : String(err));
            }
        }
        await maybeConsolidateBucket(model, b.subject, b.grade);
    }
    const skills = db.prepare(`SELECT COUNT(*) AS c FROM style_skills`).get().c;
    return { buckets: buckets.length, skills };
}
export function formatMistakePracticePrompt(mistake) {
    const kps = mistake.mappings?.map((m) => m.title).join('、') || '这道错题相关知识点';
    return `请围绕我的错题做举一反三集中练习。错题标题：${mistake.title}。知识点：${kps}。先用一句话指出核心错因，再出一道同结构但不照抄原题的变式题。`;
}
