/**
 * TikZ 渲染模块
 *
 * - 竖式运算（\opadd / \opsub / \opmul / \opdiv）保留前端轻量渲染器。
 * - 真正的 TikZ 图形优先使用预渲染 SVG（出题阶段编译），否则调用服务端 /api/render-tikz。
 */

// 渲染结果缓存：key=TikZ 源码，value=SVG。流式输出时 v-html 每个 token 都会重建 DOM，
// 缓存命中可避免对同一图形重复请求服务端（杜绝触发 429 限流 / 队列堆积）。
const renderCache = new Map<string, string>();

const errBox = (msg: string) =>
  `<div style="color:var(--error);font-size:0.85rem;padding:0.5rem">${msg}</div>`;
// 外层 <span> + display:inline-flex 确保 markdown-it 始终作为行内 HTML 透传
//（<div> 是块级元素，嵌入行内时 md.render 可能剥离或变形）。
const vertBox = (html: string) =>
  `<span class="xlop-vert" style="display:inline-flex;flex-direction:column;align-items:center;font-family:'Nunito','HarmonyOS Sans SC',sans-serif;font-weight:600;line-height:1.3;padding:4px 8px;margin:0 4px;vertical-align:middle;white-space:nowrap">${html}</span>`;

function replaceWithSvgImage(wrap: HTMLElement, svg: string) {
  const objectUrl = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  const image = document.createElement('img');
  image.className = 'tikz-rendered-svg';
  image.alt = 'TikZ 示意图';
  image.src = objectUrl;
  image.addEventListener('load', () => URL.revokeObjectURL(objectUrl), { once: true });
  image.addEventListener('error', () => URL.revokeObjectURL(objectUrl), { once: true });
  wrap.replaceChildren(image);
}

/** 前端竖式渲染：解析 \opadd / \opsub / \opmul / \opdiv 并生成 HTML 表格。导出供 markdown 同步调用。 */
export function renderXlop(code: string): string | null {
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
  // 逐位计算（加法进位 / 减法借位）
  const digits: number[] = [];
  let carry = 0; // 加法为正(进位)，减法为负(借位)
  for (let i = maxLen - 1; i >= 0; i--) {
    const da = Number(a[a.length - maxLen + i] || '0');
    const db = Number(b[b.length - maxLen + i] || '0');
    if (op === '+') {
      const s = da + db + carry;
      digits.unshift(s % 10);
      carry = Math.floor(s / 10);
    } else {
      let s = da - db + carry;
      if (s < 0) { s += 10; carry = -1; }
      else { carry = 0; }
      digits.unshift(s);
    }
  }
  if (carry > 0) digits.unshift(carry);
  const resultStr = digits.map(d => Math.abs(d)).join('').replace(/^0+(?=\d)/, '');
  if (resultStr === '') { digits[0] = 0; digits.length = 1; } // 0-0=0
  const resLen = digits.length;
  const resultDisplay = digits.map(d => d >= 0 ? String(d) : `<span style="color:var(--error)">${String(-d)}</span>`).join('');

  // 进位借位提示行
  let carryHint = '';
  if (op === '+') {
    if (carry > 0) carryHint = `<span style="display:block;font-size:0.7em;color:#e74c3c;letter-spacing:0.15em;height:1.1em">${' '.repeat(resLen - 1)}${carry}</span>`;
  } else {
    if (carry < 0) carryHint = `<span style="display:block;font-size:0.7em;color:#2b5fa8;letter-spacing:0.15em;height:1.1em">${' '.repeat(resLen - 1)}<span style="font-size:0.85em">↰</span></span>`;
  }

  return vertBox(`
    ${carryHint}
    <span style="display:block;letter-spacing:0.15em">${a.padStart(resLen, ' ')}</span>
    <span style="display:block;letter-spacing:0.15em">${op}${b.padStart(resLen - 1, ' ')}</span>
    <span style="display:block;border-top:2px solid #2c2722;width:100%;margin:0 0 2px 0;height:0"></span>
    <span style="display:block;letter-spacing:0.15em">${resultDisplay}</span>
  `);
}

