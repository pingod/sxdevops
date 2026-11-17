import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  base: './',
  server: { port: 5199, host: '127.0.0.1' },
  build: {
    rolldownOptions: {
      input: {
        main: `${here}index.html`,
        design: `${here}design.html`,
      },
    },
  },
});
