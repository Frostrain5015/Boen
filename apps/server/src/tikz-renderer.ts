import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Semaphore } from './concurrency.js';

const MAX_CODE_LENGTH = 6_000;
const MAX_QUEUE_DEPTH = Number(process.env.TIKZ_MAX_QUEUE_DEPTH ?? 8);
const MAX_CONCURRENCY = Number(process.env.TIKZ_MAX_CONCURRENCY ?? 2);
const USER_WINDOW_MS = 60_000;
const USER_WINDOW_LIMIT = Number(process.env.TIKZ_USER_LIMIT_PER_MINUTE ?? 4);

const renderPool = new Semaphore(MAX_CONCURRENCY);
const renderRequestsByUser = new Map<string, number[]>();
let queuedOrRunning = 0;

export class TikzRenderError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'TikzRenderError';
  }
}

function execFileAsync(command: string, args: string[], options: { cwd: string; timeout: number }) {
  return new Promise<void>((resolve, reject) => {
    execFile(command, args, { ...options, encoding: 'utf8', maxBuffer: 1024 * 1024, windowsHide: true }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

/** The endpoint is intentionally a TikZ fragment renderer, not a LaTeX shell. */
export function validateTikzCode(code: unknown): asserts code is string {
  if (typeof code !== 'string' || !code.trim()) {
    throw new TikzRenderError('TikZ code required', 400);
  }
  if (code.length > MAX_CODE_LENGTH) {
    throw new TikzRenderError('TikZ code too long', 400);
  }
  if (!/\\begin\s*\{tikzpicture\}/i.test(code) || !/\\end\s*\{tikzpicture\}/i.test(code)) {
    throw new TikzRenderError('only a complete tikzpicture environment is accepted', 400);
  }

  const forbidden = [
    /\\(?:input|include|includegraphics|openin|openout|read|readline|newread|newwrite)\b/i,
    /\\(?:write18|immediate\s*\\write|shellescape|directlua|catcode|csname|special)\b/i,
    /\\(?:documentclass|usepackage|begin\s*\{document\}|end\s*\{document\})/i,
    /\\(?:href|url|pdf(?:obj|extension)|every(?:job|par|eof))\b/i,
  ];
  if (forbidden.some((pattern) => pattern.test(code))) {
    throw new TikzRenderError('unsafe TikZ command rejected', 400);
  }

  const environments = [...code.matchAll(/\\(?:begin|end)\s*\{([^}]+)\}/gi)].map((match) => match[1].toLowerCase());
  const allowedEnvironments = new Set(['tikzpicture', 'scope', 'pgfonlayer']);
  if (environments.some((name) => !allowedEnvironments.has(name))) {
    throw new TikzRenderError('unsupported TikZ environment', 400);
  }
}

export function consumeTikzRateLimit(userId: string): void {
  const now = Date.now();
  const recent = (renderRequestsByUser.get(userId) ?? []).filter((timestamp) => timestamp > now - USER_WINDOW_MS);
  if (recent.length >= USER_WINDOW_LIMIT) {
    renderRequestsByUser.set(userId, recent);
    throw new TikzRenderError('TikZ render rate limit exceeded', 429);
  }
  recent.push(now);
  renderRequestsByUser.set(userId, recent);
}

function sanitizeRenderedSvg(svg: string): string {
  // dvisvgm 输出以 <?xml ...?> 声明 + 注释开头，先剥离前导 BOM / XML 声明 / 注释，
  // 再校验主体确为 <svg>，否则下面的 <svg 开头检查会误判为 invalid。
  const body = svg
    .replace(/^﻿/, '')
    .replace(/^\s*<\?xml[^>]*\?>\s*/i, '')
    .replace(/^(?:\s*<!--[\s\S]*?-->\s*)+/, '');
  if (!/^\s*<svg\b/i.test(body)) {
    throw new TikzRenderError('renderer returned invalid SVG', 500);
  }
  if (/<(?:script|foreignObject|iframe|object|embed|audio|video)\b/i.test(body)
    || /\son\w+\s*=/i.test(body)
    || /\b(?:xlink:)?href\s*=\s*["']\s*(?:javascript:|https?:|file:|data:)/i.test(body)) {
    throw new TikzRenderError('renderer returned unsafe SVG', 500);
  }
  return body;
}

function documentFor(code: string): string {
  return String.raw`\documentclass{standalone}
\usepackage{fontspec}
\usepackage{xeCJK}
\setCJKmainfont{Noto Sans CJK SC}
\usepackage{amsmath}
\usepackage{tikz}
\usetikzlibrary{shapes,arrows,positioning,calc,angles,quotes,intersections,through,math,matrix,fit,patterns,decorations.pathmorphing,decorations.pathreplacing}
\usepackage{pgfplots}
\pgfplotsset{compat=1.18}
\begin{document}
${code}
\end{document}`;
}

export async function renderTikzSvg(code: string, requestId: string): Promise<string> {
  if (queuedOrRunning >= MAX_QUEUE_DEPTH) {
    throw new TikzRenderError('TikZ render queue is full', 429);
  }

  queuedOrRunning++;
  const startedAt = performance.now();
  let tmpDir = '';
  try {
    return await renderPool.run(async () => {
      tmpDir = await mkdtemp(join(tmpdir(), 'boen-tikz-'));
      const texPath = join(tmpDir, 'tikz.tex');
      const pdfPath = join(tmpDir, 'tikz.pdf');
      const svgPath = join(tmpDir, 'tikz.svg');
      await writeFile(texPath, documentFor(code), 'utf8');

      await execFileAsync('xelatex', [
        '-no-shell-escape',
        '-interaction=nonstopmode',
        '-halt-on-error',
        `-output-directory=${tmpDir}`,
        texPath,
      ], { cwd: tmpDir, timeout: 12_000 });
      // 注意：dvisvgm 短选项 -o 不支持 `=` 语法（-o=path 会把文件名当成「=path」导致写入失败，
      // 且仍返回 exit 0），必须用长选项 --output=path。
      await execFileAsync('dvisvgm', ['--pdf', '--no-fonts', `--output=${svgPath}`, pdfPath], { cwd: tmpDir, timeout: 8_000 });

      return sanitizeRenderedSvg(await readFile(svgPath, 'utf8'));
    });
  } catch (error) {
    if (error instanceof TikzRenderError) throw error;
    const message = error instanceof Error ? error.message.slice(0, 200) : String(error);
    console.error('[tikz] render_failed', JSON.stringify({ requestId, message }));
    throw new TikzRenderError('TikZ render failed', 500);
  } finally {
    queuedOrRunning--;
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    console.info('[tikz] render_complete', JSON.stringify({ requestId, durationMs: Math.round(performance.now() - startedAt), queuedOrRunning }));
  }
}
