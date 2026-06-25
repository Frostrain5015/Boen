import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { MotionPlugin } from '@vueuse/motion';
import { autoAnimatePlugin } from '@formkit/auto-animate/vue';
// 本地自托管字体（随构建打包，规避国内访问 Google Fonts 失败）
import '@fontsource/fredoka/400.css';
import '@fontsource/fredoka/500.css';
import '@fontsource/fredoka/600.css';
import '@fontsource/fredoka/700.css';
import '@fontsource/nunito/400.css';
import '@fontsource/nunito/600.css';
import '@fontsource/nunito/700.css';
import '@fontsource/nunito/800.css';
import './fonts.css';
import 'katex/dist/katex.min.css';
import './index.css';
import App from './App.vue';
import router from './router';

// MathLive：空闲时动态导入，不阻塞首帧
if (typeof requestIdleCallback !== 'undefined') {
  requestIdleCallback(() => {
    import('mathlive').then(({ MathfieldElement }) => {
      MathfieldElement.fontsDirectory = '/mathlive/fonts';
      MathfieldElement.soundsDirectory = null;
    }).catch(() => {});
  }, { timeout: 3000 });
} else {
  setTimeout(() => {
    import('mathlive').catch(() => {});
  }, 2000);
}

const app = createApp(App);
app.use(createPinia());
app.use(router);
app.use(MotionPlugin);
app.use(autoAnimatePlugin);

// 全局错误捕获：防止未处理的异常 → 白屏 / 页面崩溃
app.config.errorHandler = (err, _instance, info) => {
  console.error('[Boen 全局错误]', err, info);
  // 如果还有 mount 后可用的 toast，尝试显示用户反馈
  const toastEl = document.querySelector('[data-toast-container]');
  if (toastEl) {
    // 挂载后可通过事件机制通知 Toast（避免循环 import）
    window.dispatchEvent(new CustomEvent('boen:global-error', { detail: '出了点问题，请刷新页面重试' }));
  }
};
window.addEventListener('error', (event) => {
  console.error('[Boen 全局 JS 错误]', event.error ?? event.message);
});
window.addEventListener('unhandledrejection', (event) => {
  console.error('[Boen 未处理 Promise 拒绝]', event.reason);
});

app.mount('#app');
