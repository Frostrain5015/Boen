import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['apps/server/src/__tests__/**/*.test.ts'],
    globals: true,
    environment: 'node',
  },
  //  跳过 better-sqlite3 等原生模块的解析，避免编译失败
  server: {
    deps: {
      fallbackCJS: true,
    },
  },
});
