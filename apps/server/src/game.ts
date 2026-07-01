/**
 * 教育游戏 —— 知识跑酷：单题出题接口
 *
 * 按学科出题，支持 LLM 生成 + 内置兜底题库。
 */
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { SystemMessage, HumanMessage } from '@langchain/core/messages';

export interface GameQuestion {
  id: string;
  stem: string;
  options: { key: string; text: string }[];
  correctKey: string;
}

const SUBJECT_MAP: Record<string, { label: string; emoji: string }> = {
  math: { label: '数学', emoji: '🔢' },
  chinese: { label: '语文', emoji: '📖' },
  english: { label: '英语', emoji: '🔤' },
  science: { label: '科学', emoji: '🔬' },
};

/** 按学科出题 */
export async function generateGameQuestion(model: BaseChatModel, subject: string): Promise<GameQuestion> {
  // 先尝试 LLM 生成
  try {
    const sub = SUBJECT_MAP[subject];
    if (!sub) return getFallbackQuestion(subject);

    const prompt = `你是一名${sub.label}老师。请出一道${sub.label}选择题，要求：
1. 题目难度适中
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

    const result = await model.invoke([
      new SystemMessage('你是一名有经验的学科教师，擅长出题。只输出 JSON。'),
      new HumanMessage(prompt),
    ]);

    const text = typeof result.content === 'string' ? result.content.trim() : '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed.stem && Array.isArray(parsed.options) && parsed.options.length === 4 && parsed.correctKey) {
        const options = parsed.options.map((o: any, i: number) => ({
          key: String.fromCharCode(65 + i),
          text: o.text,
        }));
        const validKeys = new Set(options.map((o: any) => o.key));
        const correctKey = validKeys.has(parsed.correctKey) ? parsed.correctKey : options[0].key;
        const shuffled = shuffleArray(options);
        const correctText = options.find((o: any) => o.key === correctKey)?.text ?? options[0].text;
        const newCorrectKey = shuffled.find((o: any) => o.text === correctText)?.key ?? shuffled[0].key;
        return { id: `q_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, stem: parsed.stem, options: shuffled, correctKey: newCorrectKey };
      }
    }
  } catch (err) {
    console.warn('[game] LLM 出题失败，降级内置题库:', err instanceof Error ? err.message.slice(0, 100) : err);
  }

  return getFallbackQuestion(subject);
}

function shuffleArray<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
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

function getFallbackQuestion(subject: string): GameQuestion {
  const bank = FALLBACK[subject] || FALLBACK.math;
  FALLBACK_INDICES[subject] ??= 0;
  const idx = FALLBACK_INDICES[subject]++ % bank.length;
  const q = { ...bank[idx] };
  const shuffled = shuffleArray(q.options);
  const correctText = q.options.find(o => o.key === q.correctKey)!.text;
  const newCorrectKey = shuffled.find(o => o.text === correctText)!.key;
  return { ...q, id: `q_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, options: shuffled, correctKey: newCorrectKey };
}
