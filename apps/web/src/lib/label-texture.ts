import * as THREE from 'three';
import { PALETTE } from '@dbkl/visualization';

/**
 * 画布文字贴图缓存。
 *
 * 刻意不使用 troika/drei <Text>：它默认从 CDN 拉字体，
 * 与「打开网页即用、可完全离线的静态站点」这一约束冲突。
 * 这里用 2D Canvas 生成贴图，零外部依赖，且一页一张贴图便于批量绘制。
 */

const MAX_CACHE = 400;
const cache = new Map<string, THREE.CanvasTexture>();

function evictIfNeeded(): void {
  while (cache.size > MAX_CACHE) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    cache.get(oldest)?.dispose();
    cache.delete(oldest);
  }
}

export interface LabelStyle {
  width?: number;
  height?: number;
  background?: string;
  title?: string;
  titleColor?: string;
  body?: string;
  bodyColor?: string;
  align?: 'left' | 'center';
  fontScale?: number;
}

/** 生成（或复用）一张两行文字贴图：标题行 + 内容行。 */
export function labelTexture(key: string, style: LabelStyle): THREE.CanvasTexture {
  const cached = cache.get(key);
  if (cached) {
    // 触发 LRU 顺序更新
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }

  const width = style.width ?? 512;
  const height = style.height ?? 128;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');

  if (style.background) {
    ctx.fillStyle = style.background;
    ctx.fillRect(0, 0, width, height);
  } else {
    ctx.clearRect(0, 0, width, height);
  }

  const scale = style.fontScale ?? 1;
  const centered = (style.align ?? 'center') === 'center';
  ctx.textAlign = centered ? 'center' : 'left';
  ctx.textBaseline = 'middle';
  const x = centered ? width / 2 : 16;

  if (style.title) {
    ctx.font = `600 ${Math.round(34 * scale)}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    ctx.fillStyle = style.titleColor ?? PALETTE.textMuted;
    ctx.fillText(style.title, x, style.body ? height * 0.3 : height * 0.5, width - 24);
  }
  if (style.body) {
    ctx.font = `700 ${Math.round(40 * scale)}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    ctx.fillStyle = style.bodyColor ?? PALETTE.textPrimary;
    ctx.fillText(style.body, x, style.title ? height * 0.72 : height * 0.5, width - 24);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  cache.set(key, texture);
  evictIfNeeded();
  return texture;
}

export function clearLabelCache(): void {
  for (const t of cache.values()) t.dispose();
  cache.clear();
}
