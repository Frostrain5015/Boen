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
// MathLive：导入即注册 <math-field> 自定义元素
// 暂注释排查启动卡顿，后续按需动态导入
// import { MathfieldElement } from 'mathlive';
// MathfieldElement.fontsDirectory = '/mathlive/fonts';
// MathfieldElement.soundsDirectory = null;
import App from './App.vue';

createApp(App).use(MotionPlugin).use(autoAnimatePlugin).mount('#app');
