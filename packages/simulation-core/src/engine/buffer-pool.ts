import type { PageId } from '@dbkl/shared';
import type { SimulationEventBody } from '../events';
import type { EngineConfig } from './types';

export interface BufferPoolHooks {
  emit(body: SimulationEventBody): void;
  isDirty(pageId: PageId): boolean;
  /** 页被刷盘后清理引擎侧的脏标记。 */
  onFlushed(pageId: PageId): void;
  /** 页是否仍然存在（被 free 的页不应再参与淘汰统计）。 */
  exists(pageId: PageId): boolean;
}

/**
 * Buffer Pool 仿真（LRU / CLOCK）。
 *
 * 简化点（Phase 0）：
 *  - 没有 pin/unpin，因此正在被修改的页也可能被淘汰。这不影响正确性
 *    （「磁盘」就是引擎内存中的页表），但与真实 InnoDB 不同，已在
 *    docs/architecture.md 的差异表中标注；Phase 1 引入 pin 计数。
 *  - 淘汰脏页会先产生 PAGE_FLUSH 事件，模拟同步刷盘。
 */
export class BufferPool {
  private frames: (PageId | null)[];
  /** LRU 栈：下标 0 最近使用。 */
  private recency: PageId[] = [];
  private refBits = new Map<PageId, boolean>();
  private hand = 0;

  constructor(
    private config: EngineConfig,
    private readonly hooks: BufferPoolHooks,
  ) {
    this.frames = new Array<PageId | null>(Math.max(1, config.bufferPoolFrames)).fill(null);
  }

  reconfigure(config: EngineConfig): void {
    this.config = config;
    if (this.frames.length !== config.bufferPoolFrames) {
      this.frames = new Array<PageId | null>(Math.max(1, config.bufferPoolFrames)).fill(null);
      this.recency = [];
      this.refBits.clear();
      this.hand = 0;
    }
  }

  /** 逻辑访问一个页；产生 BUFFER_HIT 或 (BUFFER_EVICT +) BUFFER_MISS。 */
  access(pageId: PageId): void {
    const existing = this.frames.indexOf(pageId);
    if (existing >= 0) {
      this.markRecent(pageId);
      this.hooks.emit({ type: 'BUFFER_HIT', pageId, frame: existing });
      return;
    }

    let frame = this.frames.indexOf(null);
    if (frame < 0) frame = this.evict();
    this.frames[frame] = pageId;
    this.markRecent(pageId);
    this.hooks.emit({ type: 'BUFFER_MISS', pageId, frame });
  }

  /** 页被回收时从缓冲池摘除（不计入淘汰指标）。 */
  forget(pageId: PageId): void {
    const idx = this.frames.indexOf(pageId);
    if (idx >= 0) this.frames[idx] = null;
    this.refBits.delete(pageId);
    const r = this.recency.indexOf(pageId);
    if (r >= 0) this.recency.splice(r, 1);
  }

  flushAll(reason: 'checkpoint' | 'manual'): number {
    let n = 0;
    for (const pageId of this.frames) {
      if (pageId === null || !this.hooks.exists(pageId)) continue;
      if (this.hooks.isDirty(pageId)) {
        this.hooks.emit({ type: 'PAGE_FLUSH', pageId, reason });
        this.hooks.onFlushed(pageId);
        n++;
      }
    }
    return n;
  }

  residentPages(): PageId[] {
    return this.frames.filter((p): p is PageId => p !== null);
  }

  snapshotFrames(): (PageId | null)[] {
    return this.frames.slice();
  }

  snapshotRecency(): PageId[] {
    return this.recency.slice();
  }

  private evict(): number {
    const frame = this.config.evictionPolicy === 'CLOCK' ? this.pickClockVictim() : this.pickLruVictim();
    const victim = this.frames[frame];
    if (victim !== null) {
      const dirty = this.hooks.exists(victim) && this.hooks.isDirty(victim);
      if (dirty) {
        this.hooks.emit({ type: 'PAGE_FLUSH', pageId: victim, reason: 'evict' });
        this.hooks.onFlushed(victim);
      }
      this.hooks.emit({
        type: 'BUFFER_EVICT',
        pageId: victim,
        frame,
        reason: this.config.evictionPolicy,
        wasDirty: dirty,
      });
      this.frames[frame] = null;
      this.refBits.delete(victim);
      const r = this.recency.indexOf(victim);
      if (r >= 0) this.recency.splice(r, 1);
    }
    return frame;
  }

  private pickLruVictim(): number {
    for (let i = this.recency.length - 1; i >= 0; i--) {
      const frame = this.frames.indexOf(this.recency[i]);
      if (frame >= 0) return frame;
    }
    return 0;
  }

  private pickClockVictim(): number {
    const n = this.frames.length;
    for (let step = 0; step < n * 2; step++) {
      const frame = this.hand;
      this.hand = (this.hand + 1) % n;
      const pageId = this.frames[frame];
      if (pageId === null) return frame;
      if (this.refBits.get(pageId)) {
        this.refBits.set(pageId, false);
        continue;
      }
      return frame;
    }
    return this.hand;
  }

  private markRecent(pageId: PageId): void {
    const i = this.recency.indexOf(pageId);
    if (i >= 0) this.recency.splice(i, 1);
    this.recency.unshift(pageId);
    this.refBits.set(pageId, true);
    const frame = this.frames.indexOf(pageId);
    if (frame >= 0) this.hand = (frame + 1) % this.frames.length;
  }
}
