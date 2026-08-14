import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { HIGHLIGHT_COLOR, PALETTE, type TreeLayout } from '@dbkl/visualization';
import { hitRate } from '@dbkl/simulation-core';
import { labelTexture } from '@/lib/label-texture';
import { highlightTracker, useLabState, useSimStore } from '@/state/store';

const FRAME_W = 2.1;
const FRAME_H = 1.05;
const FRAME_D = 0.5;
const GAP = 0.28;
const COLUMNS = 4;
/** 缓冲池面板与树右边缘的间距。 */
const OFFSET_X = 4.5;

/** 缓冲池面板在世界坐标中的占位，供「适应视图」把它一起框进来。 */
export function bufferPoolExtent(layout: TreeLayout, frameCount: number) {
  const rows = Math.ceil(Math.max(1, frameCount) / COLUMNS);
  const width = COLUMNS * (FRAME_W + GAP);
  const height = rows * (FRAME_H + GAP);
  const left = layout.bounds.maxX + OFFSET_X;
  const top = Math.max(layout.bounds.maxY, 3);
  return { minX: left, maxX: left + width, minY: top - height / 2, maxY: top + height / 2 + FRAME_H * 2 };
}

const tmpColor = new THREE.Color();
const frameColor = new THREE.Color();

/**
 * Buffer Pool 货架视图。
 *
 * 每个帧就是一个格子：空 = 深灰，驻留 = 蓝，脏页 = 橙，被淘汰的瞬间闪红。
 * 位置跟着树的包围盒走，保证树长大时不会与之重叠。
 */
export function BufferPoolView({ layout }: { layout: TreeLayout }) {
  const state = useLabState();
  const select = useSimStore((s) => s.select);
  const frames = state.buffer.frames;
  const rows = Math.ceil(frames.length / COLUMNS);
  const meshes = useRef<(THREE.Mesh | null)[]>([]);

  const originX = layout.bounds.maxX + OFFSET_X;
  const originY = Math.max(layout.bounds.maxY, 3);

  const geometry = useMemo(() => new THREE.BoxGeometry(FRAME_W, FRAME_H, FRAME_D), []);
  const planeGeometry = useMemo(() => new THREE.PlaneGeometry(FRAME_W * 0.92, FRAME_H * 0.72), []);

  useFrame(() => {
    const now = performance.now();
    frames.forEach((pageId, i) => {
      const mesh = meshes.current[i];
      if (!mesh) return;
      const material = mesh.material as THREE.MeshStandardMaterial;
      if (pageId === null) {
        frameColor.set(PALETTE.slotEmpty);
      } else {
        const page = state.pages[pageId];
        frameColor.set(page?.dirty ? PALETTE.dirty : PALETTE.resident);
        const h = highlightTracker.page(pageId, now);
        if (h) frameColor.lerp(tmpColor.set(HIGHLIGHT_COLOR[h[0]]), 0.3 + 0.6 * h[1]);
      }
      material.color.lerp(frameColor, 0.35);
      material.emissive.copy(material.color).multiplyScalar(pageId === null ? 0.02 : 0.16);
    });
  });

  const stats = state.metrics;
  const rate = hitRate(stats);

  return (
    <group position={[originX + (COLUMNS * (FRAME_W + GAP)) / 2, originY, 0]}>
      <mesh position={[0, FRAME_H * 1.4, 0]} renderOrder={2}>
        <planeGeometry args={[COLUMNS * (FRAME_W + GAP), 0.85]} />
        <meshBasicMaterial
          transparent
          depthWrite={false}
          toneMapped={false}
          map={labelTexture(
            `bp-title|${state.config.evictionPolicy}|${Number.isNaN(rate) ? '-' : rate.toFixed(3)}|${frames.length}`,
            {
              title: `BUFFER POOL · ${state.config.evictionPolicy} · ${frames.length} 帧`,
              body: `命中率 ${Number.isNaN(rate) ? '—' : `${(rate * 100).toFixed(1)}%`}  ·  淘汰 ${stats.evictions}  ·  刷盘 ${stats.flushes}`,
              width: 640,
              height: 150,
              fontScale: 0.86,
            },
          )}
        />
      </mesh>

      {frames.map((pageId, i) => {
        const col = i % COLUMNS;
        const row = Math.floor(i / COLUMNS);
        const x = (col - (COLUMNS - 1) / 2) * (FRAME_W + GAP);
        const y = -(row - (rows - 1) / 2) * (FRAME_H + GAP);
        const page = pageId !== null ? state.pages[pageId] : undefined;
        return (
          <group key={i} position={[x, y, 0]}>
            <mesh
              ref={(m) => {
                meshes.current[i] = m;
              }}
              geometry={geometry}
              onClick={(e) => {
                if (pageId === null) return;
                e.stopPropagation();
                select(pageId);
              }}
            >
              <meshStandardMaterial color={PALETTE.slotEmpty} roughness={0.6} metalness={0.1} />
            </mesh>
            <mesh position={[0, 0, FRAME_D / 2 + 0.01]} geometry={planeGeometry} renderOrder={2}>
              <meshBasicMaterial
                transparent
                depthWrite={false}
                toneMapped={false}
                map={labelTexture(
                  `bp-${i}|${pageId ?? 'empty'}|${page?.dirty ? 'd' : 'c'}|${page?.keys.length ?? 0}`,
                  {
                    title: `frame ${i}`,
                    body: pageId === null ? '—' : `#${pageId}${page?.dirty ? ' ·脏' : ''}`,
                    titleColor: '#6b7a91',
                    bodyColor: pageId === null ? '#3d4757' : page?.dirty ? '#ffc08a' : '#c8f5ff',
                    width: 320,
                    height: 160,
                    fontScale: 1.15,
                  },
                )}
              />
            </mesh>
          </group>
        );
      })}
    </group>
  );
}
