import { watch } from 'vue';
import { useUiStore } from '@/stores/ui';

const ACCENT_MAP: Record<string, string> = {
  chinese: '#ff7a4d',
  math: '#14b48a',
  english: '#6c5ce7',
  science: '#3498db',
};

function makeFaviconSvg(accent: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <circle cx="50" cy="55" r="33" fill="${accent}"/>
    <rect x="36" y="18" width="28" height="11" rx="3" fill="#2c2722"/>
    <polygon points="50,8 78,20 50,32 22,20" fill="#37322c"/>
    <polygon points="50,12 72,20 50,28 28,20" fill="#2c2722"/>
    <circle cx="50" cy="20" r="3" fill="${accent}"/>
    <ellipse cx="40" cy="52" rx="8" ry="9" fill="#fffdf9"/>
    <ellipse cx="60" cy="52" rx="8" ry="9" fill="#fffdf9"/>
    <circle cx="42" cy="53" r="4" fill="#2c2722"/><circle cx="62" cy="53" r="4" fill="#2c2722"/>
    <path d="M42 67 Q50 73 58 67" stroke="#2c2722" stroke-width="2.5" fill="none" stroke-linecap="round"/>
  </svg>`;
}

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

export function useFavicon() {
  const uiStore = useUiStore();
  watch(() => uiStore.subject, updateFavicon, { immediate: true });
}
