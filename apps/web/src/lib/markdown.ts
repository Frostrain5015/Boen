import MarkdownIt from 'markdown-it';
import katex from '@traptitech/markdown-it-katex';

const md = new MarkdownIt({ breaks: false, linkify: true, html: true });
md.use(katex, { throwOnError: false, errorColor: 'var(--error)' });

function sanitizeGeneratedHtml(text: string): string {
  return String(text ?? '')
    .replace(/&lt;\s*\/?\s*u\s*&gt;/gi, '')
    .replace(/&lt;\s*br\s*\/?\s*&gt;/gi, '\n')
    .replace(/([A-Za-z0-9\u4e00-\u9fff])\s*<\s*\/\s*u\s*>\s*\1\s*<\s*\/\s*u\s*>/gi, '$1')
    .replace(/([A-Za-z0-9\u4e00-\u9fff])\s*<\s*\/\s*u\s*>\s*\1\b/gi, '$1')
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\s*\/?\s*u\s*>/gi, '')
    .replace(/<\s*\/?\s*(?:span|font|div|p|strong|em|b|i)\b[^<>]*>/gi, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── 前端竖式渲染：\opadd / \opsub / \opmul / \opdiv → KaTeX array ─────

/** 把 xlop 命令转成 KaTeX-compatible \begin{array} 字符串 */
function xlopToKatex(code: string): string | null {
  const add = code.match(/\\opadd\s*(?:\[.*?\])?\s*\{(.+?)\}\s*\{(.+?)\}/);
  if (add) return buildArray(add[1].trim(), add[2].trim(), '+');
  const sub = code.match(/\\opsub\s*(?:\[.*?\])?\s*\{(.+?)\}\s*\{(.+?)\}/);
  if (sub) return buildArray(sub[1].trim(), sub[2].trim(), '-');
  const mul = code.match(/\\opmul\s*(?:\[.*?\])?\s*\{(.+?)\}\s*\{(.+?)\}/);
  if (mul) return buildMul(mul[1].trim(), mul[2].trim());
  // 除法简单展示
  const div = code.match(/\\opdiv\s*(?:\[.*?\])?\s*\{(.+?)\}\s*\{(.+?)\}/);
  if (div) {
    const d = parseInt(div[1]), v = parseInt(div[2]);
    if (v === 0) return `$${d} \\div ${v}$$`;
    return `$${d} \\div ${v} = ${(d / v).toFixed(1)}$$`;
  }
  return null;
}

function computeCarries(a: string, b: string): { carries: string[]; result: string } {
  const maxLen = Math.max(a.length, b.length);
  const digits: string[] = [];
  const carries: string[] = [];
  let carry = 0;
  for (let i = maxLen - 1; i >= 0; i--) {
    const da = parseInt(a[a.length - maxLen + i] || '0');
    const db = parseInt(b[b.length - maxLen + i] || '0');
    const sum = da + db + carry;
    carries.unshift(carry > 0 ? `\\scriptstyle{${carry}}` : '');
    digits.unshift(String(sum % 10));
    carry = Math.floor(sum / 10);
  }
  if (carry > 0) carries.unshift(`\\scriptstyle{${carry}}`);
  return { carries, result: digits.join('') };
}

function buildArray(a: string, b: string, op: string): string {
  const aNum = parseInt(a), bNum = parseInt(b);
  const result = op === '+' ? String(aNum + bNum) : String(aNum - bNum);
  const resLen = result.length;
  const rows: string[] = [];

  // 进位行
  if (op === '+') {
    const { carries } = computeCarries(a, b);
    const carryPadded = carries.map((c, i) => {
      const pad = resLen - carries.length + i;
      return c ? ' '.repeat(Math.max(0, pad)) + c : '';
    }).join('').trimEnd();
    if (carryPadded) rows.push(carryPadded.replace(/ /g, '\\;'));
  }

  rows.push(a.padStart(resLen, '~'));
  rows.push(op + '\\;' + b.padStart(resLen - 1, '~'));
  rows.push('\\hline\\;' + result.padStart(resLen, '~'));
  const body = rows.map(r => r.replace(/~/g, '\\phantom{0}')).join('\\\\\n');
  return `$$\n\\begin{array}{r}\n${body}\n\\end{array}\n$$`;
}

function buildMul(a: string, b: string): string {
  const aNum = parseInt(a), bNum = parseInt(b);
  const product = String(aNum * bNum);
  const resLen = product.length;
  const rows: string[] = [a.padStart(resLen, '~')];
  rows.push('\\times\\;' + b.padStart(resLen - 1, '~'));
  if (b.length > 1) {
    for (let i = b.length - 1; i >= 0; i--) {
      const digit = parseInt(b[i]);
      const partial = String(aNum * digit);
      const pad = resLen - partial.length - (b.length - 1 - i);
      rows.push(partial.padStart(pad + partial.length, '~'));
    }
  }
  rows.push('\\hline\\;' + product.padStart(resLen, '~'));
  const body = rows.map(r => r.replace(/~/g, '\\phantom{0}')).join('\\\\\n');
  return `$$\n\\begin{array}{r}\n${body}\n\\end{array}\n$$`;
}

// ── 行间公式归一化 ─────────────────────────

/**
 * 预处理阶段：把行内/行内 \opadd 等直接转成 KaTeX array（处理模型在文本中直接写 xlop 的情况，
 * 而非放到代码块里）。
 */
function normalizeXlop(text: string): string {
  // 先把被 $ 或 $$ 包裹的 xlop 命令整个替换（避免嵌套数学模式）
  text = text.replace(/(\$\$?)\s*\\op(?:add|sub|mul|div)\b(?:\[.*?\])?\s*\{[^}]+\}\s*\{[^}]+\}\s*(\$\$?)/g, (_, open, close) => {
    // 去掉 $ 包裹后裸替换
    const inner = _.replace(open, '').replace(close, '');
    return xlopToKatex(inner) || _;
  });
  // 裸 xlop 命令（无 $ 包裹）
  return text.replace(/\\op(?:add|sub|mul|div)\b(?:\[.*?\])?\s*\{[^}]+\}\s*\{[^}]+\}/g, (match) => {
    return xlopToKatex(match) || match;
  });
}

