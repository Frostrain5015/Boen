import MarkdownIt from 'markdown-it';
import katex from '@traptitech/markdown-it-katex';

const md = new MarkdownIt({ breaks: false, linkify: true });
md.use(katex, { throwOnError: false, errorColor: 'var(--error)' });

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
  return text.replace(/\\op(?:add|sub|mul|div)\b(?:\[.*?\])?\s*\{[^}]+\}\s*\{[^}]+\}/g, (match) => {
    return xlopToKatex(match) || match;
  });
}

// ── 填空标记安全化 ──────────────────────────

/**
 * 预处理填空标记 ____（3+ 下划线），替换为 KaTeX 安全的空白方框。
 * 解决 LLM 输出如 $y = $______ 导致的 LaTeX 编译失败。
 * 三步处理：$____ → 移除 $ 并换空白 / ____$ → 换空白并保留 $ / 独立 ____ → 换空白
 */
const BLANK_RE = /\_{3,}/g;

function normalizeBlanks(text: string): string {
  return text
    .replace(/\$\_{3,}/g, ' $\\boxed{\\hspace{2em}}$ ')  // $______ → 空白在数学模式外
    .replace(/\_{3,}\$/g, ' $\\boxed{\\hspace{2em}}$ ')  // ______$ → 同上
    .replace(BLANK_RE, ' $\\boxed{\\hspace{2em}}$ ');    // 独立 ____ → 空白在数学模式内
}

/**
 * 渲染 Markdown + 数学公式 + TikZ 图形。
 * 先把 OpenAI 系模型常用的 \( \) / \[ \] 定界符归一化为 $ / $$，
 * 再交给 markdown-it-katex（支持 $行内$ 与 $$块级$$）。
 * 同时将模型中出现的 \opadd 等 xlop 命令转换为 KaTeX array。
 */
export function renderMarkdown(text: string): string {
  const normalized = (text ?? '')
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, e) => `\n$$\n${e}\n$$\n`)
    .replace(/\\\(([\s\S]+?)\\\)/g, (_, e) => `$${e}$`);
  return md.render(normalizeXlop(normalizeBlanks(normalized)));
}

/**
 * 行内渲染（不包 <p>、不产生块级间距），用于选项文字等短文本场景。
 */
export function renderMarkdownInline(text: string): string {
  const normalized = (text ?? '')
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
    const encoded = encodeURIComponent(content);
    return `<div class="tikz-wrap" data-tikz="${encoded}"><div class="tikz-gen"><span class="tikz-gen-icon">\uD83D\uDCD0</span><span class="tikz-gen-label">TikZ \u6E32\u67D3\u4E2D\u2026</span></div></div>\n`;
  }
  return defaultFence!(tokens, idx, options, env, self);
};
