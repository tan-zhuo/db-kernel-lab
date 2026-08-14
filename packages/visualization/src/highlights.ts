import type { PageId } from '@dbkl/shared';
import type { SimulationEvent } from '@dbkl/simulation-core';
import { HIGHLIGHT_DECAY_MS, type HighlightKind } from './palette';

export interface Highlight {
  pageId: PageId;
  /** -1 表示整页高亮。 */
  slot: number;
  kind: HighlightKind;
}

/** 一个事件应该点亮哪些页/槽位。纯函数，便于单测。 */
export function highlightsForEvent(e: SimulationEvent): Highlight[] {
  switch (e.type) {
    case 'RECORD_INSERT':
      return [{ pageId: e.pageId, slot: e.slot, kind: 'insert' }];
    case 'RECORD_UPDATE':
      return [{ pageId: e.pageId, slot: e.slot, kind: 'update' }];
    case 'RECORD_DELETE':
      return [{ pageId: e.pageId, slot: e.slot, kind: 'delete' }];
    case 'SEPARATOR_INSERT':
      return [{ pageId: e.pageId, slot: e.slot, kind: 'insert' }];
    case 'SEPARATOR_DELETE':
      return [{ pageId: e.pageId, slot: e.slot, kind: 'delete' }];
    case 'SEPARATOR_UPDATE':
      return [{ pageId: e.pageId, slot: e.slot, kind: 'update' }];
    case 'DESCEND':
      return [
        { pageId: e.pageId, slot: e.slot, kind: 'path' },
        { pageId: e.childId, slot: -1, kind: 'path' },
      ];
    case 'PAGE_READ':
      return [{ pageId: e.pageId, slot: -1, kind: 'path' }];
    case 'PAGE_SPLIT':
      return [
        { pageId: e.pageId, slot: -1, kind: 'split' },
        { pageId: e.newPageId, slot: -1, kind: 'split' },
      ];
    case 'PAGE_MERGE':
      return [
        { pageId: e.pageId, slot: -1, kind: 'merge' },
        { pageId: e.victimPageId, slot: -1, kind: 'merge' },
      ];
    case 'REDISTRIBUTE':
      return [
        { pageId: e.fromPageId, slot: -1, kind: 'merge' },
        { pageId: e.toPageId, slot: -1, kind: 'merge' },
      ];
    case 'PAGE_ALLOC':
      return [{ pageId: e.pageId, slot: -1, kind: 'alloc' }];
    case 'PAGE_FREE':
      return [{ pageId: e.pageId, slot: -1, kind: 'delete' }];
    case 'BUFFER_EVICT':
      return [{ pageId: e.pageId, slot: -1, kind: 'evict' }];
    case 'PAGE_MARK_DIRTY':
      return [{ pageId: e.pageId, slot: -1, kind: 'dirty' }];
    case 'LOOKUP_BACK':
      return [{ pageId: e.fromPageId, slot: e.fromSlot, kind: 'lookup' }];
    case 'LOOKUP_DONE':
      return e.toPageId !== null ? [{ pageId: e.toPageId, slot: e.slot, kind: 'lookup' }] : [];
    case 'SEARCH_RESULT':
      return e.found && e.pageId !== null ? [{ pageId: e.pageId, slot: e.slot, kind: 'hit' }] : [];
    case 'SCAN_STEP':
      return [{ pageId: e.pageId, slot: e.slot, kind: 'scan' }];
    default:
      return [];
  }
}

interface Entry {
  kind: HighlightKind;
  /** 触发时的墙钟时间。 */
  at: number;
  slot: number;
}

/**
 * 高亮衰减追踪器。
 *
 * 时间旅行的语义：往回拖时旧高亮立即清空（`clear()`），
 * 因为「过去的动画」不应该在回退后仍然亮着。
 */
export class HighlightTracker {
  private pages = new Map<PageId, Entry>();
  private slots = new Map<string, Entry>();

  ingest(events: readonly SimulationEvent[], now: number): void {
    for (const e of events) {
      for (const h of highlightsForEvent(e)) {
        const entry: Entry = { kind: h.kind, at: now, slot: h.slot };
        const prev = this.pages.get(h.pageId);
        // 结构性高亮优先级更高，不被后续的 path/scan 覆盖。
        if (!prev || priority(h.kind) >= priority(prev.kind) || now - prev.at > HIGHLIGHT_DECAY_MS[prev.kind]) {
          this.pages.set(h.pageId, entry);
        }
        if (h.slot >= 0) this.slots.set(`${h.pageId}:${h.slot}`, entry);
      }
    }
  }

  clear(): void {
    this.pages.clear();
    this.slots.clear();
  }

  /** 返回 [kind, 0..1 强度]，过期返回 null。 */
  page(pageId: PageId, now: number): [HighlightKind, number] | null {
    return read(this.pages.get(pageId), now);
  }

  slot(pageId: PageId, slot: number, now: number): [HighlightKind, number] | null {
    return read(this.slots.get(`${pageId}:${slot}`), now);
  }

  /** 定期清理过期项，避免长实验下 Map 无限增长。 */
  prune(now: number): void {
    for (const [k, v] of this.pages) if (now - v.at > HIGHLIGHT_DECAY_MS[v.kind]) this.pages.delete(k);
    for (const [k, v] of this.slots) if (now - v.at > HIGHLIGHT_DECAY_MS[v.kind]) this.slots.delete(k);
  }
}

function read(entry: Entry | undefined, now: number): [HighlightKind, number] | null {
  if (!entry) return null;
  const life = HIGHLIGHT_DECAY_MS[entry.kind];
  const age = now - entry.at;
  if (age >= life) return null;
  return [entry.kind, 1 - age / life];
}

function priority(kind: HighlightKind): number {
  switch (kind) {
    case 'split':
    case 'merge':
    case 'evict':
    case 'lookup':
      return 3;
    case 'insert':
    case 'delete':
    case 'update':
    case 'hit':
    case 'alloc':
      return 2;
    case 'dirty':
      return 1;
    default:
      return 0;
  }
}
