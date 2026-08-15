import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { PALETTE, layoutCow, type CowLayout, type TreeLayout } from '@dbkl/visualization';
import { labelTexture } from '@/lib/label-texture';
import { useLabState, useSimStore, useThemeVersion } from '@/state/store';

const LERP_RATE = 9;
const tmpObject = new THREE.Object3D();
const baseColor = new THREE.Color();

/**
 * 写时复制 B+ 树的附加视图。
 *
 * 树本身仍由 `BTreeView` 画 —— 它就是一棵普通 B+ 树。这里补的三样东西
 * 恰好就是它与 InnoDB 的**全部差别**，所以它们必须一直在画面上：
 *
 *  - 顶上两个 **meta 页**：亮的那个是当前版本。每次提交亮的换一边，
 *    一条线从它指向当前根。**这一步就是提交**，没有 WAL、不需要恢复；
 *  - 右侧两摞小方块：上面一摞是**空闲表**（下个写事务直接拿来用），
 *    下面一摞是**被读者钉住、回收不了的旧页**。开着读事务不放，下面这摞只涨不落；
 *  - 左侧的**只读快照**：每个读者一条线指回它钉住的那个旧根 —— 全程零加锁。
 */
export function CowView({ treeLayout }: { treeLayout: TreeLayout }) {
  const state = useLabState();
  const showLabels = useSimStore((s) => s.showLabels);
  useThemeVersion();

  const layout = useMemo(() => {
    if (!state.cow) return null;
    return layoutCow(state.cow, treeLayout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, state.appliedSeq, treeLayout]);

  const metaMesh = useRef<THREE.InstancedMesh>(null);
  const pageMesh = useRef<THREE.InstancedMesh>(null);
  const readerMesh = useRef<THREE.InstancedMesh>(null);
  const layoutRef = useRef<CowLayout | null>(layout);
  layoutRef.current = layout;
  const glow = useRef(0);

  const pageCap = Math.max(64, nextPow2((layout?.freePages.length ?? 0) + (layout?.pinnedPages.length ?? 0)));
  const readerCap = Math.max(8, nextPow2(layout?.readers.length ?? 0));

  useFrame((_, delta) => {
    const mm = metaMesh.current;
    const pm = pageMesh.current;
    const rm = readerMesh.current;
    const l = layoutRef.current;
    if (!mm || !pm || !rm || !l) return;
    const alpha = 1 - Math.exp(-LERP_RATE * delta);
    // 活跃 meta 页做一个缓慢呼吸：提醒「这一个才是当前版本」。
    glow.current += delta;
    const pulse = 0.5 + 0.5 * Math.sin(glow.current * 2.2);

    l.metas.forEach((meta, i) => {
      tmpObject.position.set(meta.x, meta.y, meta.z);
      tmpObject.scale.set(meta.width, meta.height3d, meta.depth);
      tmpObject.updateMatrix();
      mm.setMatrixAt(i, tmpObject.matrix);
      baseColor.set(meta.active ? PALETTE.cowMetaActive : PALETTE.cowMetaIdle);
      if (meta.active) baseColor.multiplyScalar(0.8 + 0.35 * pulse);
      mm.setColorAt(i, baseColor);
    });

    const pages = [...l.freePages, ...l.pinnedPages];
    pages.forEach((page, i) => {
      tmpObject.position.set(page.x, page.y, page.z);
      tmpObject.scale.set(page.size, page.size, page.size * 0.5);
      tmpObject.updateMatrix();
      pm.setMatrixAt(i, tmpObject.matrix);
      baseColor.set(page.kind === 'free' ? PALETTE.cowFree : PALETTE.cowPinned);
      pm.setColorAt(i, baseColor);
    });

    l.readers.forEach((reader, i) => {
      tmpObject.position.set(reader.x, reader.y, reader.z);
      tmpObject.scale.set(reader.width, reader.height, 0.6);
      tmpObject.updateMatrix();
      rm.setMatrixAt(i, tmpObject.matrix);
      baseColor.set(PALETTE.cowReader);
      rm.setColorAt(i, baseColor);
    });

    void alpha;
    tmpObject.scale.set(0, 0, 0);
    tmpObject.position.set(0, -9999, 0);
    tmpObject.updateMatrix();
    for (let i = l.metas.length; i < mm.count; i++) mm.setMatrixAt(i, tmpObject.matrix);
    for (let i = pages.length; i < pm.count; i++) pm.setMatrixAt(i, tmpObject.matrix);
    for (let i = l.readers.length; i < rm.count; i++) rm.setMatrixAt(i, tmpObject.matrix);

    mm.instanceMatrix.needsUpdate = true;
    pm.instanceMatrix.needsUpdate = true;
    rm.instanceMatrix.needsUpdate = true;
    if (mm.instanceColor) mm.instanceColor.needsUpdate = true;
    if (pm.instanceColor) pm.instanceColor.needsUpdate = true;
    if (rm.instanceColor) rm.instanceColor.needsUpdate = true;
    mm.computeBoundingSphere();
    pm.computeBoundingSphere();
    rm.computeBoundingSphere();
  });

  if (!layout || layout.metas.length === 0) return null;

  return (
    <group>
      <instancedMesh key={`cow-meta`} ref={metaMesh} args={[undefined, undefined, 2]}>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial roughness={0.35} metalness={0.3} />
      </instancedMesh>
      <instancedMesh key={`cow-pages-${pageCap}`} ref={pageMesh} args={[undefined, undefined, pageCap]}>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial roughness={0.6} metalness={0.1} />
      </instancedMesh>
      <instancedMesh key={`cow-readers-${readerCap}`} ref={readerMesh} args={[undefined, undefined, readerCap]}>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial roughness={0.4} metalness={0.2} />
      </instancedMesh>

      <Links layout={layout} />
      {showLabels && <CowLabels layout={layout} />}
    </group>
  );
}

/** meta → 根、读者 → 旧根：两组连线用不同颜色，含义完全不同。 */
function Links({ layout }: { layout: CowLayout }) {
  const rootLine = useMemo(() => {
    const l = layout.rootLink;
    return l ? new Float32Array([...l.from, ...l.to]) : null;
  }, [layout]);
  const readerLines = useMemo(() => {
    if (layout.readerLinks.length === 0) return null;
    return new Float32Array(layout.readerLinks.flatMap((l) => [...l.from, ...l.to]));
  }, [layout]);

  return (
    <>
      {rootLine && (
        <lineSegments frustumCulled={false}>
          <bufferGeometry>
            <bufferAttribute attach="attributes-position" args={[rootLine, 3]} />
          </bufferGeometry>
          <lineBasicMaterial color={PALETTE.cowMetaActive} transparent opacity={0.95} toneMapped={false} />
        </lineSegments>
      )}
      {readerLines && (
        <lineSegments frustumCulled={false}>
          <bufferGeometry>
            <bufferAttribute attach="attributes-position" args={[readerLines, 3]} />
          </bufferGeometry>
          <lineBasicMaterial color={PALETTE.cowReader} transparent opacity={0.75} toneMapped={false} />
        </lineSegments>
      )}
    </>
  );
}

function CowLabels({ layout }: { layout: CowLayout }) {
  const state = useLabState();
  const geometry = useMemo(() => new THREE.PlaneGeometry(1, 1), []);
  const c = state.cow;
  const pinned = layout.pinnedPages.length;

  return (
    <group>
      {layout.metas.map((meta) => (
        <mesh
          key={meta.slot}
          geometry={geometry}
          position={[meta.x, meta.y, meta.z + meta.depth / 2 + 0.02]}
          scale={[meta.width * 0.94, meta.height3d * 0.8, 1]}
          renderOrder={3}
        >
          <meshBasicMaterial
            transparent
            depthWrite={false}
            toneMapped={false}
            map={labelTexture(`cow-meta-${meta.slot}|${meta.txnId}|${meta.rootId}|${meta.active}`, {
              title: `meta[${meta.slot}]${meta.active ? ' ●' : ''}`,
              body: `txn=${meta.txnId} · 根 #${meta.rootId ?? '∅'}`,
              titleColor: meta.active ? PALETTE.textPrimary : PALETTE.textMuted,
              bodyColor: meta.active ? PALETTE.textSecondary : PALETTE.textMuted,
              width: 380,
              height: 150,
              fontScale: 0.9,
            })}
          />
        </mesh>
      ))}

      <mesh
        geometry={geometry}
        position={[(layout.metas[0].x + layout.metas[1].x) / 2, layout.bounds.maxY - 0.3, 0]}
        scale={[13, 0.9, 1]}
        renderOrder={2}
      >
        <meshBasicMaterial
          transparent
          depthWrite={false}
          toneMapped={false}
          map={labelTexture(`cow-hint|${c?.txnId ?? 0}|${c?.writeTxns ?? 0}`, {
            body: `两个 meta 页轮流写 · 翻转一次 = 提交一次（已提交 ${c?.writeTxns ?? 0} 个写事务）· 没有 WAL，崩溃不需要恢复`,
            bodyColor: PALETTE.textMuted,
            width: 1200,
            height: 90,
            fontScale: 0.76,
          })}
        />
      </mesh>

      {layout.freePages.length > 0 && (
        <mesh
          geometry={geometry}
          position={[layout.freePages[0].x + 1.2, layout.freePages[0].y + 0.9, 0]}
          scale={[4.4, 0.7, 1]}
          renderOrder={2}
        >
          <meshBasicMaterial
            transparent
            depthWrite={false}
            toneMapped={false}
            map={labelTexture(`cow-free|${layout.freePages.length}`, {
              body: `空闲表 ${layout.freePages.length} 页 · 下个写事务直接复用`,
              bodyColor: PALETTE.textMuted,
              width: 620,
              height: 80,
              fontScale: 0.78,
            })}
          />
        </mesh>
      )}

      {pinned > 0 && (
        <mesh
          geometry={geometry}
          position={[layout.pinnedPages[0].x + 1.4, layout.pinnedPages[0].y + 0.9, 0]}
          scale={[5.4, 0.7, 1]}
          renderOrder={2}
        >
          <meshBasicMaterial
            transparent
            depthWrite={false}
            toneMapped={false}
            map={labelTexture(`cow-pinned|${pinned}|${c?.readers.length ?? 0}`, {
              body: `${pinned} 页被 ${c?.readers.length ?? 0} 个只读快照钉住 —— 回收不了`,
              bodyColor: PALETTE.cowPinned,
              width: 760,
              height: 80,
              fontScale: 0.78,
            })}
          />
        </mesh>
      )}

      {layout.readers.map((reader) => (
        <mesh
          key={reader.id}
          geometry={geometry}
          position={[reader.x, reader.y, reader.z + 0.35]}
          scale={[reader.width * 0.94, reader.height * 0.8, 1]}
          renderOrder={3}
        >
          <meshBasicMaterial
            transparent
            depthWrite={false}
            toneMapped={false}
            map={labelTexture(`cow-reader-${reader.id}|${reader.txnId}|${reader.rootId}`, {
              body: `快照 ${reader.id} · txn=${reader.txnId} · 钉住 #${reader.rootId}`,
              bodyColor: PALETTE.textSecondary,
              width: 520,
              height: 90,
              fontScale: 0.8,
            })}
          />
        </mesh>
      ))}
    </group>
  );
}

function nextPow2(n: number): number {
  let v = 1;
  while (v < n) v *= 2;
  return v;
}
