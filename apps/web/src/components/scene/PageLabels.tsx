import { useMemo, useRef, type RefObject } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { PALETTE, type TreeLayout } from '@dbkl/visualization';
import { labelTexture } from '@/lib/label-texture';
import { useLabState, useSimStore } from '@/state/store';

interface AnimEntry {
  x: number;
  y: number;
  z: number;
  scale: number;
}

/** 超过这个页数就不画文字了（否则贴图与 draw call 都会爆）。 */
const LABEL_LIMIT = 140;
const MAX_KEYS_IN_LABEL = 8;

/**
 * 页面正面的文字标签：页号 / 填充度 / 页内键。
 * 贴图来自 2D Canvas（`labelTexture`），带 LRU 缓存，内容变化才会重画。
 */
export function PageLabels({ layout, anim }: { layout: TreeLayout; anim: RefObject<Map<number, AnimEntry>> }) {
  const state = useLabState();
  const selectedPageId = useSimStore((s) => s.selectedPageId);
  const groups = useRef<(THREE.Mesh | null)[]>([]);
  const geometry = useMemo(() => new THREE.PlaneGeometry(1, 1), []);

  const visible = layout.nodes.length <= LABEL_LIMIT;

  const items = useMemo(() => {
    if (!visible) {
      const sel = selectedPageId !== null ? layout.byId.get(selectedPageId) : undefined;
      return sel ? [sel] : [];
    }
    return layout.nodes;
  }, [layout, visible, selectedPageId]);

  useFrame(() => {
    const map = anim.current;
    if (!map) return;
    items.forEach((node, i) => {
      const mesh = groups.current[i];
      const entry = map.get(node.id);
      if (!mesh || !entry) return;
      mesh.position.set(entry.x, entry.y, entry.z + node.depth / 2 + 0.012);
      mesh.scale.set(node.width * entry.scale, node.height * entry.scale, 1);
      mesh.visible = entry.scale > 0.2;
    });
  });

  return (
    <group>
      {items.map((node, i) => {
        const page = state.pages[node.id];
        if (!page) return null;
        const keys = page.keys.slice(0, MAX_KEYS_IN_LABEL);
        const body = keys.length
          ? keys.join(' · ') + (page.keys.length > MAX_KEYS_IN_LABEL ? ' …' : '')
          : '（空页）';
        const title = `#${node.id} ${node.type === 'leaf' ? 'LEAF' : 'INT'} ${page.keys.length}/${node.capacity}${
          page.dirty ? ' ·脏' : ''
        }`;
        const texture = labelTexture(`${node.id}|${title}|${body}`, {
          title,
          body,
          titleColor: page.dirty ? PALETTE.dirty : '#93a4bd',
          bodyColor: node.type === 'leaf' ? '#e9f1ff' : '#e8e2ff',
          width: 512,
          height: 140,
          fontScale: node.capacity > 8 ? 0.8 : 1,
        });
        return (
          <mesh
            key={node.id}
            ref={(m) => {
              groups.current[i] = m;
            }}
            geometry={geometry}
            renderOrder={2}
          >
            <meshBasicMaterial map={texture} transparent depthWrite={false} toneMapped={false} />
          </mesh>
        );
      })}
    </group>
  );
}
