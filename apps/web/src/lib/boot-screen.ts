/**
 * 启动画面控制。
 *
 * index.html 里的 `#dbkl-boot` 在 JS 加载前就已经渲染，它同时承担两件事：
 *  1. 首屏加载态（WebGL 与 Worker 就绪前不会白屏）；
 *  2. 爬虫可读的静态正文（SPA 的 SEO 兜底）。
 * React 挂载并且引擎回放完毕后由这里淡出移除。
 */

const BOOT_ID = 'dbkl-boot';
const STEP_ID = 'dbkl-boot-step';

export function setBootStep(text: string): void {
  const el = document.getElementById(STEP_ID);
  if (el) el.textContent = text;
}

export function hideBootScreen(): void {
  const el = document.getElementById(BOOT_ID);
  if (!el || el.dataset.hiding === '1') return;
  el.dataset.hiding = '1';
  el.classList.add('dbkl-boot-done');
  window.setTimeout(() => el.remove(), 450);
}
