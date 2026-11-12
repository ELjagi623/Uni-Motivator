import { defineConfig } from 'vitest/config';
import preact from '@preact/preset-vite';

// Dev proxy target is injected by scripts/dev.mjs (the local server picks its own port).
const apiTarget = process.env.TT_API_TARGET ?? 'http://127.0.0.1:4280';

export default defineConfig({
  plugins: [preact()],
  build: {
    outDir: 'app',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': { target: apiTarget, changeOrigin: true },
    },
  },
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    // Pins process.env.TZ before any worker starts, so tests never depend on the machine time zone.
    globalSetup: ['tests/vitest-global-setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/core/**'],
      reporter: ['text', 'json-summary'],
      // Line, statement and function coverage of the pure core must stay at or above 90 percent.
      thresholds: { lines: 90, statements: 90, functions: 90 },
    },
  },
});
