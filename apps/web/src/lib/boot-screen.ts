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

/**
 * 启动画面的最短停留时间。
 *
 * 空实验只有一条 CREATE TABLE，引擎几十毫秒就绪，画面会「闪一下就没了」——
 * 既看不清在做什么，快速刷新时还像页面出了故障。给它一个下限，
 * 让加载过程有个可读的节奏；真正慢的时候（大量命令重放）自然会超过这个下限，
 * 那时它一秒都不会多等。
 */
const MIN_VISIBLE_MS = 900;
/** 淡出动画时长，与 index.html 里 `.dbkl-boot` 的 transition 保持一致。 */
const FADE_MS = 450;

/** 模块加载即开始计时 —— 这已经是 JS 能观测到的最早时刻。 */
const shownAt = Date.now();
let pending: number | undefined;

export function setBootStep(text: string): void {
  const el = document.getElementById(STEP_ID);
  if (el) el.textContent = text;
}

/**
 * 隐藏启动画面。若停留时间还不够 `MIN_VISIBLE_MS`，则推迟到够了再淡出。
 * 重复调用是幂等的。
 */
export function hideBootScreen(): void {
  const el = document.getElementById(BOOT_ID);
  if (!el || el.dataset.hiding === '1' || pending !== undefined) return;

  const remaining = Math.max(0, MIN_VISIBLE_MS - (Date.now() - shownAt));
  if (remaining === 0) {
    fadeOut(el);
    return;
  }
  pending = window.setTimeout(() => {
    pending = undefined;
    fadeOut(el);
  }, remaining);
}

function fadeOut(el: HTMLElement): void {
  if (el.dataset.hiding === '1') return;
  el.dataset.hiding = '1';
  el.classList.add('dbkl-boot-done');
  window.setTimeout(() => el.remove(), FADE_MS);
}
