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

// 性能标记：各阶段耗时
const marks: Record<string, number> = {};
marks['script_start'] = performance.now();

// 延迟 MathLive 导入到空闲时
const loadMathLive = () => {
  import('mathlive').then(({ MathfieldElement }) => {
    MathfieldElement.fontsDirectory = '/mathlive/fonts';
    MathfieldElement.soundsDirectory = null;
    marks['mathlive_ready'] = performance.now();
  }).catch(() => {});
};
if (typeof requestIdleCallback !== 'undefined') {
  requestIdleCallback(loadMathLive, { timeout: 3000 });
} else {
  setTimeout(loadMathLive, 2000);
}
marks['before_mount'] = performance.now();

const app = createApp(App);
app.use(MotionPlugin);
app.use(autoAnimatePlugin);

marks['after_plugins'] = performance.now();
app.mount('#app');
marks['after_mount'] = performance.now();

// 首帧后输出性能报告
requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    marks['first_frame'] = performance.now();
    const jsTime = (marks['first_frame'] - marks['script_start']).toFixed(0);

    // 再加一帧等布局/样式计算完成
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        marks['second_frame'] = performance.now();
        const paintTime = (marks['second_frame'] - marks['first_frame']).toFixed(0);

        const log = [
          `[perf] JS: ${jsTime}ms`,
          `  script→plugins: ${(marks['after_plugins'] - marks['script_start']).toFixed(0)}ms`,
          `  plugins→mount: ${(marks['after_mount'] - marks['after_plugins']).toFixed(0)}ms`,
          `  mount→firstFrame: ${(marks['first_frame'] - marks['after_mount']).toFixed(0)}ms`,
          `[perf] Paint: ${paintTime}ms (布局+样式+合成)`,
        ];
        console.log(log.join('\n'));

        // 页面角落显示
        const el = document.createElement('div');
        el.id = 'perf-debug';
        el.style.cssText = 'position:fixed;bottom:4px;right:4px;z-index:99999;background:#2c2722;color:#f5ecdd;padding:4px 8px;border-radius:8px;font:11px monospace;white-space:pre;opacity:0.7';
        el.textContent = `JS: ${jsTime}ms | Paint: ${paintTime}ms`;
        document.body.appendChild(el);

        // 额外检测 Long Tasks（>50ms 的渲染阻塞）
        if (typeof PerformanceObserver !== 'undefined') {
          const obs = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
              console.warn(`[perf] Long Task: ${entry.duration.toFixed(0)}ms`, entry);
            }
          });
          try { obs.observe({ type: 'longtask', buffered: true }); } catch {}
        }
      });
    });
  });
});
