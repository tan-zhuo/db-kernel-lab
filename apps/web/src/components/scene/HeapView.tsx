import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import {
  HIGHLIGHT_COLOR,
  PALETTE,
  layoutHeap,
  tidKey,
  type HeapLayout,
  type TreeLayout,
} from '@dbkl/visualization';
import { formatTid } from '@dbkl/shared';
import { labelTexture } from '@/lib/label-texture';
import { highlightTracker, useLabState, useSimStore } from '@/state/store';

const LERP_RATE = 9;
const ARC_SEGMENTS = 36;

const tmpObject = new THREE.Object3D();
const tmpColor = new THREE.Color();
const baseColor = new THREE.Color();

/**
 * 堆文件视图（PostgreSQL 引擎）。
 *
 * 每个堆页是一排行指针格子，每个格子的颜色就是这个元组版本的命运：
 *
 *  - 绿 = 活元组（当前快照能看见）
 *  - 暗红 = 死元组（已打 xmax，还占着空间 —— 这就是表膨胀）
 *  - 黄 = 重定向指针（HOT 链被 VACUUM 剪枝后留下的）
 *  - 深灰 = 空闲行指针（VACUUM 回收后可复用）
 *
 * 粉色连线是 t_ctid 版本链，绿色的那些是 HOT 链（新版本没写索引）。
 * 页框描青边表示它在可见性映射里是 all-visible，Index Only Scan 可以跳过它。
 */
export function HeapView({ treeLayout }: { treeLayout: TreeLayout }) {
  const state = useLabState();
  const showLabels = useSimStore((s) => s.showLabels);
  const select = useSimStore((s) => s.select);
  const selectedPageId = useSimStore((s) => s.selectedPageId);

  const layout = useMemo(
    () => layoutHeap(state, treeLayout),
    // 状态是原地归约的，靠 appliedSeq 触发重算。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, state.appliedSeq, treeLayout],
  );

  const pageMesh = useRef<THREE.InstancedMesh>(null);
  const tupleMesh = useRef<THREE.InstancedMesh>(null);
  const layoutRef = useRef<HeapLayout>(layout);
  layoutRef.current = layout;
  const anim = useRef(new Map<string, { x: number; y: number; scale: number }>());

  const pageCount = Math.max(16, nextPow2(layout.pages.length));
  const tupleCount = Math.max(64, nextPow2(layout.tuples.length));

  useFrame((_, delta) => {
    const pm = pageMesh.current;
    const tm = tupleMesh.current;
    if (!pm || !tm) return;
    const now = performance.now();
    const alpha = 1 - Math.exp(-LERP_RATE * delta);
    const l = layoutRef.current;

    l.pages.forEach((box, i) => {
      const key = `p${box.pageId}`;
      let entry = anim.current.get(key);
      if (!entry) {
        entry = { x: box.x, y: box.y, scale: 0.01 };
        anim.current.set(key, entry);
      }
      entry.x += (box.x - entry.x) * alpha;
      entry.y += (box.y - entry.y) * alpha;
      entry.scale += (1 - entry.scale) * alpha;

      tmpObject.position.set(entry.x, entry.y, -0.1);
      tmpObject.scale.set(box.width * entry.scale, box.height * entry.scale, 0.42 * entry.scale);
      tmpObject.updateMatrix();
      pm.setMatrixAt(i, tmpObject.matrix);

      baseColor.set(box.allVisible ? PALETTE.allVisible : PALETTE.heapPage);
      if (box.dirty) baseColor.lerp(tmpColor.set(PALETTE.dirty), 0.4);
      if (!box.resident) baseColor.multiplyScalar(0.5);
      const h = highlightTracker.page(box.pageId, now);
      if (h) baseColor.lerp(tmpColor.set(HIGHLIGHT_COLOR[h[0]]), 0.25 + 0.6 * h[1]);
      if (selectedPageId === box.pageId) baseColor.lerp(tmpColor.set(PALETTE.selected), 0.45);
      pm.setColorAt(i, baseColor);
    });

    l.tuples.forEach((t, i) => {
      const key = `t${t.pageId}:${t.slot}`;
      let entry = anim.current.get(key);
      if (!entry) {
        entry = { x: t.x, y: t.y, scale: 0.01 };
        anim.current.set(key, entry);
      }
      entry.x += (t.x - entry.x) * alpha;
      entry.y += (t.y - entry.y) * alpha;
      entry.scale += (1 - entry.scale) * alpha;

      tmpObject.position.set(entry.x, entry.y, t.z);
      tmpObject.scale.set(t.width * entry.scale, t.height * entry.scale, 0.5 * entry.scale);
      tmpObject.updateMatrix();
      tm.setMatrixAt(i, tmpObject.matrix);

      baseColor.set(TUPLE_COLOR[t.state]);
      const h = highlightTracker.slot(t.pageId, t.slot, now);
      if (h) baseColor.lerp(tmpColor.set(HIGHLIGHT_COLOR[h[0]]), 0.3 + 0.7 * h[1]);
      tm.setColorAt(i, baseColor);
    });

    // 隐藏多余实例
    tmpObject.scale.set(0, 0, 0);
    tmpObject.position.set(0, -9999, 0);
    tmpObject.updateMatrix();
    for (let i = l.pages.length; i < pm.count; i++) pm.setMatrixAt(i, tmpObject.matrix);
    for (let i = l.tuples.length; i < tm.count; i++) tm.setMatrixAt(i, tmpObject.matrix);

    pm.instanceMatrix.needsUpdate = true;
    tm.instanceMatrix.needsUpdate = true;
    if (pm.instanceColor) pm.instanceColor.needsUpdate = true;
    if (tm.instanceColor) tm.instanceColor.needsUpdate = true;
    pm.computeBoundingSphere();
    tm.computeBoundingSphere();

    if (anim.current.size > (l.pages.length + l.tuples.length) * 2) {
      const alive = new Set([
        ...l.pages.map((p) => `p${p.pageId}`),
        ...l.tuples.map((t) => `t${t.pageId}:${t.slot}`),
      ]);
      for (const k of anim.current.keys()) if (!alive.has(k)) anim.current.delete(k);
    }
  });

  const handlePageClick = (e: ThreeEvent<MouseEvent>) => {
    if (e.instanceId === undefined) return;
    const box = layoutRef.current.pages[e.instanceId];
    if (!box) return;
    e.stopPropagation();
    select(box.pageId === selectedPageId ? null : box.pageId);
  };

  if (layout.pages.length === 0) return null;

  return (
    <group>
      <instancedMesh
        key={`heap-pages-${pageCount}`}
        ref={pageMesh}
        args={[undefined, undefined, pageCount]}
        onClick={handlePageClick}
      >
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial roughness={0.6} metalness={0.1} />
      </instancedMesh>

      <instancedMesh key={`heap-tuples-${tupleCount}`} ref={tupleMesh} args={[undefined, undefined, tupleCount]}>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial roughness={0.35} metalness={0.2} />
      </instancedMesh>

      <VersionChains layout={layout} />
      <HeapFetchArc layout={layout} treeLayout={treeLayout} />
      {showLabels && <HeapLabels layout={layout} />}
    </group>
  );
}

