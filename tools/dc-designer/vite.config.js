import { defineConfig } from 'vite';

/* 独立静态应用：根目录即应用根（index.html / js / css / lib）。
 * 5200 为设计器；union 检视的查看器由 ../dc-viewer 单独构建（dist/inspect）或 dev 5199 提供。 */
export default defineConfig({
  base: './',
  server: { port: 5200, host: '127.0.0.1' },
  build: { target: 'es2022', outDir: 'dist', assetsDir: 'assets' },
});
