import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import { HIGHLIGHT_COLOR, PALETTE, layoutLsm, levelColor, type LsmLayout } from '@dbkl/visualization';
import { labelTexture } from '@/lib/label-texture';
import { highlightTracker, useLabState, useSimStore } from '@/state/store';

const LERP_RATE = 8;

const tmpObject = new THREE.Object3D();
const tmpColor = new THREE.Color();
const baseColor = new THREE.Color();

/**
 * LSM 层级视图。
 *
 * **横轴是键空间**：每块砖的左右边界就是那个 SST 的 [minKey, maxKey]。
 * 于是两件事变成肉眼可见的几何事实，而不用背结论：
 *
 *  1. L0 的砖块互相重叠、还沿 z 轴叠成一摞 —— 所以点查必须把 L0 全看一遍；
 *  2. L1 及以下的砖块整整齐齐排成一行、绝不重叠 —— 所以每层最多读一个文件。
 *
 * 纵轴从上到下 = MemTable → L0 → L1 …，正好是读取时的探测顺序：
 * 播放一次点查，就能看到探测点自上而下逐块试过去。
 */
export function LsmView() {
  const state = useLabState();
  const showLabels = useSimStore((s) => s.showLabels);
  const selectedSstId = useSimStore((s) => s.selectedSstId);
  const selectSst = useSimStore((s) => s.selectSst);
  const config = state.config;

  const layout = useMemo(() => {
    if (!state.lsm) return null;
    return layoutLsm(state.lsm, {
      levelCapacity: (level) => config.memtableLimit * Math.pow(config.levelFanout, level),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, state.appliedSeq, config.memtableLimit, config.levelFanout]);

  const brickMesh = useRef<THREE.InstancedMesh>(null);
  const layoutRef = useRef<LsmLayout | null>(layout);
  layoutRef.current = layout;
  const anim = useRef(new Map<string, { x: number; y: number; w: number; scale: number }>());

  const capacity = Math.max(32, nextPow2(layout?.bricks.length ?? 0));

  useFrame((_, delta) => {
    const bm = brickMesh.current;
    const l = layoutRef.current;
    if (!bm || !l) return;
    const now = performance.now();
    const alpha = 1 - Math.exp(-LERP_RATE * delta);

    l.bricks.forEach((brick, i) => {
      let entry = anim.current.get(brick.id);
      if (!entry) {
        // 新文件从「上一层落下来」：压实动画因此有方向感。
        entry = { x: brick.x, y: brick.y + 1.6, w: brick.width, scale: 0.02 };
        anim.current.set(brick.id, entry);
      }
      entry.x += (brick.x - entry.x) * alpha;
      entry.y += (brick.y - entry.y) * alpha;
      entry.w += (brick.width - entry.w) * alpha;
      entry.scale += (1 - entry.scale) * alpha;

      tmpObject.position.set(entry.x, entry.y, brick.z);
      tmpObject.scale.set(entry.w, brick.height * entry.scale, brick.depth * entry.scale);
      tmpObject.updateMatrix();
      bm.setMatrixAt(i, tmpObject.matrix);

      baseColor.set(levelColor(brick.level));
      // 墓碑占比越高，颜色越往红偏 —— 一眼看出哪块「全是垃圾等着被回收」。
      if (brick.entries > 0) baseColor.lerp(tmpColor.set(PALETTE.tombstone), (brick.tombstones / brick.entries) * 0.65);
      if (brick.compacting) baseColor.lerp(tmpColor.set(PALETTE.compacting), 0.55);
      const h = highlightTracker.sst(brick.id, now);
      if (h) baseColor.lerp(tmpColor.set(HIGHLIGHT_COLOR[h[0]]), 0.3 + 0.65 * h[1]);
      if (selectedSstId === brick.id) baseColor.lerp(tmpColor.set(PALETTE.selected), 0.5);
      bm.setColorAt(i, baseColor);
    });

    tmpObject.scale.set(0, 0, 0);
    tmpObject.position.set(0, -9999, 0);
    tmpObject.updateMatrix();
    for (let i = l.bricks.length; i < bm.count; i++) bm.setMatrixAt(i, tmpObject.matrix);

    bm.instanceMatrix.needsUpdate = true;
    if (bm.instanceColor) bm.instanceColor.needsUpdate = true;
    bm.computeBoundingSphere();

    if (anim.current.size > l.bricks.length * 2 + 8) {
      const alive = new Set(l.bricks.map((b) => b.id));
      for (const k of anim.current.keys()) if (!alive.has(k)) anim.current.delete(k);
    }
    highlightTracker.prune(now);
  });

  if (!layout) return null;

  const handleClick = (e: ThreeEvent<MouseEvent>) => {
    if (e.instanceId === undefined) return;
    const brick = layoutRef.current?.bricks[e.instanceId];
    if (!brick) return;
    e.stopPropagation();
    selectSst(brick.id === selectedSstId ? null : brick.id);
  };

  return (
    <group>
      <WalStrip layout={layout} />
      <MemtableBox layout={layout} />
      <BacklogBoxes layout={layout} />

      <instancedMesh
        key={`lsm-bricks-${capacity}`}
        ref={brickMesh}
        args={[undefined, undefined, capacity]}
        onClick={handleClick}
      >
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial roughness={0.42} metalness={0.22} />
      </instancedMesh>

      {showLabels && <LevelLabels layout={layout} />}
    </group>
  );
}

/**
 * WAL 条带：画在 MemTable 正上方，因为写入的第一站就是它。
 *
 * 这里只画**仍需保留**的段 —— 数据一落成 SST，对应的段就被回收、条带随之缩短。
 * 所以条带长度直接回答了「现在崩溃的话要重放多少」。青色是正在写入的段，
 * 琥珀色是已封口、等着它那份数据落盘的段。
 */
function WalStrip({ layout }: { layout: LsmLayout }) {
  const geometry = useMemo(() => new THREE.BoxGeometry(1, 1, 1), []);
  if (layout.wal.length === 0) return null;
  return (
    <group>
      {layout.wal.map((seg) => (
        <mesh key={seg.id} geometry={geometry} position={[seg.x, seg.y, seg.z]} scale={[seg.width, seg.height, seg.depth]}>
          <meshStandardMaterial
            color={seg.sealed ? PALETTE.update : PALETTE.memtable}
            emissive={seg.sealed ? PALETTE.update : PALETTE.memtable}
            emissiveIntensity={0.18}
            roughness={0.45}
            metalness={0.2}
            transparent
            opacity={seg.records === 0 ? 0.28 : 0.92}
          />
        </mesh>
      ))}
    </group>
  );
}

/**
 * 后台任务积压：每个方块就是一个排队中的刷写/压实任务。
 * 它们堆在右侧不动，就是「压实债务」最直观的样子 —— 堆得越高，离写停顿越近。
 */
function BacklogBoxes({ layout }: { layout: LsmLayout }) {
  const geometry = useMemo(() => new THREE.BoxGeometry(1, 1, 1), []);
  const pulse = useRef<THREE.Group>(null);

  useFrame(({ clock }) => {
    if (!pulse.current) return;
    // 积压越深脉动越明显，余光里也能察觉「后台在欠债」。
    const intensity = Math.min(1, layout.bgJobs.length / 6);
    const s = 1 + Math.sin(clock.elapsedTime * 3) * 0.08 * intensity;
    pulse.current.scale.setScalar(s);
  });

  if (layout.bgJobs.length === 0) return null;
  return (
    <group ref={pulse}>
      {layout.bgJobs.map((job) => (
        <mesh
          key={job.id}
          geometry={geometry}
          position={[job.x, job.y, job.z]}
          scale={[job.size, job.size, job.size]}
        >
          <meshStandardMaterial
            color={job.kind === 'flush' ? PALETTE.memtable : PALETTE.compacting}
            emissive={job.kind === 'flush' ? PALETTE.memtable : PALETTE.compacting}
            emissiveIntensity={0.3}
            roughness={0.4}
            metalness={0.3}
          />
        </mesh>
      ))}
    </group>
  );
}

/** MemTable：内存里的有序结构，装满就整块冻结下沉。 */
function MemtableBox({ layout }: { layout: LsmLayout }) {
  const mem = layout.memtable;
  const fill = mem.limit === 0 ? 0 : Math.min(1, mem.entries / mem.limit);
  const fillRef = useRef(0);
  const bar = useRef<THREE.Mesh>(null);

  useFrame((_, delta) => {
    const alpha = 1 - Math.exp(-8 * delta);
    fillRef.current += (fill - fillRef.current) * alpha;
    if (bar.current) {
      const w = Math.max(0.001, mem.width * fillRef.current);
      bar.current.scale.set(w, mem.height * 0.55, mem.depth * 0.9);
      bar.current.position.x = -mem.width / 2 + w / 2;
      const material = bar.current.material as THREE.MeshStandardMaterial;
      material.color.set(fillRef.current > 0.85 ? PALETTE.compacting : PALETTE.memtable);
      material.emissive.copy(material.color).multiplyScalar(0.25);
    }
  });

  return (
    <group position={[mem.x, mem.y, mem.z]}>
      {/* 容器本体：即使是空的也要看得见，它是「写入先落到哪里」的锚点 */}
      <mesh>
        <boxGeometry args={[mem.width, mem.height, mem.depth]} />
        <meshStandardMaterial color={PALETTE.memtableShell} roughness={0.7} metalness={0.05} />
      </mesh>
      <lineSegments>
        <edgesGeometry args={[new THREE.BoxGeometry(mem.width, mem.height, mem.depth)]} />
        <lineBasicMaterial color={PALETTE.memtable} transparent opacity={0.7} toneMapped={false} />
      </lineSegments>
      <mesh ref={bar} position={[0, 0, 0.05]}>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial color={PALETTE.memtable} roughness={0.3} metalness={0.25} />
      </mesh>
      {/* 已冻结、排队等刷盘的 MemTable */}
      {Array.from({ length: Math.min(mem.frozen, 4) }, (_, i) => (
        <mesh key={i} position={[0, -0.32 * (i + 1), -0.5 * (i + 1)]}>
          <boxGeometry args={[mem.width * 0.96, mem.height * 0.5, mem.depth * 0.8]} />
          <meshStandardMaterial color={PALETTE.memtableFrozen} roughness={0.5} metalness={0.15} />
        </mesh>
      ))}
    </group>
  );
}

/** 每层左侧的标题：层号、文件数、条目数 / 容量。 */
function LevelLabels({ layout }: { layout: LsmLayout }) {
  const state = useLabState();
  const geometry = useMemo(() => new THREE.PlaneGeometry(1, 1), []);
  const mem = layout.memtable;
  const l = state.lsm;
  const retained = l?.wal.segments.reduce((n, seg) => n + seg.records.length, 0) ?? 0;
  const backlog = l?.bgQueue.length ?? 0;
  const stalls = l?.stalls ?? 0;

  return (
    <group>
      <mesh
        geometry={geometry}
        position={[0, mem.y + mem.height * 1.6, 0]}
        scale={[12, 1.5, 1]}
        renderOrder={2}
      >
        <meshBasicMaterial
          transparent
          depthWrite={false}
          toneMapped={false}
          map={labelTexture(
            `lsm-mem|${mem.entries}|${mem.limit}|${mem.frozen}|${retained}|${backlog}|${stalls}`,
            {
            title: `MEMTABLE ${mem.entries}/${mem.limit}${mem.frozen > 0 ? ` · 冻结 ${mem.frozen}` : ''}`,
            body: `WAL 待恢复 ${retained} 条${backlog > 0 ? ` · 后台积压 ${backlog}` : ''}${stalls > 0 ? ` · 写停顿 ${stalls}` : ''}`,
            titleColor: PALETTE.memtable,
            bodyColor: PALETTE.textSecondary,
            width: 900,
            height: 150,
            fontScale: 0.86,
            },
          )}
        />
      </mesh>

      {layout.levels.map((level) => (
        <mesh
          key={level.level}
          geometry={geometry}
          position={[layout.bounds.minX - 3.3, level.y, 0]}
          scale={[5.6, 1.1, 1]}
          renderOrder={2}
        >
          <meshBasicMaterial
            transparent
            depthWrite={false}
            toneMapped={false}
            map={labelTexture(`lsm-l${level.level}|${level.files}|${level.entries}|${level.capacity}`, {
              title: `L${level.level}`,
              body:
                level.level === 0
                  ? `${level.files} 个文件（区间重叠）`
                  : `${level.files} 个文件 · ${level.entries}/${Math.round(level.capacity)}`,
              titleColor: levelColor(level.level),
              bodyColor: PALETTE.textMuted,
              width: 520,
              height: 128,
              fontScale: 0.86,
            })}
          />
        </mesh>
      ))}

      <mesh
        geometry={geometry}
        position={[0, layout.bounds.minY - 1.1, 0]}
        scale={[14, 1.1, 1]}
        renderOrder={2}
      >
        <meshBasicMaterial
          transparent
          depthWrite={false}
          toneMapped={false}
          map={labelTexture(`lsm-axis|${layout.keyRange.min}|${layout.keyRange.max}`, {
            body: `← 键空间 ${layout.keyRange.min} … ${layout.keyRange.max} →  （砖块宽度 = 该文件覆盖的键区间）`,
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