const TUPLE_COLOR: Record<string, string> = {
  live: PALETTE.tupleLive,
  dead: PALETTE.tupleDead,
  redirect: PALETTE.tupleRedirect,
  unused: PALETTE.tupleUnused,
  aborted: PALETTE.remove,
};

/** t_ctid 版本链：旧版本 → 新版本。HOT 链另用绿色，因为它不需要改索引。 */
function VersionChains({ layout }: { layout: HeapLayout }) {
  const { positions, colors, count } = useMemo(() => {
    const edges = layout.versionEdges;
    const pos = new Float32Array(Math.max(1, edges.length) * 6);
    const col = new Float32Array(Math.max(1, edges.length) * 6);
    const hot = new THREE.Color(PALETTE.hotChain);
    const cold = new THREE.Color(PALETTE.versionChain);
    let n = 0;
    for (const edge of edges) {
      const from = layout.tupleAt.get(tidKey(edge.from.pageId, edge.from.slot));
      const to = layout.tupleAt.get(tidKey(edge.to.pageId, edge.to.slot));
      if (!from || !to) continue;
      const c = edge.hot ? hot : cold;
      pos.set([from.x, from.y + 0.28, from.z, to.x, to.y + 0.28, to.z], n * 6);
      col.set([c.r, c.g, c.b, c.r, c.g, c.b], n * 6);
      n++;
    }
    return { positions: pos, colors: col, count: n };
  }, [layout]);

  if (count === 0) return null;
  return (
    <lineSegments frustumCulled={false}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions.subarray(0, count * 6), 3]} />
        <bufferAttribute attach="attributes-color" args={[colors.subarray(0, count * 6), 3]} />
      </bufferGeometry>
      <lineBasicMaterial vertexColors transparent opacity={0.85} toneMapped={false} />
    </lineSegments>
  );
}

const curve = new THREE.QuadraticBezierCurve3(new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3());
const tmpPoint = new THREE.Vector3();

/**
 * 索引 → 堆的那一跳。
 *
 * 这条弧线是本引擎与 InnoDB 最大的差别：InnoDB 走到叶子就拿到整行了，
 * PostgreSQL 走到叶子只拿到一个 TID，还得再飞下来一趟。
 */
