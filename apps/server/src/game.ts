/**
 * 教育游戏 —— 知识跑酷：单题出题接口
 *
 * 按学科出题，支持 LLM 生成 + 内置兜底题库。
 */
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { SystemMessage, HumanMessage } from '@langchain/core/messages';
import { randomUUID } from 'node:crypto';

export interface GameQuestion {
  id: string;
  stem: string;
  options: { key: string; text: string }[];
  correctKey: string;
}

/** LLM 返回的原始题目 JSON 结构 */
interface RawQuestionJson {
  stem: string;
  options: { key: string; text: string }[];
  correctKey: string;
}

const SUBJECT_MAP: Record<string, { label: string }> = {
  math: { label: '数学' },
  chinese: { label: '语文' },
  english: { label: '英语' },
  science: { label: '科学' },
};

/** LLM 调用超时（毫秒）*/
const LLM_TIMEOUT = 2000;

/* ── 题目池：内存预生成，请求时秒出 ── */
const questionPools = new Map<string, GameQuestion[]>();
const poolRefilling = new Map<string, boolean>();
let poolModel: BaseChatModel | null = null;
const POOL_MIN = 5;   // 低于此数时后台补充
const POOL_MAX = 20;  // 补充到此数

/**
 * 解析 LLM 返回文本为 GameQuestion
 * 返回 null 表示解析失败，调用方应降级
 */
function parseLLMQuestion(text: string): GameQuestion | null {
  if (!text) return null;

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    console.warn('[game] LLM 返回内容不含有效 JSON');
    return null;
  }

  let parsed: RawQuestionJson;
  try {
    parsed = JSON.parse(jsonMatch[0]) as RawQuestionJson;
  } catch {
    console.warn('[game] LLM 返回 JSON 解析失败');
    return null;
  }

  // 校验必需字段
  if (!parsed.stem || !Array.isArray(parsed.options) || parsed.options.length < 2 || !parsed.correctKey) {
    console.warn('[game] LLM 返回题目缺少必需字段');
    return null;
  }

  // 补充/截断选项到 4 个
  if (parsed.options.length < 4) {
    console.warn(`[game] LLM 返回选项不足 (${parsed.options.length})，补足到 4 个`);
    const placeholders = ['此选项无效', '此选项无效', '此选项无效', '此选项无效'];
    for (let i = parsed.options.length; i < 4; i++) {
      parsed.options.push({ key: String.fromCharCode(65 + i), text: placeholders[i] });
    }
  }

  // 归一化 correctKey 为大写
  parsed.correctKey = parsed.correctKey.toUpperCase().trim();
  if (!/^[A-D]$/.test(parsed.correctKey)) {
    parsed.correctKey = 'A'; // 无效 key 降级为 A
  }

  // 找到正确答案在原始顺序中的索引
  const correctIndex = parsed.options.findIndex(o => o.key === parsed.correctKey);
  const safeCorrectIndex = correctIndex >= 0 ? correctIndex : 0;

  // 重写 key 为 A/B/C/D（按原始顺序），只取前 4 个
  const options = parsed.options.slice(0, 4).map((o, i) => ({
    key: String.fromCharCode(65 + i),
    text: String(o.text ?? '').trim() || '（空选项）',
  }));

  // 安全检查：options 必须至少 2 项
  if (options.length < 2) return null;

  // 打乱选项并定位正确答案
  const { shuffled, newCorrectKey } = shuffleOptionsAndLocateCorrect(options, options[safeCorrectIndex]?.key ?? 'A');

  return {
    id: `q_${Date.now()}_${randomUUID().slice(0, 6)}`,
    stem: parsed.stem.trim() || '请选择正确答案',
    options: shuffled,
    correctKey: newCorrectKey,
  };
}

/** 按学科出题 */
export async function generateGameQuestion(model: BaseChatModel, subject: string): Promise<GameQuestion> {
  const sub = SUBJECT_MAP[subject];
  if (!sub) return getFallbackQuestion(subject);

  // 先尝试 LLM 生成（带超时）
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const prompt = `你是一名${sub.label}老师。请出一道${sub.label}选择题，要求：
1. 题目难度适中，适合中小学生
2. 有 4 个选项（A/B/C/D）
3. 只有一个正确答案
4. 用 JSON 格式输出，结构如下：
{
  "stem": "题目题干",
  "options": [
    { "key": "A", "text": "选项内容" },
    { "key": "B", "text": "选项内容" },
    { "key": "C", "text": "选项内容" },
    { "key": "D", "text": "选项内容" }
  ],
  "correctKey": "A"
}
只输出 JSON，不要其他内容。`;

    const invokePromise = model.invoke([
      new SystemMessage('你是一名有经验的学科教师，擅长出题。只输出 JSON。'),
      new HumanMessage(prompt),
    ]);

    // 超时竞速（超时后清理 timer 防止泄漏）
    const result: Awaited<typeof invokePromise> = await Promise.race([
      invokePromise,
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('LLM_TIMEOUT')), LLM_TIMEOUT);
      }),
    ]);
    clearTimeout(timeoutId);

    const text = typeof result.content === 'string'
      ? result.content.trim()
      : Array.isArray(result.content)
        ? result.content.map(b => (typeof b === 'string' ? b : (b as { text?: string }).text ?? '')).join('').trim()
        : '';

    const question = parseLLMQuestion(text);
    if (question) return question;

  } catch (err) {
    // 无论成功还是超时，都要清理 timer
    if (timeoutId) clearTimeout(timeoutId);
    const reason = err instanceof Error && err.message === 'LLM_TIMEOUT'
      ? '超时'
      : err instanceof Error ? err.message.slice(0, 100) : String(err);
    console.warn(`[game] LLM 出题失败(${reason})，降级内置题库`);
  }

  return getFallbackQuestion(subject);
}

