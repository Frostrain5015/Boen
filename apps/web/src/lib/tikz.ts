/**
 * TikZ 渲染：把 renderMarkdown 产出的 `.tikz-wrap[data-tikz]` 占位块
 * 调服务端 /api/render-tikz 编译为 SVG 并替换。供对话、随堂小测、考试卷等所有场景共用。
 *
 * - 模块级缓存：相同源码只编译一次（跨组件、跨重渲染共享）。
 * - inFlight 去重：同一源码并发只发一次请求（流式逐 token 重渲染时尤为重要）。
 * - onlyComplete：流式输出途中只编译「已闭合」的完整代码块，避免编译半截代码。
 */
const tikzCache = new Map<string, string>();
const inFlight = new Map<string, Promise<string>>();

const errBox = (msg: string) =>
  `<div style="color:var(--error);font-size:0.85rem;padding:0.5rem">${msg}</div>`;

/** 出现环境结束标记才算完整——流式途中据此判断能否提前开编 */
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

    const cached = tikzCache.get(code);
    if (cached) { wrap.innerHTML = cached; wrap.dataset.tikzState = 'done'; continue; }

    // 流式途中只处理已闭合的完整块，避免编译半截代码
    if (opts.onlyComplete && !isComplete(code)) continue;

    wrap.dataset.tikzState = 'pending';
    const el = wrap;
    void compile(code).then((svg) => {
      if (svg) { el.innerHTML = svg; el.dataset.tikzState = 'done'; }
      else { el.innerHTML = errBox('示意图编译失败'); el.dataset.tikzState = ''; }
    });
  }
}
