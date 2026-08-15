import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { PALETTE, encodingColor, layoutColumnar, type ColumnarLayout } from '@dbkl/visualization';
import { labelTexture } from '@/lib/label-texture';
import { useLabState, useSimStore, useThemeVersion } from '@/state/store';

const LERP_RATE = 8;

const tmpObject = new THREE.Object3D();
const tmpColor = new THREE.Color();
const baseColor = new THREE.Color();

/**
 * 列存视图 —— 一张正对镜头的矩阵：**横轴是列，纵轴是行组**。
 *
 * 于是列存那句核心的话不用背，直接看：
 *
 *  - 查询只读用到的列 ⇒ 矩阵上只有几条**竖列**亮起来（金色），其余整片压暗；
 *  - 区间统计整块跳过 ⇒ 对应的**整行**塌薄变灰，一个字节都没读；
 *  - 砖块**越厚压得越狠**（厚度 ∝ 压缩比），颜色是它选中的编码方式。
 *
 * 把它和 InnoDB 的 B+ 树并排看：那边一次查询要把整行所有列都拖进内存，
 * 这边只碰用到的那一竖条。
 */
export function ColumnarView() {
  const state = useLabState();
  const showLabels = useSimStore((s) => s.showLabels);
  useThemeVersion();

  const layout = useMemo(() => {
    if (!state.columnar) return null;
    return layoutColumnar(state.columnar);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, state.appliedSeq]);

  const mesh = useRef<THREE.InstancedMesh>(null);
  const layoutRef = useRef<ColumnarLayout | null>(layout);
  layoutRef.current = layout;
  const anim = useRef(new Map<string, { h: number; scale: number }>());

  const capacity = Math.max(64, nextPow2(layout?.chunks.length ?? 0));

  useFrame((_, delta) => {
    const m = mesh.current;
    const l = layoutRef.current;
    if (!m || !l) return;
    const alpha = 1 - Math.exp(-LERP_RATE * delta);

    l.chunks.forEach((chunk, i) => {
      const key = `${chunk.rowGroupId}.${chunk.column}`;
      let entry = anim.current.get(key);
      if (!entry) {
        entry = { h: 0.02, scale: 0.02 };
        anim.current.set(key, entry);
      }
      // 被跳过的行组整体**塌薄**下去 —— 视觉上就是「这块我一个字节都没读」。
      const targetDepth = chunk.skipped ? 0.12 : chunk.depth;
      entry.h += (targetDepth - entry.h) * alpha;
      entry.scale += (1 - entry.scale) * alpha;

      tmpObject.position.set(chunk.x, chunk.y, entry.h / 2);
      tmpObject.scale.set(chunk.width * entry.scale, chunk.height * entry.scale, Math.max(0.05, entry.h));
      tmpObject.updateMatrix();
      m.setMatrixAt(i, tmpObject.matrix);

      if (chunk.skipped) {
        baseColor.set(PALETTE.chunkSkipped);
      } else {
        baseColor.set(encodingColor(chunk.encoding));
        // 本次查询真的读了它 ⇒ 点亮；没读的压暗但仍看得见（矩阵结构不能糊掉）。
        if (chunk.read) baseColor.lerp(tmpColor.set(PALETTE.chunkRead), 0.6);
        else baseColor.lerp(tmpColor.set(PALETTE.background), 0.45);
      }
      m.setColorAt(i, baseColor);
    });

    tmpObject.scale.set(0, 0, 0);
    tmpObject.position.set(0, -9999, 0);
    tmpObject.updateMatrix();
    for (let i = l.chunks.length; i < m.count; i++) m.setMatrixAt(i, tmpObject.matrix);

    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
    m.computeBoundingSphere();

    if (anim.current.size > l.chunks.length * 2 + 8) {
      const alive = new Set(l.chunks.map((c) => `${c.rowGroupId}.${c.column}`));
      for (const k of anim.current.keys()) if (!alive.has(k)) anim.current.delete(k);
    }
  });

  if (!layout || layout.chunks.length === 0) return null;

  return (
    <group>
      <instancedMesh key={`col-chunks-${capacity}`} ref={mesh} args={[undefined, undefined, capacity]}>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial roughness={0.45} metalness={0.2} />
      </instancedMesh>
      {showLabels && <ColumnarLabels layout={layout} />}
    </group>
  );
}

/** 列标题（横轴）+ 行组标签（纵轴）+ 一行 IO 账单。 */
function ColumnarLabels({ layout }: { layout: ColumnarLayout }) {
  const state = useLabState();
  const geometry = useMemo(() => new THREE.PlaneGeometry(1, 1), []);
  const scan = state.columnar?.lastScan;
  const encodings = new Map<string, string>();
  for (const c of layout.chunks) encodings.set(c.column, c.encoding);

  return (
    <group>
      {/* 列标题：被读到的列高亮 */}
      {layout.columns.map((col) => (
        <mesh
          key={col.column}
          geometry={geometry}
          position={[col.x, 1.35, 1.6]}
          scale={[2.3, 0.72, 1]}
          renderOrder={2}
        >
          <meshBasicMaterial
            transparent
            depthWrite={false}
            toneMapped={false}
            map={labelTexture(`col-${col.column}|${col.read}|${encodings.get(col.column) ?? ''}`, {
              title: col.column,
              body: encodings.get(col.column) ?? '',
              titleColor: col.read ? PALETTE.chunkRead : PALETTE.textMuted,
              bodyColor: col.read ? PALETTE.textPrimary : PALETTE.textMuted,
              width: 420,
              height: 130,
              fontScale: 0.86,
            })}
          />
        </mesh>
      ))}

      {/* 行组标签：被跳过的标出来 */}
      {layout.rowGroups.map((rg) => (
        <mesh
          key={rg.id}
          geometry={geometry}
          position={[rg.labelX, rg.y, 1.6]}
          scale={[3.6, 0.66, 1]}
          renderOrder={2}
        >
          <meshBasicMaterial
            transparent
            depthWrite={false}
            toneMapped={false}
            map={labelTexture(`rg-${rg.id}|${rg.rows}|${rg.skipped}`, {
              body: `${rg.id} · ${rg.rows} 行${rg.skipped ? ' · 已跳过' : ''}`,
              bodyColor: rg.skipped ? PALETTE.textMuted : PALETTE.textSecondary,
              width: 460,
              height: 84,
              fontScale: 0.8,
            })}
          />
        </mesh>
      ))}

      {/* IO 账单：列存的卖点就在这一行数字上 */}
      <mesh
        geometry={geometry}
        position={[0, 2.6, 1.6]}
        scale={[14, 1.4, 1]}
        renderOrder={2}
      >
        <meshBasicMaterial
          transparent
          depthWrite={false}
          toneMapped={false}
          map={labelTexture(
            `col-title|${scan?.columnsRead.length ?? 0}|${scan?.bytesRead ?? 0}|${scan?.rowGroupsSkipped ?? 0}`,
            {
              title: `列存 · ${layout.columns.length} 列 × ${layout.rowGroups.length} 个行组`,
              body: scan
                ? `本次只读 ${scan.columnsRead.length} 列 / ${scan.bytesRead} B · 跳过 ${scan.rowGroupsSkipped} 个行组`
                : '砖块越厚压得越狠；查询时只有用到的列会亮起来',
              titleColor: PALETTE.chunkDelta,
              bodyColor: PALETTE.textSecondary,
              width: 1000,
              height: 150,
              fontScale: 0.86,
            },
          )}
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
