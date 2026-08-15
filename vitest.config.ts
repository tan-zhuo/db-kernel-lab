import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@dbkl/shared': r('./packages/shared/src/index.ts'),
      '@dbkl/simulation-core': r('./packages/simulation-core/src/index.ts'),
      '@dbkl/visualization': r('./packages/visualization/src/index.ts'),
      '@': r('./apps/web/src'),
    },
  },
  test: {
    include: ['packages/**/test/**/*.test.ts', 'apps/web/src/**/*.test.ts'],
    environment: 'node',
    globals: false,
  },
});
