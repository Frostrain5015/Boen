/**
 * 动态 Favicon 管理
 *
 * 监听当前学科切换事件，自动更新浏览器标签页图标为对应学科的吉祥物色 SVG。
 */
import { watch } from 'vue';
import { useUiStore } from '@/stores/ui';

/** 学科 → 强调色映射表 */
const ACCENT_MAP: Record<string, string> = {
  chinese: '#ff7a4d',
  math: '#14b48a',
  english: '#6c5ce7',
  science: '#3498db',
};

/** 生成博文新形象的 Favicon SVG（陶瓷球体 + 圆框眼镜 + 金边学士帽） */
function makeFaviconSvg(accent: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <!-- 身体：陶瓷球 -->
    <defs>
      <radialGradient id="fb" cx="35%" cy="28%" r="72%">
        <stop offset="0%" stop-color="#f5f2ed"/><stop offset="55%" stop-color="#e8e4df"/>
        <stop offset="100%" stop-color="#c4beb4"/>
      </radialGradient>
      <radialGradient id="fh" cx="26%" cy="20%" r="45%">
        <stop offset="0%" stop-color="#fff" stop-opacity=".6"/>
        <stop offset="100%" stop-color="#fff" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <circle cx="50" cy="56" r="33" fill="url(#fb)"/>
    <circle cx="50" cy="56" r="33" fill="url(#fh)"/>
    <!-- 眼镜 -->
    <circle cx="38.5" cy="54" r="11" fill="none" stroke="#d4a853" stroke-width="1.8"/>
    <circle cx="61.5" cy="54" r="11" fill="none" stroke="#d4a853" stroke-width="1.8"/>
    <line x1="49.7" y1="54" x2="50.3" y2="54" stroke="#d4a853" stroke-width="1.8" stroke-linecap="round"/>
    <!-- 闭眼横线（默认表情） -->
    <line x1="32" y1="54.5" x2="45" y2="54.5" stroke="#5a554e" stroke-width="2.2" stroke-linecap="round"/>
    <line x1="55" y1="54.5" x2="68" y2="54.5" stroke="#5a554e" stroke-width="2.2" stroke-linecap="round"/>
    <!-- 微笑 -->
    <path d="M43 69 Q50 74 57 69" stroke="#5a554e" stroke-width="2" fill="none" stroke-linecap="round"/>
    <!-- 学士帽 -->
    <rect x="37" y="17" width="26" height="9" rx="2" fill="#2a2a2a"/>
    <rect x="36.5" y="25" width="27" height="2.2" rx="1" fill="#d4a853"/>
    <polygon points="50,10 78,21 50,32 22,21" fill="#2a2a2a"/>
    <polygon points="50,11.5 75.5,21 50,30.5 24.5,21" fill="none" stroke="#d4a853" stroke-width="0.8"/>
    <!-- 流苏 -->
    <path d="M70 21 Q73 27 72 34" fill="none" stroke="#d4a853" stroke-width="1"/>
    <circle cx="72" cy="35" r="2" fill="${accent}"/>
  </svg>`;
}

/** 更新页面 <link rel="icon"> 标签 */
function updateFavicon(subj: string) {
  const color = ACCENT_MAP[subj] ?? '#14b48a';
  const svg = makeFaviconSvg(color);
  const encoded = encodeURIComponent(svg);
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  link.href = `data:image/svg+xml,${encoded}`;
}

/** 注册学科监听，学科变化时自动更新 Favicon */
export function useFavicon() {
  const uiStore = useUiStore();
  watch(() => uiStore.subject, updateFavicon, { immediate: true });
}
