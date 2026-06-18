/**
 * TikZ 渲染：把 renderMarkdown 产出的 `.tikz-wrap[data-tikz]` 占位块
 * 调服务端 /api/render-tikz 编译为 SVG 并替换。供对话、随堂小测、考试卷等所有场景共用。
 *
 * 竖式运算（\opadd / \opsub / \opmul / \opdiv）不走服务端——用前端轻量渲染器直接生成
 * HTML，避免 xelatex 编译开销与延迟。
 *
 * - 模块级缓存：相同源码只编译一次（跨组件、跨重渲染共享）。
 * - inFlight 去重：同一源码并发只发一次请求（流式逐 token 重渲染时尤为重要）。
 * - onlyComplete：流式输出途中只编译「已闭合」的完整代码块，避免编译半截代码。
 */
/** 模块级缓存：跨组件、跨重渲染共享已编译的 SVG/HTML。markdown.ts 也引用此缓存
 *  以在 v-html 渲染阶段直接输出 SVG，避免流式途中已渲染图被重刷新回占位态。 */
export const tikzCache = new Map<string, string>();
const inFlight = new Map<string, Promise<string>>();

const errBox = (msg: string) =>
  `<div style="color:var(--error);font-size:0.85rem;padding:0.5rem">${msg}</div>`;
const vertBox = (html: string) =>
  `<div class="xlop-vert" style="display:inline-flex;flex-direction:column;align-items:center;font-family:'Nunito','HarmonyOS Sans SC',sans-serif;font-weight:600;line-height:1.3;padding:4px 8px;margin:0 4px;vertical-align:middle;white-space:nowrap">${html}</div>`;

/** 前端竖式渲染：解析 \opadd / \opsub / \opmul / \opdiv 并生成 HTML 表格 */
function renderXlop(code: string): string | null {
  const mAdd = code.match(/\\opadd\s*(?:\[.*?\])?\s*\{(.+?)\}\s*\{(.+?)\}/);
  if (mAdd) return renderAddSub(mAdd[1], mAdd[2], '+');
  const mSub = code.match(/\\opsub\s*(?:\[.*?\])?\s*\{(.+?)\}\s*\{(.+?)\}/);
  if (mSub) return renderAddSub(mSub[1], mSub[2], '−');
  const mMul = code.match(/\\opmul\s*(?:\[.*?\])?\s*\{(.+?)\}\s*\{(.+?)\}/);
  if (mMul) return renderMul(mMul[1], mMul[2]);
  const mDiv = code.match(/\\opdiv\s*(?:\[.*?\])?\s*\{(.+?)\}\s*\{(.+?)\}/);
  if (mDiv) return renderDiv(mDiv[1], mDiv[2]);
  return null;
}

function renderAddSub(aStr: string, bStr: string, op: string): string {
  const a = aStr.trim(), b = bStr.trim();
  const maxLen = Math.max(a.length, b.length);
  const aPadded = a.padStart(maxLen, ' ');
  const bPadded = b.padStart(maxLen, ' ');
  // 逐位加法（含进位）
  const result: string[] = [];
  let carry = 0, carryRow = '';
  for (let i = maxLen - 1; i >= 0; i--) {
    const da = i >= aPadded.length ? 0 : (aPadded[i] === ' ' ? 0 : parseInt(aPadded[i]));
    const db = i >= bPadded.length ? 0 : (bPadded[i] === ' ' ? 0 : parseInt(bPadded[i]));
    const sum = da + db + carry;
    const digit = sum % 10;
    carry = Math.floor(sum / 10);
    result.unshift(String(digit));
    if (carry) carryRow = '¹' + result.slice(0).join('').slice(0, -1).replace(/\d/g, ' ') + '¹ ';
    else carryRow = '';
  }
  if (carry) result.unshift(String(carry));

  const resultStr = result.join('');
  const resLen = resultStr.length;
  const lineWidth = resLen;
  const line = '─'.repeat(lineWidth);

  return vertBox(`
    ${carry ? `<div style="font-size:0.7em;color:#e74c3c;letter-spacing:0.1em;height:1.1em">${' '.repeat(resLen - 1)}${carry}</div>` : ''}
    <div style="letter-spacing:0.15em">${aStr.padStart(resLen, ' ')}</div>
    <div style="letter-spacing:0.15em">${op}${bStr.padStart(resLen - 1, ' ')}</div>
    <div style="border-top:2px solid #2c2722;width:100%;margin:0 0 2px 0;height:0"></div>
    <div style="letter-spacing:0.15em">${resultStr}</div>
  `);
}

