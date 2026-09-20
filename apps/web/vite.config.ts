import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

export default defineConfig({
  plugins: [
    // math-field 是 MathLive 注册的原生自定义元素，告知 Vue 编译器别当组件解析
    vue({ template: { compilerOptions: { isCustomElement: (tag) => tag === 'math-field' } } }),
    tailwindcss(),
  ],
  // 与后端共用仓库根的 .env（Frost ID 等 VITE_ 变量都放在根 .env）
  envDir: path.resolve(__dirname, '../..'),
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:8787', changeOrigin: true },
    },
  },
  build: {
    rollupOptions: {
      output: {
        // Vite 8 底层换成 rolldown，manualChunks 只接受函数形式（对象形式会报
        // "Invalid type: Expected Function but received Object" 直接构建失败）。
        // 判定顺序要紧：@traptitech/markdown-it-katex 的路径里含 markdown-it，
        // 必须先判 katex 分包，否则会被误归到 vendor-markdown。
        manualChunks(id) {
          const norm = id.replace(/\\/g, '/');
          if (!norm.includes('/node_modules/')) return;
          if (norm.includes('/node_modules/mathlive/')) return 'vendor-mathlive';
          if (norm.includes('/node_modules/katex/') || norm.includes('/node_modules/@traptitech/markdown-it-katex/')) return 'vendor-katex';
          if (norm.includes('/node_modules/markdown-it/')) return 'vendor-markdown';
          if (norm.includes('/node_modules/@vueuse/motion/') || norm.includes('/node_modules/@formkit/auto-animate/')) return 'vendor-motion';
          return;
        },
      },
    },
  },
});
