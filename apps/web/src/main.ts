import { createApp } from 'vue';
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

createApp(App).use(MotionPlugin).use(autoAnimatePlugin).mount('#app');
