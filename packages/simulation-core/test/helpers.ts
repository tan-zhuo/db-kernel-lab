import { expect } from 'vitest';
import type { Key, PageId } from '@dbkl/shared';
import type { EngineConfig, StructuralSnapshot } from '../src';

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
 * 校验 B+ 树的全部结构不变式。任何插入/删除之后都必须成立。
 */
export function checkInvariants(
  snap: StructuralSnapshot,
  cfg: EngineConfig,
  /**
   * 是否检查「最小填充率」。
   * fillFactor ≠ 0.5 或开启顺序插入优化时，分裂会刻意造出未过半的页
   * （真实 InnoDB 同样不保证叶子页半满），此时该检查不适用。
   */
  strictMinFill = true,
): void {
  const capacity = cfg.order - 1;
  const minLeaf = Math.ceil((cfg.order - 1) / 2);
  const minInternal = Math.ceil(cfg.order / 2) - 1;

  if (snap.rootId === null) {
    expect(Object.keys(snap.pages)).toHaveLength(0);
    return;
  }

  const root = snap.pages[snap.rootId];
  expect(root, 'root page must exist').toBeTruthy();
  expect(root.parentId, 'root has no parent').toBeNull();

  const visited = new Set<PageId>();
  const leafLevels: number[] = [];
  let recordCount = 0;

  const walk = (id: PageId, lowerLimit: Key | null, upperLimit: Key | null, expectedParent: PageId | null): void => {
    expect(visited.has(id), `page #${id} reachable twice`).toBe(false);
    visited.add(id);
    const p = snap.pages[id];
    expect(p, `page #${id} exists`).toBeTruthy();
    expect(p.parentId, `page #${id} parent pointer`).toBe(expectedParent);

    // 键有序
    for (let i = 1; i < p.keys.length; i++) {
      expect(p.keys[i - 1] < p.keys[i], `page #${id} keys sorted: ${p.keys.join(',')}`).toBe(true);
    }
    // 键落在父页给定的区间内
    for (const k of p.keys) {
      if (lowerLimit !== null) expect(k >= lowerLimit, `page #${id} key ${k} >= ${lowerLimit}`).toBe(true);
      if (upperLimit !== null) expect(k < upperLimit, `page #${id} key ${k} < ${upperLimit}`).toBe(true);
    }
    expect(p.keys.length, `page #${id} not overfull`).toBeLessThanOrEqual(capacity);

    if (p.type === 'leaf') {
      leafLevels.push(p.level);
      expect(p.level, 'leaf level is 0').toBe(0);
      expect(p.rows.length, `page #${id} rows aligned with keys`).toBe(p.keys.length);
      expect(p.children.length, 'leaf has no children').toBe(0);
      if (id !== snap.rootId && strictMinFill) {
        expect(p.keys.length, `leaf #${id} respects min fill (${p.keys.length} >= ${minLeaf})`).toBeGreaterThanOrEqual(minLeaf);
      }
      recordCount += p.keys.length;
      return;
    }

    expect(p.children.length, `internal #${id}: children = keys + 1`).toBe(p.keys.length + 1);
    expect(p.children.length, `internal #${id} fanout <= order`).toBeLessThanOrEqual(cfg.order);
    if (id === snap.rootId) {
      expect(p.children.length, 'root internal has >= 2 children').toBeGreaterThanOrEqual(2);
    } else {
      expect(p.keys.length, `internal #${id} respects min keys`).toBeGreaterThanOrEqual(minInternal);
    }

    for (let i = 0; i < p.children.length; i++) {
      const lo = i === 0 ? lowerLimit : p.keys[i - 1];
      const hi = i === p.keys.length ? upperLimit : p.keys[i];
      const child = snap.pages[p.children[i]];
      expect(child, `child #${p.children[i]} of #${id} exists`).toBeTruthy();
      expect(child.level, `child level = parent level - 1`).toBe(p.level - 1);
      walk(p.children[i], lo, hi, id);
    }
  };

  walk(snap.rootId, null, null, null);

  // 所有叶子在同一层
  expect(new Set(leafLevels).size, 'all leaves at same level').toBeLessThanOrEqual(1);
  // 没有游离页
  expect(visited.size, 'no orphan pages').toBe(Object.keys(snap.pages).length);
  expect(snap.recordCount, 'recordCount matches leaves').toBe(recordCount);
  expect(snap.height, 'height matches root level').toBe(root.level + 1);

  // 叶子链表覆盖全部叶子且有序
  const chain: Key[] = [];
  let cur = snap.firstLeafId;
  const seen = new Set<PageId>();
  let leaves = 0;
  while (cur !== null) {
    expect(seen.has(cur), 'leaf chain has no cycle').toBe(false);
    seen.add(cur);
    const p = snap.pages[cur];
    expect(p, `leaf #${cur} in chain exists`).toBeTruthy();
    expect(p.type).toBe('leaf');
    chain.push(...p.keys);
    leaves++;
    if (p.next !== null) expect(snap.pages[p.next].prev, 'prev/next symmetric').toBe(cur);
    cur = p.next;
  }
  const totalLeaves = Object.values(snap.pages).filter((p) => p.type === 'leaf').length;
  expect(leaves, 'leaf chain covers every leaf').toBe(totalLeaves);
  for (let i = 1; i < chain.length; i++) {
    expect(chain[i - 1] < chain[i], `leaf chain sorted at ${i}`).toBe(true);
  }
}

export function sortedKeys(snap: StructuralSnapshot): Key[] {
  const out: Key[] = [];
  let cur = snap.firstLeafId;
  const seen = new Set<PageId>();
  while (cur !== null && !seen.has(cur)) {
    seen.add(cur);
    out.push(...snap.pages[cur].keys);
    cur = snap.pages[cur].next;
  }
  return out;
}