function shuffleArray<T>(arr: T[]): T[] {
  const a = [...arr];
  // 使用 crypto.getRandomValues 替代 Math.random()，提供更好的均匀性
  const buf = new Uint32Array(a.length);
  crypto.getRandomValues(buf);
  // Fisher-Yates 洗牌（从后向前，每次从前缀中随机选取元素交换）
  for (let i = a.length - 1; i > 0; i--) {
    const j = buf[i] % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* ── 内置按科目题库 ── */
const FALLBACK: Record<string, GameQuestion[]> = {
  math: [
    { id: 'm1', stem: '圆的周长公式是？', options: [{ key: 'A', text: 'C = 2πr' }, { key: 'B', text: 'C = πr' }, { key: 'C', text: 'C = πr²' }, { key: 'D', text: 'C = 2πr²' }], correctKey: 'A' },
    { id: 'm2', stem: '12 × 15 = ?', options: [{ key: 'A', text: '150' }, { key: 'B', text: '170' }, { key: 'C', text: '180' }, { key: 'D', text: '190' }], correctKey: 'C' },
    { id: 'm3', stem: '一个三角形有几个内角？', options: [{ key: 'A', text: '2 个' }, { key: 'B', text: '3 个' }, { key: 'C', text: '4 个' }, { key: 'D', text: '6 个' }], correctKey: 'B' },
    { id: 'm4', stem: '直角三角形的两个锐角之和是多少度？', options: [{ key: 'A', text: '45°' }, { key: 'B', text: '90°' }, { key: 'C', text: '180°' }, { key: 'D', text: '360°' }], correctKey: 'B' },
    { id: 'm5', stem: '25 的平方根是？', options: [{ key: 'A', text: '4' }, { key: 'B', text: '5' }, { key: 'C', text: '6' }, { key: 'D', text: '12.5' }], correctKey: 'B' },
  ],
  chinese: [
    { id: 'c1', stem: '"春风又绿江南岸"的作者是？', options: [{ key: 'A', text: '李白' }, { key: 'B', text: '杜甫' }, { key: 'C', text: '王安石' }, { key: 'D', text: '苏轼' }], correctKey: 'C' },
    { id: 'c2', stem: '"但愿人长久"的下一句是？', options: [{ key: 'A', text: '千里共婵娟' }, { key: 'B', text: '低头思故乡' }, { key: 'C', text: '西出阳关无故人' }, { key: 'D', text: '每逢佳节倍思亲' }], correctKey: 'A' },
    { id: 'c3', stem: '下列哪个是象形字？', options: [{ key: 'A', text: '休' }, { key: 'B', text: '日' }, { key: 'C', text: '明' }, { key: 'D', text: '信' }], correctKey: 'B' },
    { id: 'c4', stem: '"不亦说乎"中的"说"是什么意思？', options: [{ key: 'A', text: '说话' }, { key: 'B', text: '同"悦"，愉快' }, { key: 'C', text: '解释' }, { key: 'D', text: '劝说' }], correctKey: 'B' },
    { id: 'c5', stem: '"窗含西岭千秋雪"出自哪首诗？', options: [{ key: 'A', text: '登鹳雀楼' }, { key: 'B', text: '绝句' }, { key: 'C', text: '望庐山瀑布' }, { key: 'D', text: '咏柳' }], correctKey: 'B' },
  ],
  english: [
    { id: 'e1', stem: 'What is the past tense of "go"?', options: [{ key: 'A', text: 'goed' }, { key: 'B', text: 'went' }, { key: 'C', text: 'gone' }, { key: 'D', text: 'going' }], correctKey: 'B' },
    { id: 'e2', stem: '"Beautiful" means?', options: [{ key: 'A', text: '丑陋的' }, { key: 'B', text: '漂亮的' }, { key: 'C', text: '有趣的' }, { key: 'D', text: '聪明的' }], correctKey: 'B' },
    { id: 'e3', stem: 'Which is a fruit?', options: [{ key: 'A', text: 'carrot' }, { key: 'B', text: 'apple' }, { key: 'C', text: 'broccoli' }, { key: 'D', text: 'potato' }], correctKey: 'B' },
    { id: 'e4', stem: '"I ___ a student." Choose the correct word.', options: [{ key: 'A', text: 'is' }, { key: 'B', text: 'am' }, { key: 'C', text: 'are' }, { key: 'D', text: 'be' }], correctKey: 'B' },
    { id: 'e5', stem: 'What color is the sky?', options: [{ key: 'A', text: 'Green' }, { key: 'B', text: 'Blue' }, { key: 'C', text: 'Red' }, { key: 'D', text: 'Yellow' }], correctKey: 'B' },
  ],
  science: [
    { id: 's1', stem: '光在真空中的传播速度约为？', options: [{ key: 'A', text: '3×10⁶ m/s' }, { key: 'B', text: '3×10⁸ m/s' }, { key: 'C', text: '3×10¹⁰ m/s' }, { key: 'D', text: '3×10⁴ m/s' }], correctKey: 'B' },
    { id: 's2', stem: '地球的自转周期大约是？', options: [{ key: 'A', text: '12 小时' }, { key: 'B', text: '24 小时' }, { key: 'C', text: '365 天' }, { key: 'D', text: '30 天' }], correctKey: 'B' },
    { id: 's3', stem: '下列哪个是哺乳动物？', options: [{ key: 'A', text: '鲤鱼' }, { key: 'B', text: '鲸鱼' }, { key: 'C', text: '鳄鱼' }, { key: 'D', text: '章鱼' }], correctKey: 'B' },
    { id: 's4', stem: '水的化学式是？', options: [{ key: 'A', text: 'CO₂' }, { key: 'B', text: 'H₂O' }, { key: 'C', text: 'NaCl' }, { key: 'D', text: 'O₂' }], correctKey: 'B' },
    { id: 's5', stem: '植物进行光合作用需要什么？', options: [{ key: 'A', text: '月光和水分' }, { key: 'B', text: '阳光、水和二氧化碳' }, { key: 'C', text: '土壤和肥料' }, { key: 'D', text: '氧气和糖分' }], correctKey: 'B' },
  ],
};

const FALLBACK_INDICES: Record<string, number> = {};

/** 打乱选项并重新定位正确选项的 key */
function shuffleOptionsAndLocateCorrect(
  options: { key: string; text: string }[],
  correctKey: string,
): { shuffled: { key: string; text: string }[]; newCorrectKey: string } {
  const correctOption = options.find(o => o.key === correctKey);
  if (!correctOption) return { shuffled: options, newCorrectKey: options[0]?.key ?? 'A' };
  const shuffled = shuffleArray(options);
  const newCorrectKey = shuffled.find(o => o.text === correctOption.text)?.key ?? shuffled[0]?.key ?? 'A';
  return { shuffled, newCorrectKey };
}

function getFallbackQuestion(subject: string): GameQuestion {
  const bank = FALLBACK[subject] || FALLBACK.math;
  if (!FALLBACK[subject]) console.warn(`[game] 未知学科 "${subject}"，降级使用数学兜底题库`);
  FALLBACK_INDICES[subject] ??= 0;
  const idx = FALLBACK_INDICES[subject]++ % bank.length;
  const q = { ...bank[idx] };
  const { shuffled, newCorrectKey } = shuffleOptionsAndLocateCorrect(q.options, q.correctKey);
  return { ...q, id: `q_${Date.now()}_${randomUUID().slice(0, 6)}`, options: shuffled, correctKey: newCorrectKey };
}

/* ── 题目池 ── */

/** 初始化题目池：用兜底题库预填充，后续请求秒出 */
export function initQuestionPool(model: BaseChatModel) {
  poolModel = model;
  for (const subject of Object.keys(SUBJECT_MAP)) {
    questionPools.set(subject, []);
    fillPoolWithFallback(subject);
  }
  console.log('[game] 题目池已初始化（全部学科）');
}

function fillPoolWithFallback(subject: string) {
  const pool = questionPools.get(subject)!;
  while (pool.length < POOL_MAX) {
    pool.push(getFallbackQuestion(subject));
  }
}

/** 后台用 LLM 补充题目池（不阻塞主请求） */
async function refillPool(subject: string) {
  if (!poolModel || poolRefilling.get(subject)) return;
  poolRefilling.set(subject, true);
  const pool = questionPools.get(subject)!;
  try {
    let added = 0;
    while (pool.length < POOL_MAX && added < 5) {
      try {
        const q = await generateGameQuestion(poolModel, subject);
        pool.push(q);
        added++;
      } catch {
        pool.push(getFallbackQuestion(subject));
        added++;
      }
    }
  } finally {
    poolRefilling.set(subject, false);
  }
}

/** 从题目池获取一道题（秒出） */
export function getPooledQuestion(subject: string): GameQuestion {
  let pool = questionPools.get(subject);
  if (!pool) {
    pool = [];
    questionPools.set(subject, pool);
  }
  if (pool.length === 0) {
    pool.push(getFallbackQuestion(subject));
  }
  // 后台异步补充（不阻塞）
  if (pool.length < POOL_MIN && poolModel) {
    refillPool(subject).catch(e => console.warn('[game] pool refill:', e instanceof Error ? e.message : String(e)));
  }
  return pool.shift() ?? getFallbackQuestion(subject);
}

/** 从题目池批量获取题目 */
export function getPooledQuestions(subject: string, count: number): GameQuestion[] {
  return Array.from({ length: count }, () => getPooledQuestion(subject));
}