function renderMul(aStr: string, bStr: string): string {
  const a = aStr.trim(), b = bStr.trim();
  const aNum = parseInt(a), bNum = parseInt(b);
  const product = String(aNum * bNum);
  // 部分积
  const partials: string[] = [];
  for (let i = b.length - 1; i >= 0; i--) {
    const digit = parseInt(b[i]);
    const partial = String(aNum * digit) + ' '.repeat(b.length - 1 - i);
    partials.push(partial.trim());
  }
  const maxW = Math.max(a.length, b.length + 1, product.length, ...partials.map(p => p.length));
  const lines = [`<div style="letter-spacing:0.15em">${a.padStart(maxW, ' ')}</div>`];
  lines.push(`<div style="letter-spacing:0.15em">×${b.padStart(maxW - 1, ' ')}</div>`);
  if (partials.length > 1) {
    for (const p of partials) {
      lines.push(`<div style="letter-spacing:0.15em;color:#666">${p.padStart(maxW, ' ')}</div>`);
    }
  }
  lines.push(`<div style="border-top:2px solid #2c2722;width:100%;margin:0 0 2px 0;height:0"></div>`);
  lines.push(`<div style="letter-spacing:0.15em">${product.padStart(maxW, ' ')}</div>`);
  return vertBox(lines.join(''));
}

function renderDiv(dividend: string, divisor: string): string {
  return vertBox(`
    <div style="font-size:0.85rem;color:#666">${divisor} ⟌ ${dividend}</div>
    <div style="font-size:0.8rem;color:#18a558;margin-top:2px">≈ ${(parseInt(dividend) / parseInt(divisor)).toFixed(1)}</div>
  `);
}

/** 出现结束标记才算完整——流式途中据此判断能否提前开编 */
function isComplete(code: string): boolean {
  return /\\end\s*\{tikzpicture\}/.test(code) || /\\end\s*\{document\}/.test(code);
}

/** 编译单段 TikZ → SVG（带缓存与并发去重）；失败返回空串 */
function compile(code: string): Promise<string> {
  const cached = tikzCache.get(code);
  if (cached) return Promise.resolve(cached);
  const flight = inFlight.get(code);
  if (flight) return flight;
  const p = (async () => {
    try {
      const res = await fetch('/api/render-tikz', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      const data = (await res.json()) as { svg?: string };
      if (data.svg) { tikzCache.set(code, data.svg); return data.svg; }
      return '';
    } catch {
      return '';
    } finally {
      inFlight.delete(code);
    }
  })();
  inFlight.set(code, p);
  return p;
}

/** 预热缓存：检测到完整代码块即可调用，让编译与后续流式输出并行 */
export function warmTikz(code: string): void {
  if (code && isComplete(code)) void compile(code);
}

export async function processTikzDiagrams(
  root: ParentNode = document,
  opts: { onlyComplete?: boolean } = {},
): Promise<void> {
  const wraps = Array.from(root.querySelectorAll<HTMLElement>('.tikz-wrap[data-tikz]'));
  for (const wrap of wraps) {
    if (wrap.dataset.tikzState === 'done' || wrap.dataset.tikzState === 'pending') continue;
    const code = decodeURIComponent(wrap.dataset.tikz ?? '');
    if (!code) continue;

    // 先尝试前端竖式渲染（xlop 命令）
    const vertHtml = renderXlop(code);
    if (vertHtml) {
      wrap.innerHTML = vertHtml;
      wrap.dataset.tikzState = 'done';
      tikzCache.set(code, vertHtml); // 缓存 HTML，下次直接取
      continue;
    }

    const cached = tikzCache.get(code);
    if (cached) { wrap.innerHTML = cached; wrap.dataset.tikzState = 'done'; continue; }

    // 流式途中只处理已闭合的完整块
    if (opts.onlyComplete && !isComplete(code)) continue;

    wrap.dataset.tikzState = 'pending';
    const el = wrap;
    void compile(code).then((svg) => {
      if (svg) { el.innerHTML = svg; el.dataset.tikzState = 'done'; }
      else { el.innerHTML = errBox('示意图编译失败'); el.dataset.tikzState = ''; }
    });
  }
}
