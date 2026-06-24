import MarkdownIt from 'markdown-it';
import katex from '@traptitech/markdown-it-katex';
import DOMPurify from 'dompurify';
import { renderXlop } from '@/lib/tikz';

// DOMPurify 配置：保留 KaTeX/MathML 渲染所需的标签和属性
const PURIFY_CONFIG: Parameters<typeof DOMPurify.sanitize>[1] = {
  ADD_TAGS: ['math', 'semantics', 'annotation', 'mrow', 'mi', 'mo', 'mn', 'msup', 'msub', 'mfrac', 'mover', 'munder', 'munderover', 'mspace', 'mtext', 'merror', 'mtable', 'mtr', 'mtd', 'menclose', 'msqrt', 'mroot', 'mpadded', 'mphantom', 'mstyle'],
  ADD_ATTR: ['encoding', 'mathvariant', 'xmlns', 'display', 'accent', 'accentunder', 'columnalign', 'rowspacing', 'columnspacing', 'data-tikz', 'data-tikz-state'],
  ALLOW_DATA_ATTR: true,
};

const md = new MarkdownIt({ breaks: false, linkify: true, html: true });
md.use(katex, {
  throwOnError: false,
  errorColor: 'var(--error)',
  // 圈号/中文标点等无字体度量的 Unicode 字符在数学模式里会触发 KaTeX 警告与
  // “No character metrics” 报错。liberateCircledFromMath 已尽量把它们移出公式，
  // 这里再兜底：把这两类告警降级为 ignore，避免控制台刷屏（不影响真正的语法错误）。
  strict: (errorCode: string): 'ignore' | 'warn' | 'error' =>
    errorCode === 'unknownSymbol' || errorCode === 'unicodeTextInMathMode' ? 'ignore' : 'warn',
});

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

// ── 前端竖式渲染：\opadd / \opsub / \opmul / \opdiv → HTML 竖式（同步渲染） ──

