import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { PALETTE, layoutKv, type KvLayout } from '@dbkl/visualization';
import { labelTexture } from '@/lib/label-texture';
import { useLabState, useSimStore, useThemeVersion } from '@/state/store';

const LERP_RATE = 9;

const tmpObject = new THREE.Object3D();
const baseColor = new THREE.Color();

/**
 * 哈希索引 KV 视图：**上面是内存，下面是磁盘**。
 *
 *  - 上排竖条 = 哈希桶，**高度就是冲突链长度**。桶配少了立刻能看到某几根特别高；
 *  - 下面每一行 = 一个日志文件，格子 = 记录。绿色还有效，暗红是已被覆盖的垃圾；
 *  - 点查时一条黄线从桶直落到记录 —— 全过程就这一跳，与数据量无关。
 *
 * 和 LSM 并排看最有意思：那边为了支持范围扫描，把数据在磁盘上排得整整齐齐、
 * 代价是读要逐层探测；这边把顺序彻底放弃换来一次寻址，代价是**范围扫描根本做不了**。
 */
export function KvView() {
  const state = useLabState();
  const showLabels = useSimStore((s) => s.showLabels);
  useThemeVersion();

  const layout = useMemo(() => {
    if (!state.kv) return null;
    return layoutKv(state.kv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, state.appliedSeq]);

  const bucketMesh = useRef<THREE.InstancedMesh>(null);
  const recordMesh = useRef<THREE.InstancedMesh>(null);
  const layoutRef = useRef<KvLayout | null>(layout);
  layoutRef.current = layout;
  const anim = useRef(new Map<string, number>());

  const bucketCap = Math.max(32, nextPow2(layout?.buckets.length ?? 0));
  const recordCap = Math.max(64, nextPow2(layout?.records.length ?? 0));

  useFrame((_, delta) => {
    const bm = bucketMesh.current;
    const rm = recordMesh.current;
    const l = layoutRef.current;
    if (!bm || !rm || !l) return;
    const alpha = 1 - Math.exp(-LERP_RATE * delta);

    l.buckets.forEach((bucket, i) => {
      const key = `b${bucket.index}`;
      let h = anim.current.get(key) ?? 0.02;
      h += (bucket.height - h) * alpha;
      anim.current.set(key, h);

      tmpObject.position.set(bucket.x, bucket.y - bucket.height / 2 + h / 2, bucket.z);
      tmpObject.scale.set(bucket.width, Math.max(0.05, h), bucket.depth);
      tmpObject.updateMatrix();
      bm.setMatrixAt(i, tmpObject.matrix);

      baseColor.set(bucket.keys.length === 0 ? PALETTE.kvBucketEmpty : PALETTE.kvBucketFilled);
      if (bucket.probed) baseColor.set(PALETTE.kvProbe);
      bm.setColorAt(i, baseColor);
    });

    l.records.forEach((record, i) => {
      tmpObject.position.set(record.x, record.y, record.z);
      tmpObject.scale.set(record.width, record.height, record.depth);
      tmpObject.updateMatrix();
      rm.setMatrixAt(i, tmpObject.matrix);

      baseColor.set(record.live ? PALETTE.kvRecordLive : PALETTE.kvRecordDead);
      if (record.probed) baseColor.set(PALETTE.kvProbe);
      rm.setColorAt(i, baseColor);
    });

    tmpObject.scale.set(0, 0, 0);
    tmpObject.position.set(0, -9999, 0);
    tmpObject.updateMatrix();
    for (let i = l.buckets.length; i < bm.count; i++) bm.setMatrixAt(i, tmpObject.matrix);
    for (let i = l.records.length; i < rm.count; i++) rm.setMatrixAt(i, tmpObject.matrix);

    bm.instanceMatrix.needsUpdate = true;
    rm.instanceMatrix.needsUpdate = true;
    if (bm.instanceColor) bm.instanceColor.needsUpdate = true;
    if (rm.instanceColor) rm.instanceColor.needsUpdate = true;
    bm.computeBoundingSphere();
    rm.computeBoundingSphere();
  });

  if (!layout || layout.buckets.length === 0) return null;

  return (
    <group>
      <instancedMesh key={`kv-buckets-${bucketCap}`} ref={bucketMesh} args={[undefined, undefined, bucketCap]}>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial roughness={0.4} metalness={0.25} />
      </instancedMesh>
      <instancedMesh key={`kv-records-${recordCap}`} ref={recordMesh} args={[undefined, undefined, recordCap]}>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial roughness={0.5} metalness={0.15} />
      </instancedMesh>

      <ProbeLink layout={layout} />
      {showLabels && <KvLabels layout={layout} />}
    </group>
  );
}

/** 探测连线：桶 → 记录。这一跳就是哈希 KV 的全部读路径。 */
function ProbeLink({ layout }: { layout: KvLayout }) {
  const positions = useMemo(() => {
    const link = layout.probeLink;
    if (!link) return null;
    return new Float32Array([...link.from, ...link.to]);
  }, [layout]);

  if (!positions) return null;
  return (
    <lineSegments frustumCulled={false}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <lineBasicMaterial color={PALETTE.kvProbe} transparent opacity={0.95} toneMapped={false} />
    </lineSegments>
  );
}

function KvLabels({ layout }: { layout: KvLayout }) {
  const state = useLabState();
  const geometry = useMemo(() => new THREE.PlaneGeometry(1, 1), []);
  const kv = state.kv;
  const longest = layout.buckets.reduce((n, b) => Math.max(n, b.keys.length), 0);

  return (
    <group>
      <mesh
        geometry={geometry}
        position={[0, (layout.bounds.maxY ?? 6) + 0.4, 0]}
        scale={[14, 1.5, 1]}
        renderOrder={2}
      >
        <meshBasicMaterial
          transparent
          depthWrite={false}
          toneMapped={false}
          map={labelTexture(`kv-mem|${kv?.index.length ?? 0}|${kv?.indexBytes ?? 0}|${longest}`, {
            title: `内存哈希索引 · ${kv?.index.length ?? 0} 个键 / ${kv?.indexBytes ?? 0} B`,
            body: `${layout.buckets.length} 个桶 · 最长冲突链 ${longest} —— 键数被内存卡死，这是哈希 KV 的硬上限`,
            titleColor: PALETTE.kvBucketFilled,
            bodyColor: PALETTE.textSecondary,
            width: 1100,
            height: 150,
            fontScale: 0.84,
          })}
        />
      </mesh>

      {layout.files.map((file) => (
        <mesh key={file.id} geometry={geometry} position={[file.labelX, file.y, 0]} scale={[3.6, 0.6, 1]} renderOrder={2}>
          <meshBasicMaterial
            transparent
            depthWrite={false}
            toneMapped={false}
            map={labelTexture(`kv-file-${file.id}|${file.records}|${file.sealed}`, {
              body: `${file.id} · ${file.records} 条${file.sealed ? ' · 封口' : ' · 活动'}`,
              bodyColor: file.sealed ? PALETTE.textMuted : PALETTE.kvLogActive,
              width: 480,
              height: 80,
              fontScale: 0.78,
            })}
          />
        </mesh>
      ))}

      <mesh
        geometry={geometry}
        position={[0, layout.bounds.minY + 0.6, 0]}
        scale={[13, 0.9, 1]}
        renderOrder={2}
      >
        <meshBasicMaterial
          transparent
          depthWrite={false}
          toneMapped={false}
          map={labelTexture(`kv-disk|${kv?.files.length ?? 0}|${kv?.merges ?? 0}`, {
            body: `磁盘：${kv?.files.length ?? 0} 个追加写日志文件 · 绿=有效 暗红=已被覆盖的垃圾 · 合并 ${kv?.merges ?? 0} 次`,
            bodyColor: PALETTE.textMuted,
            width: 1100,
            height: 90,
            fontScale: 0.78,
          })}
        />
      </mesh>
    </group>
  );
}

function nextPow2(n: number): number {
  let v = 1;
  while (v < n) v *= 2;
  return v;
}
