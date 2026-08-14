import { useRef } from 'react';
import * as THREE from 'three';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import {
  DEFAULT_LAYOUT,
  HIGHLIGHT_COLOR,
  PALETTE,
  slotOffsetX,
  type LayoutNode,
  type TreeLayout,
} from '@dbkl/visualization';
import { pageCapacity } from '@dbkl/simulation-core';
import { highlightTracker, useLabState, useSimStore } from '@/state/store';
import { PageLabels } from './PageLabels';
import { TreeEdges } from './TreeEdges';
import { IndexTitles, LookupArc } from './SceneAnnotations';

const SLOT_HEIGHT = 0.26;
const SLOT_GAP = 0.06;
/** 位置插值速度：越大越「硬」，越小越飘。 */
const LERP_RATE = 9;

interface AnimEntry {
  x: number;
  y: number;
  z: number;
  scale: number;
}

const tmpObject = new THREE.Object3D();
const tmpColor = new THREE.Color();
const baseColor = new THREE.Color();

/**
 * B+ 树主视图。
 *
 * 性能约定（文档 §7）：
 *  - 所有页盒子共用一个 InstancedMesh，所有槽位共用另一个；
 *    页数上千也只有 2 个 draw call。
 *  - 位置每帧插值，因此页分裂时兄弟页会「被推开」，而不是瞬移。
 *  - 文字标签只在页数不多时渲染（贴图有缓存与 LRU 上限）。
 */