function renderMul(aStr: string, bStr: string): string {
  const a = aStr.trim(), b = bStr.trim();
  const aNum = parseInt(a), bNum = parseInt(b);
  const product = String(aNum * bNum);
  const partials: string[] = [];
  for (let i = b.length - 1; i >= 0; i--) {
    const digit = parseInt(b[i]);
    const partial = String(aNum * digit) + ' '.repeat(b.length - 1 - i);
    partials.push(partial.trim());
  }
  const maxW = Math.max(a.length, b.length + 1, product.length, ...partials.map(p => p.length));
  const lines = [`<span style="display:block;letter-spacing:0.15em">${a.padStart(maxW, ' ')}</span>`];
  lines.push(`<span style="display:block;letter-spacing:0.15em">×${b.padStart(maxW - 1, ' ')}</span>`);
  if (partials.length > 1) {
    for (const p of partials) {
      lines.push(`<span style="display:block;letter-spacing:0.15em;color:#666">${p.padStart(maxW, ' ')}</span>`);
    }
  }
  lines.push(`<span style="display:block;border-top:2px solid #2c2722;width:100%;margin:0 0 2px 0;height:0"></span>`);
  lines.push(`<span style="display:block;letter-spacing:0.15em">${product.padStart(maxW, ' ')}</span>`);
  return vertBox(lines.join(''));
}

/** 标准长除法竖式：商对齐在上、左侧除数与除号、逐步乘减与余数。 */
function renderDiv(dividendStr: string, divisorStr: string): string {
  const D = String(parseInt(dividendStr, 10));
  const V = parseInt(divisorStr, 10);
  // 容错：非法输入退回简单展示
  if (!/^\d+$/.test(D) || !Number.isFinite(V) || V <= 0) {
    return vertBox(`<span style="display:block;letter-spacing:0.15em">${escapeHtml(divisorStr)} ) ${escapeHtml(dividendStr)}</span>`);
  }
  const n = D.length;
  const CW = 0.66;                 // 每列宽度(em)
  const cw = `${CW}em`;
  const pw = `${String(V).length * CW + 0.95}em`;  // 左侧「除数 )」前缀宽度

  // 长除法分步：从高位起逐位试商
  const quotient: string[] = Array(n).fill('');
  const steps: Array<{ value: string; end: number; kind: 'prod' | 'rem' }> = [];
  let cur = 0, started = false;
  for (let i = 0; i < n; i++) {
    cur = cur * 10 + Number(D[i]);
    const qd = Math.floor(cur / V);
    if (qd > 0 || started) {
      quotient[i] = String(qd);
      started = true;
      const product = qd * V;
      steps.push({ value: String(product), end: i, kind: 'prod' });
      cur -= product;
      steps.push({ value: String(cur), end: i, kind: 'rem' });
    } else if (i === n - 1) {
      quotient[i] = '0';             // 整体不够除 → 商 0
    }
  }

  const cell = (ch: string, color?: string, underline?: boolean) =>
    `<span style="display:inline-block;width:${cw};text-align:center;${color ? 'color:' + color + ';' : ''}${underline ? 'border-bottom:2px solid #2c2722;' : ''}">${ch}</span>`;
  const slot = `<span style="display:inline-block;width:${pw}"></span>`;
  const row = (prefix: string, build: (c: number) => string) => {
    let cells = '';
    for (let c = 0; c < n; c++) cells += build(c);
    return `<span style="display:inline-flex">${prefix}${cells}</span>`;
  };

  // 商行（每列已对齐到被除数）
  const quotientRow = row(slot, (c) => cell(quotient[c] || ''));
  // 除号顶横线（覆盖被除数各列）
  const barRow = `<span style="display:inline-flex">${slot}<span style="display:inline-block;border-top:2px solid #2c2722;width:calc(${cw} * ${n});height:0"></span></span>`;
  // 被除数行：「除数 )」前缀 + 各位
  const prefixDivisor = `<span style="display:inline-block;width:${pw};text-align:right;padding-right:0.22em">${escapeHtml(String(V))} )</span>`;
  const dividendRow = row(prefixDivisor, (c) => cell(D[c]));
  // 步骤行：乘积(带下划线) → 余数
  let stepHtml = '';
  for (const s of steps) {
    const start = s.end - s.value.length + 1;
    const color = s.kind === 'prod' ? '#666' : '#18a558';
    stepHtml += row(slot, (c) => {
      const inRange = c >= start && c <= s.end;
      return cell(inRange ? s.value[c - start] : '', inRange ? color : undefined, s.kind === 'prod' && inRange);
    });
  }

  return vertBox(`<span style="display:block;font-variant-numeric:tabular-nums;line-height:1.4">${quotientRow}${barRow}${dividendRow}${stepHtml}</span>`);
}

