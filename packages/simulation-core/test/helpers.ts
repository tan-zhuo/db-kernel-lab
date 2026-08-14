import { expect } from 'vitest';
import type { Key, PageId } from '@dbkl/shared';
import { PRIMARY_INDEX_ID, type EngineConfig, type StructuralIndex, type StructuralSnapshot } from '../src';

export function config(patch: Partial<EngineConfig> = {}): EngineConfig {
  return {
    order: 4,
    pageSize: 16384,
    bufferPoolFrames: 8,
    evictionPolicy: 'LRU',
    fillFactor: 0.5,
    sequentialInsertOptimization: false,
    seed: 42,
    ...patch,
  };
}

/**
 * 校验所有索引树的结构不变式。任何插入/删除之后都必须成立。
 *
 * `strictMinFill`：fillFactor ≠ 0.5 或开启顺序插入优化时，分裂会刻意造出未过半的页
 * （真实 InnoDB 同样不保证叶子页半满），此时最小填充率检查不适用。
 */
export function checkInvariants(snap: StructuralSnapshot, cfg: EngineConfig, strictMinFill = true): void {
  let visitedTotal = 0;
  for (const ix of Object.values(snap.indexes)) {
    visitedTotal += checkIndex(snap, ix, cfg, strictMinFill);
  }
  // 没有游离页：所有页都必须能从某棵索引的根页到达
  expect(visitedTotal, 'no orphan pages').toBe(Object.keys(snap.pages).length);
}

