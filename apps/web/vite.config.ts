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
});
