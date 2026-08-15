import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { PALETTE, layoutFractal, type FractalLayout, type TreeLayout } from '@dbkl/visualization';
import { labelTexture } from '@/lib/label-texture';
import { useLabState, useSimStore, useThemeVersion } from '@/state/store';

const tmpObject = new THREE.Object3D();
const baseColor = new THREE.Color();

/**
 * Bε-树的附加视图：给每个内部节点顶上加一条**消息缓冲**。
 *
 * 树本身仍由 `BTreeView` 画 —— 它就是一棵普通 B+ 树。差别全在这条条子上：
 *
 *  - 亮起来的格子数 = 缓冲水位。写入只让**根**那条长一格，
 *    叶子那边完全没动静 —— 这就是「写只碰根」的字面意思；
 *  - 水位满了整条变红，随即一条黄弧射向某个孩子：那一批消息整体下推。
 *    **写放大就发生在这条弧上**，而摊到每条消息的代价被批大小除掉了；
 *  - 点查时被翻过的缓冲会变青：树高 h 的树，一次读要翻 h 块 —— 读放大的来源。
 */
export function FractalView({ treeLayout }: { treeLayout: TreeLayout }) {
  const state = useLabState();
  const showLabels = useSimStore((s) => s.showLabels);
  useThemeVersion();

  const layout = useMemo(() => {
    if (!state.fractal) return null;
    return layoutFractal(state.fractal, treeLayout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, state.appliedSeq, treeLayout]);

  const cellMesh = useRef<THREE.InstancedMesh>(null);
  const layoutRef = useRef<FractalLayout | null>(layout);
  layoutRef.current = layout;
  const pulse = useRef(0);

  const cap = Math.max(128, nextPow2(layout?.cells.length ?? 0));

  useFrame((_, delta) => {
    const cm = cellMesh.current;
    const l = layoutRef.current;
    if (!cm || !l) return;
    pulse.current += delta;
    const beat = 0.6 + 0.4 * Math.sin(pulse.current * 3.4);

    l.cells.forEach((cell, i) => {
      tmpObject.position.set(cell.x, cell.y, cell.z);
      tmpObject.scale.set(cell.width, cell.height, 0.34);
      tmpObject.updateMatrix();
      cm.setMatrixAt(i, tmpObject.matrix);

      if (!cell.filled) baseColor.set(PALETTE.bufferEmpty);
      else if (cell.hot) baseColor.set(PALETTE.bufferHot).multiplyScalar(0.75 + 0.4 * beat);
      else baseColor.set(PALETTE.bufferFilled);
      // 被读路径翻过的那整条缓冲染青：读放大看得见。
      if (cell.probed && cell.filled) baseColor.lerp(new THREE.Color(PALETTE.bufferHit), 0.55);
      cm.setColorAt(i, baseColor);
    });

    tmpObject.scale.set(0, 0, 0);
    tmpObject.position.set(0, -9999, 0);
    tmpObject.updateMatrix();
    for (let i = l.cells.length; i < cm.count; i++) cm.setMatrixAt(i, tmpObject.matrix);

    cm.instanceMatrix.needsUpdate = true;
    if (cm.instanceColor) cm.instanceColor.needsUpdate = true;
    cm.computeBoundingSphere();
  });

  if (!layout || layout.cells.length === 0) return null;

  return (
    <group>
      <instancedMesh key={`fractal-cells-${cap}`} ref={cellMesh} args={[undefined, undefined, cap]}>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial roughness={0.45} metalness={0.2} />
      </instancedMesh>
      <FlushArc layout={layout} />
      {showLabels && <FractalLabels layout={layout} />}
    </group>
  );
}

/** 最近一次下推：父缓冲 → 孩子。写放大就发生在这条弧上。 */
function FlushArc({ layout }: { layout: FractalLayout }) {
  const positions = useMemo(() => {
    const f = layout.flush;
    if (!f) return null;
    // 画成一条抛物线，比直线更容易看出「一批东西被甩下去」。
    const from = new THREE.Vector3(...f.from);
    const to = new THREE.Vector3(...f.to);
    const mid = from.clone().lerp(to, 0.5);
    mid.y += Math.max(0.6, from.distanceTo(to) * 0.22);
    const curve = new THREE.QuadraticBezierCurve3(from, mid, to);
    const pts = curve.getPoints(24);
    const out: number[] = [];
    for (let i = 0; i < pts.length - 1; i++) {
      out.push(pts[i].x, pts[i].y, pts[i].z, pts[i + 1].x, pts[i + 1].y, pts[i + 1].z);
    }
    return new Float32Array(out);
  }, [layout]);

  if (!positions) return null;
  return (
    <lineSegments frustumCulled={false}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <lineBasicMaterial color={PALETTE.bufferFlush} transparent opacity={0.95} toneMapped={false} />
    </lineSegments>
  );
}

function FractalLabels({ layout }: { layout: FractalLayout }) {
  const state = useLabState();
  const geometry = useMemo(() => new THREE.PlaneGeometry(1, 1), []);
  const f = state.fractal;
  if (!f) return null;

  const pending = Object.values(f.buffers).reduce((n, b) => n + b.length, 0);
  const amp = f.injected === 0 ? 0 : f.flushedHops / f.injected;

  return (
    <group>
      <mesh geometry={geometry} position={[0, layout.bounds.maxY + 0.2, 0]} scale={[15, 1.4, 1]} renderOrder={2}>
        <meshBasicMaterial
          transparent
          depthWrite={false}
          toneMapped={false}
          map={labelTexture(`fractal-top|${f.injected}|${f.flushedHops}|${pending}`, {
            title: `消息缓冲 · 在途 ${pending} 条`,
            body: `写了 ${f.injected} 次，消息一共被重写 ${f.flushedHops} 次 → 写放大 ${amp.toFixed(2)}×（B+ 树等于树高）`,
            titleColor: PALETTE.bufferFilled,
            bodyColor: PALETTE.textSecondary,
            width: 1250,
            height: 150,
            fontScale: 0.82,
          })}
        />
      </mesh>

      {f.lastFlush && layout.flush && (
        <mesh
          geometry={geometry}
          position={[(layout.flush.from[0] + layout.flush.to[0]) / 2, (layout.flush.from[1] + layout.flush.to[1]) / 2 + 0.55, 0]}
          scale={[4.6, 0.6, 1]}
          renderOrder={3}
        >
          <meshBasicMaterial
            transparent
            depthWrite={false}
            toneMapped={false}
            map={labelTexture(`fractal-flush|${f.lastFlush.from}|${f.lastFlush.to}|${f.lastFlush.count}`, {
              body: `下推 ${f.lastFlush.count} 条${f.lastFlush.toLeaf ? ' → 落地成数据' : ''}`,
              bodyColor: PALETTE.bufferFlush,
              width: 640,
              height: 70,
              fontScale: 0.8,
            })}
          />
        </mesh>
      )}
    </group>
  );
}

function nextPow2(n: number): number {
  let v = 1;
  while (v < n) v *= 2;
  return v;
}