export function BTreeView({ layout }: { layout: TreeLayout }) {
  const state = useLabState();
  const selectedPageId = useSimStore((s) => s.selectedPageId);
  const showLabels = useSimStore((s) => s.showLabels);
  const select = useSimStore((s) => s.select);

  const capacity = pageCapacity(state.config);

  const pageMesh = useRef<THREE.InstancedMesh>(null);
  const slotMesh = useRef<THREE.InstancedMesh>(null);
  const anim = useRef(new Map<number, AnimEntry>());
  const nodesRef = useRef<LayoutNode[]>(layout.nodes);
  nodesRef.current = layout.nodes;

  // 实例容量：按需扩张（避免每帧重建 InstancedMesh）。
  const pageCapacityHint = Math.max(64, nextPow2(layout.nodes.length));
  const slotCapacityHint = Math.max(256, nextPow2(layout.nodes.length * capacity));

  useFrame((_, delta) => {
    const pm = pageMesh.current;
    const sm = slotMesh.current;
    if (!pm || !sm) return;

    const now = performance.now();
    const alpha = 1 - Math.exp(-LERP_RATE * delta);
    const nodes = nodesRef.current;
    const map = anim.current;

    let slotIndex = 0;
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      let entry = map.get(node.id);
      if (!entry) {
        // 新页：从父页位置「长」出来，制造分裂/新建的动画。
        const parent = node.parentId !== null ? map.get(node.parentId) : undefined;
        entry = { x: parent?.x ?? node.x, y: parent?.y ?? node.y, z: node.z, scale: 0.01 };
        map.set(node.id, entry);
      }
      entry.x += (node.x - entry.x) * alpha;
      entry.y += (node.y - entry.y) * alpha;
      entry.z += (node.z - entry.z) * alpha;
      entry.scale += (1 - entry.scale) * alpha;

      const page = state.pages[node.id];
      const highlight = highlightTracker.page(node.id, now);
      const isSelected = selectedPageId === node.id;

      // 页体
      tmpObject.position.set(entry.x, entry.y, entry.z);
      tmpObject.scale.set(node.width * entry.scale, node.height * entry.scale, node.depth * entry.scale);
      tmpObject.rotation.set(0, 0, 0);
      tmpObject.updateMatrix();
      pm.setMatrixAt(i, tmpObject.matrix);

      baseColor.set(node.isRoot ? PALETTE.root : node.type === 'leaf' ? PALETTE.leaf : PALETTE.internal);
      if (page?.dirty) baseColor.lerp(tmpColor.set(PALETTE.dirty), 0.45);
      if (!page?.resident) baseColor.multiplyScalar(0.45);
      if (highlight) baseColor.lerp(tmpColor.set(HIGHLIGHT_COLOR[highlight[0]]), 0.25 + 0.65 * highlight[1]);
      if (isSelected) baseColor.lerp(tmpColor.set(PALETTE.selected), 0.5);
      pm.setColorAt(i, baseColor);

      // 槽位
      for (let slot = 0; slot < capacity; slot++, slotIndex++) {
        const filled = slot < node.used;
        const sh = highlightTracker.slot(node.id, slot, now);
        tmpObject.position.set(
          entry.x + slotOffsetX(slot, capacity) * entry.scale,
          entry.y + (node.height / 2 + SLOT_HEIGHT / 2) * entry.scale,
          entry.z,
        );
        const grow = filled ? 1 : 0.55;
        tmpObject.scale.set(
          (DEFAULT_LAYOUT.slotWidth - SLOT_GAP) * entry.scale,
          SLOT_HEIGHT * grow * entry.scale,
          (node.depth - 0.24) * entry.scale,
        );
        tmpObject.updateMatrix();
        sm.setMatrixAt(slotIndex, tmpObject.matrix);

        baseColor.set(
          filled ? (node.type === 'leaf' ? PALETTE.slotFilled : PALETTE.slotFilledInternal) : PALETTE.slotEmpty,
        );
        if (sh) baseColor.lerp(tmpColor.set(HIGHLIGHT_COLOR[sh[0]]), 0.3 + 0.7 * sh[1]);
        sm.setColorAt(slotIndex, baseColor);
      }
    }

    // 隐藏多余实例（缩到 0）。
    tmpObject.scale.set(0, 0, 0);
    tmpObject.position.set(0, -9999, 0);
    tmpObject.updateMatrix();
    for (let i = nodes.length; i < pm.count; i++) pm.setMatrixAt(i, tmpObject.matrix);
    for (let i = slotIndex; i < sm.count; i++) sm.setMatrixAt(i, tmpObject.matrix);

    pm.instanceMatrix.needsUpdate = true;
    sm.instanceMatrix.needsUpdate = true;
    if (pm.instanceColor) pm.instanceColor.needsUpdate = true;
    if (sm.instanceColor) sm.instanceColor.needsUpdate = true;
    pm.computeBoundingSphere();

    // 定期清理过期高亮 + 已消失页的动画状态。
    if (map.size > nodes.length * 2) {
      const alive = new Set(nodes.map((n) => n.id));
      for (const id of map.keys()) if (!alive.has(id)) map.delete(id);
    }
    highlightTracker.prune(now);
  });

  const handleClick = (e: ThreeEvent<MouseEvent>) => {
    if (e.instanceId === undefined) return;
    const node = nodesRef.current[e.instanceId];
    if (!node) return;
    e.stopPropagation();
    select(node.id === selectedPageId ? null : node.id);
  };

  return (
    <group>
      <instancedMesh
        key={`pages-${pageCapacityHint}`}
        ref={pageMesh}
        args={[undefined, undefined, pageCapacityHint]}
        onClick={handleClick}
        castShadow={false}
        receiveShadow={false}
      >
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial roughness={0.55} metalness={0.15} />
      </instancedMesh>

      <instancedMesh key={`slots-${slotCapacityHint}`} ref={slotMesh} args={[undefined, undefined, slotCapacityHint]}>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial roughness={0.35} metalness={0.25} />
      </instancedMesh>

      <TreeEdges layout={layout} anim={anim} />
      <LookupArc anim={anim} />
      {showLabels && (
        <>
          <PageLabels layout={layout} anim={anim} />
          <IndexTitles layout={layout} />
        </>
      )}
    </group>
  );
}

function nextPow2(n: number): number {
  let v = 1;
  while (v < n) v *= 2;
  return v;
}
