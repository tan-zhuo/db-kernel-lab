import { useMemo, useRef, type RefObject } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { PALETTE, type TreeLayout } from '@dbkl/visualization';
import { labelTexture } from '@/lib/label-texture';
import { useLabState } from '@/state/store';

interface AnimEntry {
  x: number;
  y: number;
  z: number;
  scale: number;
}

/** 每棵索引树上方的标题牌：索引名、索引列、条目数与树高。 */
export function IndexTitles({ layout }: { layout: TreeLayout }) {
  const state = useLabState();
  const geometry = useMemo(() => new THREE.PlaneGeometry(1, 1), []);

  return (
    <group>
      {layout.groups.map((g) => {
        const ix = state.indexes[g.indexId];
        if (!ix) return null;
        const width = Math.max(6, Math.min(g.maxX - g.minX, 16));
        return (
          <mesh
            key={g.indexId}
            geometry={geometry}
            position={[g.centerX, g.topY + 2.1, 0]}
            scale={[width, width * 0.22, 1]}
            renderOrder={2}
          >
            <meshBasicMaterial
              transparent
              depthWrite={false}
              toneMapped={false}
              map={labelTexture(`title-${g.indexId}|${ix.entries}|${ix.height}|${g.pages}`, {
                title: ix.clustered ? '聚簇索引（表数据）' : '二级索引',
                body: `${ix.name} (${ix.column}) · ${ix.entries} 条 · 树高 ${ix.height} · ${g.pages} 页`,
                titleColor: ix.clustered ? PALETTE.root : PALETTE.internal,
                bodyColor: PALETTE.textSecondary,
                width: 768,
                height: 168,
                fontScale: 0.95,
              })}
            />
          </mesh>
        );
      })}
    </group>
  );
}

const ARC_SEGMENTS = 40;
const curve = new THREE.QuadraticBezierCurve3(new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3());
const tmpPoint = new THREE.Vector3();

/**
 * 回表连线：从二级索引叶子页飞向聚簇索引叶子页的弧线 + 沿线滑动的光点。
 * 这是「二级索引查询为什么更贵」最直观的一帧。
 */
export function LookupArc({ anim }: { anim: RefObject<Map<number, AnimEntry>> }) {
  const state = useLabState();
  const lookup = state.lookup;
  const line = useRef<THREE.BufferGeometry>(null);
  const dot = useRef<THREE.Mesh>(null);
  // lineSegments 需要成对顶点：每段两个端点
  const positions = useMemo(() => new Float32Array(ARC_SEGMENTS * 2 * 3), []);

  useFrame(({ clock }) => {
    const geo = line.current;
    const map = anim.current;
    if (!geo || !map || !lookup) return;
    const from = map.get(lookup.fromPageId);
    const to = lookup.toPageId !== null ? map.get(lookup.toPageId) : undefined;
    const target = to ?? from;
    if (!from || !target) return;

    curve.v0.set(from.x, from.y + 0.5, from.z);
    curve.v2.set(target.x, target.y + 0.5, target.z);
    curve.v1.set(
      (from.x + target.x) / 2,
      Math.max(from.y, target.y) + Math.max(3, Math.abs(from.x - target.x) * 0.22),
      (from.z + target.z) / 2 + 1.2,
    );

    for (let i = 0; i < ARC_SEGMENTS; i++) {
      curve.getPoint(i / ARC_SEGMENTS, tmpPoint);
      positions[i * 6] = tmpPoint.x;
      positions[i * 6 + 1] = tmpPoint.y;
      positions[i * 6 + 2] = tmpPoint.z;
      curve.getPoint((i + 1) / ARC_SEGMENTS, tmpPoint);
      positions[i * 6 + 3] = tmpPoint.x;
      positions[i * 6 + 4] = tmpPoint.y;
      positions[i * 6 + 5] = tmpPoint.z;
    }
    geo.attributes.position.needsUpdate = true;
    geo.computeBoundingSphere();

    if (dot.current) {
      const t = (clock.elapsedTime * 0.8) % 1;
      curve.getPoint(t, tmpPoint);
      dot.current.position.copy(tmpPoint);
      dot.current.visible = lookup.done;
    }
  });

  if (!lookup) return null;

  return (
    <group>
      <lineSegments frustumCulled={false}>
        <bufferGeometry ref={line}>
          <bufferAttribute attach="attributes-position" args={[positions, 3]} />
        </bufferGeometry>
        <lineBasicMaterial color={PALETTE.lookup} transparent opacity={0.9} toneMapped={false} linewidth={2} />
      </lineSegments>
      <mesh ref={dot}>
        <sphereGeometry args={[0.16, 12, 12]} />
        <meshBasicMaterial color={PALETTE.lookup} toneMapped={false} />
      </mesh>
    </group>
  );
}