/** HTML 转义辅助 */
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 简易哈希（与服务器端 simpleHash 一致） */
function simpleHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h) + s.charCodeAt(i);
    h |= 0;
  }
  return `h${Math.abs(h).toString(36)}`;
}

/**
 * 处理 DOM 中的 TikZ 占位块：
 * - xlop 竖式命令 → 前端 HTML 渲染
 * - 其他 TikZ 图形 → 优先使用预渲染 SVG，否则调用服务端 /api/render-tikz
 * @param root 根 DOM 节点
 * @param preRendered 预渲染的 SVG 映射（key=TikZ hash, value=SVG），来自考试出题阶段
 */
export async function processTikzDiagrams(
  root: ParentNode = document,
  preRendered?: Record<string, string>,
): Promise<void> {
  const wraps = Array.from(root.querySelectorAll<HTMLElement>('.tikz-wrap[data-tikz]'));
  for (const wrap of wraps) {
    if (wrap.dataset.tikzState === 'done') continue;
    if (wrap.dataset.tikzState === 'rendering') continue;
    let code = '';
    try {
      code = decodeURIComponent(wrap.dataset.tikz ?? '').trim();
    } catch {
      code = String(wrap.dataset.tikz ?? '').trim();
    }
    if (!code) {
      wrap.innerHTML = errBox('TikZ 代码为空');
      wrap.dataset.tikzState = 'done';
      continue;
    }

    // 先尝试前端竖式渲染（xlop 命令）
    const vertHtml = renderXlop(code);
    if (vertHtml) {
      wrap.innerHTML = vertHtml;
      wrap.dataset.tikzState = 'done';
      continue;
    }

    // 优先使用预渲染 SVG（出题阶段已编译好）
    if (preRendered) {
      const hash = simpleHash(code);
      const svg = preRendered[hash];
      if (svg) {
        replaceWithSvgImage(wrap, svg);
        wrap.dataset.tikzState = 'done';
        continue;
      }
    }

    // 命中渲染缓存：直接复用，避免重复请求（流式重渲染 / 同图重复时尤为关键）
    const cachedSvg = renderCache.get(code);
    if (cachedSvg) {
      replaceWithSvgImage(wrap, cachedSvg);
      wrap.dataset.tikzState = 'done';
      continue;
    }

    // 回退：服务端渲染
    wrap.dataset.tikzState = 'rendering';
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 20000);
    try {
      const token = sessionStorage.getItem('boen_access_token');
      const res = await fetch('/api/render-tikz', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ code }),
        signal: controller.signal,
      });
      const data = await res.json().catch(() => ({})) as { svg?: string; error?: string };
      if (res.ok && data.svg) {
        // Treat renderer output as an image resource, never executable DOM.
        renderCache.set(code, data.svg);
        replaceWithSvgImage(wrap, data.svg);
        wrap.dataset.tikzState = 'done';
      } else {
        wrap.innerHTML = `<details class="tikz-fallback"><summary>📐 TikZ 渲染失败</summary><pre><code>${escapeHtml(code)}</code></pre></details>`;
        wrap.dataset.tikzState = 'done';
      }
    } catch {
      wrap.innerHTML = `<details class="tikz-fallback"><summary>📐 TikZ 渲染失败</summary><pre><code>${escapeHtml(code)}</code></pre></details>`;
      wrap.dataset.tikzState = 'done';
    } finally {
      window.clearTimeout(timeout);
    }
  }
}
