/**
 * TikZ 渲染降级模块
 *
 * 服务端 /api/render-tikz 已下线（安全审计 C2）。
 * 竖式运算（\opadd / \opsub / \opmul / \opdiv）保留前端轻量渲染器。
 * 真正的 TikZ 图形显示为"渲染服务暂不可用"的降级提示。
 */

const errBox = (msg: string) =>
  `<div style="color:var(--error);font-size:0.85rem;padding:0.5rem">${msg}</div>`;
const vertBox = (html: string) =>
  `<div class="xlop-vert" style="display:inline-flex;flex-direction:column;align-items:center;font-family:'Nunito','HarmonyOS Sans SC',sans-serif;font-weight:600;line-height:1.3;padding:4px 8px;margin:0 4px;vertical-align:middle;white-space:nowrap">${html}</div>`;

/** 前端竖式渲染：解析 \opadd / \opsub / \opmul / \opdiv 并生成 HTML 表格 */
function renderXlop(code: string): string | null {
  const mAdd = code.match(/\\opadd\s*(?:\[.*?\])?\s*\{(.+?)\}\s*\{(.+?)\}/);
  if (mAdd) return renderAddSub(mAdd[1], mAdd[2], '+');
  const mSub = code.match(/\\opsub\s*(?:\[.*?\])?\s*\{(.+?)\}\s*\{(.+?)\}/);
  if (mSub) return renderAddSub(mSub[1], mSub[2], '\u2212');
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
  const result: string[] = [];
  let carry = 0, carryRow = '';
  for (let i = maxLen - 1; i >= 0; i--) {
    const da = i >= aPadded.length ? 0 : (aPadded[i] === ' ' ? 0 : parseInt(aPadded[i]));
    const db = i >= bPadded.length ? 0 : (bPadded[i] === ' ' ? 0 : parseInt(bPadded[i]));
    const sum = da + db + carry;
    const digit = sum % 10;
    carry = Math.floor(sum / 10);
    result.unshift(String(digit));
    if (carry) carryRow = '\u00B9' + result.slice(0).join('').slice(0, -1).replace(/\d/g, ' ') + '\u00B9 ';
    else carryRow = '';
  }
  if (carry) result.unshift(String(carry));

  const resultStr = result.join('');
  const resLen = resultStr.length;
  const lineWidth = resLen;
  const line = '\u2500'.repeat(lineWidth);

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
  const partials: string[] = [];
  for (let i = b.length - 1; i >= 0; i--) {
    const digit = parseInt(b[i]);
    const partial = String(aNum * digit) + ' '.repeat(b.length - 1 - i);
    partials.push(partial.trim());
  }
  const maxW = Math.max(a.length, b.length + 1, product.length, ...partials.map(p => p.length));
  const lines = [`<div style="letter-spacing:0.15em">${a.padStart(maxW, ' ')}</div>`];
  lines.push(`<div style="letter-spacing:0.15em">\u00D7${b.padStart(maxW - 1, ' ')}</div>`);
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
    <div style="font-size:0.85rem;color:#666">${divisor} \u27CC ${dividend}</div>
    <div style="font-size:0.8rem;color:#18a558;margin-top:2px">\u2248 ${(parseInt(dividend) / parseInt(divisor)).toFixed(1)}</div>
  `);
}

/** HTML 转义辅助 */
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * 处理 DOM 中的 TikZ 占位块：
 * - xlop 竖式命令 → 前端 HTML 渲染
 * - 其他 TikZ 图形 → 降级提示（服务端已下线）
 */
export async function processTikzDiagrams(
  root: ParentNode = document,
  _opts?: { onlyComplete?: boolean },
): Promise<void> {
  const wraps = Array.from(root.querySelectorAll<HTMLElement>('.tikz-wrap[data-tikz]'));
  for (const wrap of wraps) {
    if (wrap.dataset.tikzState === 'done') continue;
    const code = decodeURIComponent(wrap.dataset.tikz ?? '');
    if (!code) continue;

    // 先尝试前端竖式渲染（xlop 命令）
    const vertHtml = renderXlop(code);
    if (vertHtml) {
      wrap.innerHTML = vertHtml;
      wrap.dataset.tikzState = 'done';
      continue;
    }

    // TikZ 服务端渲染已下线，显示降级提示
    wrap.innerHTML = `<details class="tikz-fallback"><summary>\uD83D\uDCD0 TikZ \u56FE\u8868\uFF08\u6E32\u67D3\u670D\u52A1\u5DF2\u4E0B\u7EBF\uFF09</summary><pre><code>${escapeHtml(code)}</code></pre></details>`;
    wrap.dataset.tikzState = 'done';
  }
}