function HeapFetchArc({ layout, treeLayout }: { layout: HeapLayout; treeLayout: TreeLayout }) {
  const state = useLabState();
  const fetch = state.mvcc?.fetch ?? null;
  const line = useRef<THREE.BufferGeometry>(null);
  const dot = useRef<THREE.Mesh>(null);
  const positions = useMemo(() => new Float32Array(ARC_SEGMENTS * 2 * 3), []);

  useFrame(({ clock }) => {
    const geo = line.current;
    if (!geo || !fetch) return;
    const from = treeLayout.byId.get(fetch.fromPageId);
    const to = layout.tupleAt.get(tidKey(fetch.tid.pageId, fetch.tid.slot));
    if (!from || !to) return;

    curve.v0.set(from.x, from.y - 0.3, from.z);
    curve.v2.set(to.x, to.y + 0.35, to.z);
    curve.v1.set((from.x + to.x) / 2, (from.y + to.y) / 2, Math.max(from.z, to.z) + 2.6);
    for (let i = 0; i < ARC_SEGMENTS; i++) {
      curve.getPoint(i / ARC_SEGMENTS, tmpPoint);
      positions.set([tmpPoint.x, tmpPoint.y, tmpPoint.z], i * 6);
      curve.getPoint((i + 1) / ARC_SEGMENTS, tmpPoint);
      positions.set([tmpPoint.x, tmpPoint.y, tmpPoint.z], i * 6 + 3);
    }
    geo.attributes.position.needsUpdate = true;
    geo.computeBoundingSphere();

    if (dot.current) {
      curve.getPoint((clock.elapsedTime * 0.9) % 1, tmpPoint);
      dot.current.position.copy(tmpPoint);
    }
  });

  if (!fetch) return null;
  const color = fetch.found ? PALETTE.heapFetch : PALETTE.remove;
  return (
    <group>
      <lineSegments frustumCulled={false}>
        <bufferGeometry ref={line}>
          <bufferAttribute attach="attributes-position" args={[positions, 3]} />
        </bufferGeometry>
        <lineBasicMaterial color={color} transparent opacity={0.9} toneMapped={false} />
      </lineSegments>
      <mesh ref={dot}>
        <sphereGeometry args={[0.15, 12, 12]} />
        <meshBasicMaterial color={color} toneMapped={false} />
      </mesh>
    </group>
  );
}

/** 堆页标签：块号、已用槽位、all-visible 标记。页太多时只画选中的那页。 */
function HeapLabels({ layout }: { layout: HeapLayout }) {
  const selectedPageId = useSimStore((s) => s.selectedPageId);
  const geometry = useMemo(() => new THREE.PlaneGeometry(1, 1), []);
  const visible = layout.pages.length <= 24 ? layout.pages : layout.pages.filter((p) => p.pageId === selectedPageId);

  return (
    <group>
      <mesh
        geometry={geometry}
        position={[(layout.bounds.minX + layout.bounds.maxX) / 2, layout.bounds.maxY + 1.15, 0]}
        scale={[10, 1.5, 1]}
        renderOrder={2}
      >
        <meshBasicMaterial
          transparent
          depthWrite={false}
          toneMapped={false}
          map={labelTexture(`heap-title|${layout.pages.length}`, {
            title: '堆文件（无序数据页）',
            body: `${layout.pages.length} 个堆页 · 索引项只存 TID，取行必须回堆`,
            titleColor: PALETTE.tupleLive,
            bodyColor: '#dbe6f5',
            width: 900,
            height: 150,
            fontScale: 0.9,
          })}
        />
      </mesh>

      {visible.map((box) => (
        <mesh
          key={box.pageId}
          geometry={geometry}
          position={[box.x, box.y - box.height / 2 - 0.42, 0]}
          scale={[box.width * 0.98, 0.62, 1]}
          renderOrder={2}
        >
          <meshBasicMaterial
            transparent
            depthWrite={false}
            toneMapped={false}
            map={labelTexture(`heap-${box.pageId}|${box.used}|${box.slots}|${box.allVisible}`, {
              body: `blk ${box.blockNo} · #${box.pageId} · ${box.used}/${box.slots}${box.allVisible ? ' · AV' : ''}`,
              bodyColor: box.allVisible ? PALETTE.allVisible : '#8b98ad',
              width: 420,
              height: 72,
              fontScale: 0.8,
            })}
          />
        </mesh>
      ))}
    </group>
  );
}

/** 选中元组时在检查器里显示 TID 用的格式化（与事件日志保持一致）。 */
export function describeTid(pageId: number, slot: number): string {
  return formatTid({ pageId, slot });
}

function nextPow2(n: number): number {
  let v = 1;
  while (v < n) v *= 2;
  return v;
}