// ── 填空标记安全化 ──────────────────────────

/**
 * 预处理填空标记 ____（3+ 下划线），替换为 KaTeX 安全的空白方框。
 * 关键处理逻辑：
 * 1. 先找出所有 $...$ 或 $$...$$ 数学模式区间，在区间内保留 KaTeX 语法
 * 2. ____ 在数学模式内 → 替换为 \boxed{\hspace{2em}}（不引入额外 $）
 * 3. ____ 在数学模式外 → 替换为 $\boxed{\hspace{2em}}$（包裹进数学模式）
 */
const BLANK_RE = /\_{3,}/g;
const MATH_SPAN_RE = /(\$\$[\s\S]*?\$\$|\$[^$\n]*?\$)/g;

function normalizeBlanks(text: string): string {
  // 先提取数学区间占位
  const mathSpans: Record<string, string> = {};
  let mathIndex = 0;
  const withPlaceholders = text.replace(MATH_SPAN_RE, (match) => {
    const cleaned = match.replace(BLANK_RE, '\\boxed{\\hspace{2em}}');
    const key = `\x00MATH${mathIndex++}\x00`;
    mathSpans[key] = cleaned;
    return key;
  });

  // 非数学区间的 ____ → 包裹进数学模式
  const result = withPlaceholders.replace(BLANK_RE, ' $\\boxed{\\hspace{2em}}$ ');

  // 恢复数学区间
  return result.replace(/\x00MATH\d+\x00/g, (key) => mathSpans[key] || '');
}

/**
 * 渲染 Markdown + 数学公式 + TikZ 图形。
 * 先把 OpenAI 系模型常用的 \( \) / \[ \] 定界符归一化为 $ / $$，
 * 再交给 markdown-it-katex（支持 $行内$ 与 $$块级$$）。
 * 同时将模型中出现的 \opadd 等 xlop 命令转换为 KaTeX array。
 */
export function renderMarkdown(text: string): string {
  const normalized = sanitizeGeneratedHtml(text)
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, e) => `\n$$\n${e}\n$$\n`)
    .replace(/\\\(([\s\S]+?)\\\)/g, (_, e) => `$${e}$`)
    // 画线句支持：'被引用的句子' / '被引用的句子' → <u>被引用的句子</u>（语文阅读常见）
    .replace(/[''']([^''']{4,})[''']/g, (_, s) => `<u>${s}</u>`)
    // 修复模型常见 KaTeX 格式错误
    .replace(/\$(.+?)\$\$/g, (_, inner) => `$$${inner}$$`) // $...$$ → $$...$$（混用定界符）
    .replace(/\\begin\s*\{array\}([\s\S]*?)\\end\s*\{array\}\s*\$\$/g, (_, body) => `\n$$\\begin{array}${body}\\end{array}\n$$`) // \begin{array}...\end{array}$$ → 补开头 $$
    .replace(/(^|[^$])?\\begin\s*\{array\}([\s\S]*?)\\end\s*\{array\}/g, (_, prefix, body) => {
      if (prefix?.includes('$')) return _;
      return `${prefix || ''}\n$$\n\\begin{array}${body}\\end{array}\n$$\n`;
    });
  return md.render(normalizeXlop(normalizeBlanks(normalized)));
}

/**
 * 行内渲染（不包 <p>、不产生块级间距），用于选项文字等短文本场景。
 */
export function renderMarkdownInline(text: string): string {
  const normalized = sanitizeGeneratedHtml(text)
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, e) => `$${e}$`)
    .replace(/\\\(([\s\S]+?)\\\)/g, (_, e) => `$${e}$`);
  return md.renderInline(normalizeXlop(normalizeBlanks(normalized)));
}

// ── TikZ 代码块：服务端已下线，降级为占位 ──────────────

/**
 * 自定义 fence：```tikz 以及 ```latex 且包含 tikzpicture → 占位块（processTikzDiagrams 会处理 xlop 或显示降级提示）
 * （xlop 竖式已被上面的 normalization 处理，此处不再需要捕获 xlop）
 */
const defaultFence = md.renderer.rules.fence;
md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const info = tokens[idx].info.trim().toLowerCase();
  const content = tokens[idx].content;
  // xlop 竖式：直接在 fence 内转成 KaTeX 渲染
  if ((info === 'tikz' || info === 'latex') && /\\op(?:add|sub|mul|div)\b/.test(content) && !/\\begin\s*\{tikzpicture\}/.test(content)) {
    const katexHtml = xlopToKatex(content);
    if (katexHtml) return md.render(katexHtml);
  }
  // tikz 图形 → 占位，processTikzDiagrams 会渲染 xlop 或显示降级提示
  if (info === 'tikz' || (info === 'latex' && /\\begin\s*\{tikzpicture\}/.test(content))) {
    const encoded = encodeURIComponent(content.trim());
    return `<div class="tikz-wrap" data-tikz="${encoded}"><div class="tikz-gen"><span class="tikz-gen-icon">\uD83D\uDCD0</span><span class="tikz-gen-label">TikZ \u6E32\u67D3\u4E2D\u2026</span></div></div>\n`;
  }
  return defaultFence!(tokens, idx, options, env, self);
};
