import { defineConfig, devices } from '@playwright/test';

/**
 * 关键动画路径的端到端 / 视觉回归测试。
 * 复用 vite preview 提供的静态产物，验证「纯静态部署即可运行」。
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4179',
    trace: 'off',
    screenshot: 'off',
    launchOptions: {
      // 无头环境用 SwiftShader 软件渲染 WebGL。
      args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
      // 允许复用系统已装的 Chromium（设置 DBKL_CHROMIUM 环境变量），
      // 避免在离线/受限环境里强制下载浏览器。
      ...(process.env.DBKL_CHROMIUM ? { executablePath: process.env.DBKL_CHROMIUM } : {}),
    },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1600, height: 950 } } }],
  webServer: {
    command: 'pnpm -C apps/web preview --port 4179 --strictPort',
    url: 'http://127.0.0.1:4179',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
