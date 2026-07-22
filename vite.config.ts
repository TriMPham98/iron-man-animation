import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  server: {
    port: 5173,
    open: false,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        soundboard: resolve(__dirname, 'soundboard.html'),
      },
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