/** 把 xlop 命令转成 HTML 竖式（同步渲染，不依赖异步 tikz-wrap pass，不依赖 KaTeX）。 */
function xlopToKatex(code: string): string | null {
  return renderXlop(code);
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
 * 预处理填空标记 ____（3+ 下划线），替换为 KaTeX 安全的带序号下划线。
 * 关键处理逻辑：
 * 1. 先找出所有 $...$ 或 $$...$$ 数学模式区间，在区间内保留 KaTeX 语法
 * 2. ____ 在数学模式内 → 替换为 \underline{\hspace{3em}}（不引入额外 $）
 * 3. ____ 在数学模式外 → 替换为 $\underline{\hspace{3em}}$（包裹进数学模式）
 */
const BLANK_RE = /\_{3,}/g;
const MATH_SPAN_RE = /(\$\$[\s\S]*?\$\$|\$[^$\n]*?\$)/g;

// 无字体度量、本质是题号/步骤标记而非数学符号的 Unicode 字符
// （圈号 ①-⑳、带括号数字 ⑴-⒇、带点数字 ⒈-⒛）。
const NON_MATH_MARKER = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳⑴⑵⑶⑷⑸⑹⑺⑻⑼⑽⑾⑿⒀⒁⒂⒃⒄⒅⒆⒇⒈⒉⒊⒋⒌⒍⒎⒏⒐⒑⒒⒓⒔⒕⒖⒗⒘⒙⒚⒛';
const MARKER_CLASS = `[${NON_MATH_MARKER}]`;
// 公式首/尾的标记（含相邻空白），应整体移到 $ 外部
const LEADING_MARKERS = new RegExp(`^((?:${MARKER_CLASS}\\s*)+)`);
const TRAILING_MARKERS = new RegExp(`((?:\\s*${MARKER_CLASS})+)$`);
const ANY_MARKER = new RegExp(MARKER_CLASS, 'g');
const HAS_MARKER = new RegExp(MARKER_CLASS); // 无 g 标志，test() 无状态副作用

/**
 * 把题号/步骤类圈号字符移出数学模式：
 * - 紧贴 $ 边界的标记 → 提到公式外作为普通文本；
 * - 夹在公式中间的标记 → 用 \text{} 包裹，保证 KaTeX 语法合法。
 * 这样既消除 “Unrecognized Unicode character / No character metrics” 噪音，
 * 也让圈号以正常字体渲染。
 */
function liberateCircledFromMath(text: string): string {
  if (!HAS_MARKER.test(text)) return text;
  return text.replace(MATH_SPAN_RE, (span) => {
    const isBlock = span.startsWith('$$');
    const fence = isBlock ? '$$' : '$';
    let inner = span.slice(fence.length, span.length - fence.length);
    if (!HAS_MARKER.test(inner)) return span;

    let before = '';
    let after = '';
    inner = inner.replace(LEADING_MARKERS, (m) => { before += m.replace(/\s+/g, ''); return ''; });
    inner = inner.replace(TRAILING_MARKERS, (m) => { after = m.replace(/\s+/g, '') + after; return ''; });
    // 剩余夹在中间的标记 → \text{} 包裹
    inner = inner.replace(ANY_MARKER, (m) => `\\text{${m}}`);

    if (inner.trim() === '') return `${before}${after}`; // 公式只剩标记，整体降级为文本
    return `${before}${fence}${inner}${fence}${after}`;
  });
}

function normalizeBlanks(text: string): string {
  // 先提取数学区间占位
  const mathSpans: Record<string, string> = {};
  let mathIndex = 0;
  const withPlaceholders = text.replace(MATH_SPAN_RE, (match) => {
    const cleaned = match.replace(BLANK_RE, '\\underline{\\hspace{3em}}');
    const key = `\x00MATH${mathIndex++}\x00`;
    mathSpans[key] = cleaned;
    return key;
  });

  // 非数学区间的 ____ → 包裹进数学模式
  const result = withPlaceholders.replace(BLANK_RE, ' $\\underline{\\hspace{3em}}$ ');

  // 恢复数学区间
  return result.replace(/\x00MATH\d+\x00/g, (key) => mathSpans[key] || '');
}

/**
 * 折叠「单 $ 行内公式」内部的异常换行。
 * 模型偶尔会在一段行内公式中间吐出换行（如 `$\sqrt{⏎2}$`），随后的逐行
 * 自动闭合逻辑会把每行落单的 $ 各补一个，从而把一条公式撕成两段坏公式。
 * 这里在自动闭合之前，把跨行的行内 $...$ 内部换行折叠为空格；$$ 块级公式
 * 跨行是合法的（KaTeX 会忽略其中的空白），先用占位保护、不受影响。
 */
function joinInlineMathNewlines(text: string): string {
  if (!text.includes('$')) return text;
  const blocks: string[] = [];
  const protectedText = text.replace(/\$\$[\s\S]*?\$\$/g, (m) => {
    blocks.push(m);
    return `\x00BLK${blocks.length - 1}\x00`;
  });
  const joined = protectedText.replace(/\$([^$]+?)\$/g, (whole, inner: string) =>
    inner.includes('\n') ? `$${inner.replace(/\s*\n\s*/g, ' ')}$` : whole,
  );
  return joined.replace(/\x00BLK(\d+)\x00/g, (_, i) => blocks[Number(i)] ?? '');
}

/**
 * 渲染 Markdown + 数学公式 + TikZ 图形。
 * 先把 OpenAI 系模型常用的 \( \) / \[ \] 定界符归一化为 $ / $$，
 * 再交给 markdown-it-katex（支持 $行内$ 与 $$块级$$）。
 * 同时将模型中出现的 \opadd 等 xlop 命令转换为 KaTeX array。
 */
export function renderMarkdown(text: string): string {
  // 先折叠行内公式内的异常换行，再自动闭合未配对的 $（模型有时遗漏闭合定界符）
  const autoClosed = joinInlineMathNewlines(text).split('\n').map(line => {
    // 统计行中 $ 个数，奇数则补一个闭合
    const dollars = line.match(/\$/g);
    if (dollars && dollars.length % 2 === 1) {
      return line + '$';
    }
    return line;
  }).join('\n');

  const normalized = sanitizeGeneratedHtml(autoClosed)
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, e) => `\n$$\n${e}\n$$\n`)
    .replace(/\\\(([\s\S]+?)\\\)/g, (_, e) => `$${e}$`)
    // KaTeX @traptitech/markdown-it-katex 的 $…$ 正则要求内容不以空格结尾，
    // 否则整条公式降级为文字（例如 $6 + 2 = $ 会原样显示 $ 号）。
    // 在交给 KaTeX 前去掉单 $ 行内数学的首尾空白。
    // 「否定后行 (?<!\$)」与「否定前瞻 (?!\$)」联合确保不误伤 $$…$$ 块级公式。
    .replace(/(?<!\$)\$([^$\n]+)\$(?!\$)/g, (_, inner) => `$${inner.trim()}$`)
    // 画线句支持：'被引用的句子' / '被引用的句子' → <u>被引用的句子</u>（语文阅读常见）
    .replace(/[''']([^''']{4,})[''']/g, (_, s) => `<u>${s}</u>`)
    // 修复模型常见 KaTeX 格式错误
    .replace(/(?<!\$)\$(?!\$)([^$]+?)\$\$/g, (_, inner) => `$$${inner}$$`) // $...$$ → $$...$$（混用定界符，只匹配非$内容避免跨边界）
    // 竖式 array 补定界：仅处理「未被 $$ 正确包裹」的 array，避免把已包裹的 $$…$$ 重复包裹
    //（重复包裹会插入空 $$\n$$ 块，导致 KaTeX 渲染整段竖式失败）。
    // 半包裹（仅有结尾 $$，缺开头）→ 补开头；(?<!\$) 跳过前面已有 $ 的情况
    .replace(/(?<!\$)(\\begin\s*\{array\}[\s\S]*?\\end\s*\{array\})\s*\$\$/g, (_, arr) => `\n$$\n${arr}\n$$\n`)
    // 裸 array（前后都没有 $ 定界）→ 补 $$；前置 (?<!\$) + 后随 (?!\s*\$) 双向跳过已包裹的
    .replace(/(?<!\$)\\begin\s*\{array\}([\s\S]*?)\\end\s*\{array\}(?!\s*\$)/g, (_, body) => `\n$$\n\\begin{array}${body}\\end{array}\n$$\n`);
  const html = md.render(liberateCircledFromMath(normalizeXlop(normalizeBlanks(normalized))));
  // KaTeX 报错降级：把 katex-error 红色源码替换为友好的兜底提示，绝不裸吐 LaTeX 源码。
  const fallback = DOMPurify.sanitize(html.replace(
    /<span[^>]*class="katex-error"[^>]*>[\s\S]*?<\/span>/g,
    () => `<span class="katex-fallback" style="color:var(--error);font-size:0.85rem;cursor:help" title="公式渲染失败，已安全降级">⚠ 公式暂不可渲染</span>`,
  ), PURIFY_CONFIG);
  return fallback;
}

/**
 * 行内渲染（不包 <p>、不产生块级间距），用于选项文字等短文本场景。
 */
export function renderMarkdownInline(text: string): string {
  const autoClosed = joinInlineMathNewlines(text).split('\n').map(line => {
    const dollars = line.match(/\$/g);
    if (dollars && dollars.length % 2 === 1) return line + '$';
    return line;
  }).join('\n');
  const normalized = sanitizeGeneratedHtml(autoClosed)
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, e) => `$${e}$`)
    .replace(/\\\(([\s\S]+?)\\\)/g, (_, e) => `$${e}$`);
  const html = md.renderInline(liberateCircledFromMath(normalizeXlop(normalizeBlanks(normalized))));
  return DOMPurify.sanitize(html.replace(
    /<span[^>]*class="katex-error"[^>]*>[\s\S]*?<\/span>/g,
    () => `<span class="katex-fallback" style="color:var(--error);font-size:0.85rem;cursor:help" title="公式渲染失败，已安全降级">⚠</span>`,
  ), PURIFY_CONFIG);
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
