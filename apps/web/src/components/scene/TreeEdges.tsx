import { useMemo, useRef, type RefObject } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { PALETTE, slotOffsetX, type TreeLayout } from '@dbkl/visualization';
import { highlightTracker } from '@/state/store';

interface AnimEntry {
  x: number;
  y: number;
  z: number;
  scale: number;
}

// 复用的 Color 实例（避免每帧 new）。值每帧从 PALETTE 现取，
// 这样换主题后连线颜色下一帧就跟着变，而不是停在启动时的那套。
const childColor = new THREE.Color();
const activeColor = new THREE.Color();
const siblingColor = new THREE.Color();

/**
 * 父子指针 + 叶子链表连线。
 *
 * 全部塞进一个 lineSegments（每帧只更新 BufferAttribute），
 * 因此边的数量对 draw call 没有影响。查找路径上的边会被点亮成黄色。
 */
export function TreeEdges({ layout, anim }: { layout: TreeLayout; anim: RefObject<Map<number, AnimEntry>> }) {
  const count = layout.edges.length;
  const positions = useMemo(() => new Float32Array(Math.max(1, count) * 6), [count]);
  const colors = useMemo(() => new Float32Array(Math.max(1, count) * 6), [count]);
  const geometry = useRef<THREE.BufferGeometry>(null);
  const edgesRef = useRef(layout.edges);
  const layoutRef = useRef(layout);
  edgesRef.current = layout.edges;
  layoutRef.current = layout;

  useFrame(() => {
    const geo = geometry.current;
    const map = anim.current;
    if (!geo || !map) return;
    const now = performance.now();
    const edges = edgesRef.current;
    const byId = layoutRef.current.byId;
    childColor.set(PALETTE.edgeChild);
    activeColor.set(PALETTE.edgeChildActive);
    siblingColor.set(PALETTE.edgeSibling);

    for (let i = 0; i < edges.length; i++) {
      const e = edges[i];
      const a = byId.get(e.from);
      const b = byId.get(e.to);
      const pa = map.get(e.from);
      const pb = map.get(e.to);
      const o = i * 6;
      if (!a || !b || !pa || !pb) {
        positions[o] = positions[o + 1] = positions[o + 2] = 0;
        positions[o + 3] = positions[o + 4] = positions[o + 5] = 0;
        continue;
      }

      if (e.kind === 'child') {
        positions[o] = pa.x + slotOffsetX(e.fromSlot, a.capacity + 1);
        positions[o + 1] = pa.y - a.height / 2;
        positions[o + 2] = pa.z;
        positions[o + 3] = pb.x;
        positions[o + 4] = pb.y + b.height / 2 + 0.28;
        positions[o + 5] = pb.z;
      } else {
        positions[o] = pa.x + a.width / 2;
        positions[o + 1] = pa.y - a.height * 0.15;
        positions[o + 2] = pa.z + a.depth / 2;
        positions[o + 3] = pb.x - b.width / 2;
        positions[o + 4] = pb.y - b.height * 0.15;
        positions[o + 5] = pb.z + b.depth / 2;
      }

      let color = e.kind === 'child' ? childColor : siblingColor;
      if (e.kind === 'child') {
        const ha = highlightTracker.page(e.from, now);
        const hb = highlightTracker.page(e.to, now);
        if (ha?.[0] === 'path' && hb) color = activeColor;
      }
      colors[o] = colors[o + 3] = color.r;
      colors[o + 1] = colors[o + 4] = color.g;
      colors[o + 2] = colors[o + 5] = color.b;
    }

    geo.attributes.position.needsUpdate = true;
    geo.attributes.color.needsUpdate = true;
    geo.setDrawRange(0, edges.length * 2);
  });

  return (
    <lineSegments key={count} frustumCulled={false} renderOrder={-1}>
      <bufferGeometry ref={geometry}>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
        <bufferAttribute attach="attributes-color" args={[colors, 3]} />
      </bufferGeometry>
      <lineBasicMaterial vertexColors transparent opacity={0.85} toneMapped={false} />
    </lineSegments>
  );
}