function checkIndex(snap: StructuralSnapshot, ix: StructuralIndex, cfg: EngineConfig, strictMinFill: boolean): number {
  const capacity = cfg.order - 1;
  const minLeaf = Math.ceil((cfg.order - 1) / 2);
  const minInternal = Math.ceil(cfg.order / 2) - 1;
  const label = `[${ix.id}]`;

  expect(ix.rootId, `${label} root exists`).not.toBeNull();
  const root = snap.pages[ix.rootId!];
  expect(root, `${label} root page must exist`).toBeTruthy();
  expect(root.parentId, `${label} root has no parent`).toBeNull();

  const visited = new Set<PageId>();
  const leafLevels: number[] = [];
  let entries = 0;

  const walk = (id: PageId, lowerLimit: Key | null, upperLimit: Key | null, expectedParent: PageId | null): void => {
    expect(visited.has(id), `${label} page #${id} reachable twice`).toBe(false);
    visited.add(id);
    const p = snap.pages[id];
    expect(p, `${label} page #${id} exists`).toBeTruthy();
    expect(p.indexId, `${label} page #${id} belongs to this index`).toBe(ix.id);
    expect(p.parentId, `${label} page #${id} parent pointer`).toBe(expectedParent);

    // 键有序：唯一索引严格递增，允许重复键的二级索引非递减
    for (let i = 1; i < p.keys.length; i++) {
      const ok = ix.unique ? p.keys[i - 1] < p.keys[i] : p.keys[i - 1] <= p.keys[i];
      expect(ok, `${label} page #${id} keys sorted: ${p.keys.join(',')}`).toBe(true);
    }
    // 键落在父页给定的区间内（重复键树里分隔键可能与左页末键相等）
    for (const k of p.keys) {
      if (lowerLimit !== null) expect(k >= lowerLimit, `${label} #${id} key ${k} >= ${lowerLimit}`).toBe(true);
      if (upperLimit !== null) {
        const ok = ix.unique ? k < upperLimit : k <= upperLimit;
        expect(ok, `${label} #${id} key ${k} <= ${upperLimit}`).toBe(true);
      }
    }
    expect(p.keys.length, `${label} page #${id} not overfull`).toBeLessThanOrEqual(capacity);

    if (p.type === 'leaf') {
      leafLevels.push(p.level);
      expect(p.level, `${label} leaf level is 0`).toBe(0);
      expect(p.rows.length, `${label} page #${id} rows aligned with keys`).toBe(p.keys.length);
      expect(p.children.length, `${label} leaf has no children`).toBe(0);
      if (id !== ix.rootId && strictMinFill) {
        expect(p.keys.length, `${label} leaf #${id} respects min fill`).toBeGreaterThanOrEqual(minLeaf);
      }
      entries += p.keys.length;
      return;
    }

    expect(p.children.length, `${label} internal #${id}: children = keys + 1`).toBe(p.keys.length + 1);
    expect(p.children.length, `${label} internal #${id} fanout <= order`).toBeLessThanOrEqual(cfg.order);
    if (id === ix.rootId) {
      expect(p.children.length, `${label} root internal has >= 2 children`).toBeGreaterThanOrEqual(2);
    } else {
      expect(p.keys.length, `${label} internal #${id} respects min keys`).toBeGreaterThanOrEqual(minInternal);
    }

    for (let i = 0; i < p.children.length; i++) {
      const lo = i === 0 ? lowerLimit : p.keys[i - 1];
      const hi = i === p.keys.length ? upperLimit : p.keys[i];
      const child = snap.pages[p.children[i]];
      expect(child, `${label} child #${p.children[i]} of #${id} exists`).toBeTruthy();
      expect(child.level, `${label} child level = parent level - 1`).toBe(p.level - 1);
      walk(p.children[i], lo, hi, id);
    }
  };

  walk(ix.rootId!, null, null, null);

  expect(new Set(leafLevels).size, `${label} all leaves at same level`).toBeLessThanOrEqual(1);
  expect(ix.entries, `${label} entry count matches leaves`).toBe(entries);
  expect(ix.height, `${label} height matches root level`).toBe(root.level + 1);
  if (ix.clustered) expect(snap.recordCount, 'recordCount == clustered entries').toBe(entries);

  // 叶子链表覆盖该索引的全部叶子且有序
  const chain: Key[] = [];
  let cur = ix.firstLeafId;
  const seen = new Set<PageId>();
  let leaves = 0;
  while (cur !== null) {
    expect(seen.has(cur), `${label} leaf chain has no cycle`).toBe(false);
    seen.add(cur);
    const p = snap.pages[cur];
    expect(p, `${label} leaf #${cur} in chain exists`).toBeTruthy();
    expect(p.type).toBe('leaf');
    expect(p.indexId).toBe(ix.id);
    chain.push(...p.keys);
    leaves++;
    if (p.next !== null) expect(snap.pages[p.next].prev, `${label} prev/next symmetric`).toBe(cur);
    cur = p.next;
  }
  const totalLeaves = Object.values(snap.pages).filter((p) => p.type === 'leaf' && p.indexId === ix.id).length;
  expect(leaves, `${label} leaf chain covers every leaf`).toBe(totalLeaves);
  for (let i = 1; i < chain.length; i++) {
    const ok = ix.unique ? chain[i - 1] < chain[i] : chain[i - 1] <= chain[i];
    expect(ok, `${label} leaf chain sorted at ${i}`).toBe(true);
  }

  return visited.size;
}

/** 某棵索引按叶子链表顺序的全部键。 */
export function sortedKeys(snap: StructuralSnapshot, indexId = PRIMARY_INDEX_ID): Key[] {
  const out: Key[] = [];
  let cur = snap.indexes[indexId]?.firstLeafId ?? null;
  const seen = new Set<PageId>();
  while (cur !== null && !seen.has(cur)) {
    seen.add(cur);
    out.push(...snap.pages[cur].keys);
    cur = snap.pages[cur].next;
  }
  return out;
}

/** 某棵索引按叶子链表顺序的全部 (键, 主键) 对。 */
export function sortedEntries(snap: StructuralSnapshot, indexId: string, primaryKeyColumn = 'id'): [Key, Key][] {
  const out: [Key, Key][] = [];
  let cur = snap.indexes[indexId]?.firstLeafId ?? null;
  const seen = new Set<PageId>();
  while (cur !== null && !seen.has(cur)) {
    seen.add(cur);
    const p = snap.pages[cur];
    p.keys.forEach((k, i) => out.push([k, Number(p.rows[i]?.[primaryKeyColumn] ?? -1)]));
    cur = p.next;
  }
  return out;
}

export function primary(snap: StructuralSnapshot): StructuralIndex {
  return snap.indexes[PRIMARY_INDEX_ID];
}
