import MarkdownIt from 'markdown-it';
import katex from '@traptitech/markdown-it-katex';

const md = new MarkdownIt({ breaks: true, linkify: true });
md.use(katex, { throwOnError: false, errorColor: 'var(--error)' });

/**
 * 自定义 fence 渲染：```tikz / ```latex（含 tikz 相关）→ 服务端 API 编译占位
 */
const defaultFence = md.renderer.rules.fence;
md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const info = tokens[idx].info.trim().toLowerCase();
  const content = tokens[idx].content;
  if (info === 'tikz' || (info === 'latex' && /\\begin\s*\{tikzpicture\}/.test(content))) {
    const encoded = encodeURIComponent(content);
    return `<div class="tikz-wrap" data-tikz="${encoded}"><div class="tikz-gen"><span class="tikz-gen-icon">📐</span><span class="tikz-gen-label">博文正在画图</span><span class="tikz-gen-dots"><span></span><span></span><span></span></span></div></div>\n`;
  }
  return defaultFence!(tokens, idx, options, env, self);
};

/**
 * 渲染 Markdown + 数学公式 + TikZ 图形。
 * 先把 OpenAI 系模型常用的 \( \) / \[ \] 定界符归一化为 $ / $$，
 * 再交给 markdown-it-katex（支持 $行内$ 与 $$块级$$）。
 */
export function renderMarkdown(text: string): string {
  const normalized = (text ?? '')
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, e) => `\n$$\n${e}\n$$\n`)
    .replace(/\\\(([\s\S]+?)\\\)/g, (_, e) => `$${e}$`);
  return md.render(normalized);
}

/**
 * 行内渲染（不包 <p>、不产生块级间距），用于选项文字等短文本场景。
 * 同样把 \( \) / \[ \] 归一化为 $ 定界，再走 markdown-it 行内规则（含 KaTeX）。
 */
export function renderMarkdownInline(text: string): string {
  const normalized = (text ?? '')
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, e) => `$${e}$`)
    .replace(/\\\(([\s\S]+?)\\\)/g, (_, e) => `$${e}$`);
  return md.renderInline(normalized);
}
