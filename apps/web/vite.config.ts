import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  // 静态站点：可直接部署到 GitHub Pages / Vercel / Cloudflare Pages。
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@dbkl/shared': r('../../packages/shared/src/index.ts'),
      '@dbkl/simulation-core': r('../../packages/simulation-core/src/index.ts'),
      '@dbkl/visualization': r('../../packages/visualization/src/index.ts'),
      '@': r('./src'),
    },
  },
  worker: {
    format: 'es',
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
  },
});
