import { useState } from 'react';
import { ChevronDown, ChevronRight, Keyboard } from 'lucide-react';
import { PALETTE } from '@dbkl/visualization';
import { useCapability, useLabState, useSimStore } from '@/state/store';

const BTREE_LEGEND: { color: string; label: string }[] = [
  { color: PALETTE.root, label: '根页' },
  { color: PALETTE.leaf, label: '叶子页' },
  { color: PALETTE.internal, label: '内部页' },
  { color: PALETTE.dirty, label: '脏页' },
  { color: PALETTE.searchPath, label: '查找路径' },
  { color: PALETTE.split, label: '分裂/新建' },
  { color: PALETTE.remove, label: '删除/淘汰' },
  { color: PALETTE.lookup, label: '回表连线' },
];

const HEAP_LEGEND: { color: string; label: string }[] = [
  { color: PALETTE.tupleLive, label: '活元组' },
  { color: PALETTE.tupleDead, label: '死元组（等 VACUUM）' },
  { color: PALETTE.tupleRedirect, label: '重定向指针' },
  { color: PALETTE.tupleUnused, label: '空闲行指针' },
  { color: PALETTE.allVisible, label: 'all-visible 页' },
  { color: PALETTE.versionChain, label: 't_ctid 版本链' },
  { color: PALETTE.hotChain, label: 'HOT 链（不写索引）' },
  { color: PALETTE.heapFetch, label: '索引 → 堆' },
];

const LSM_LEGEND: { color: string; label: string }[] = [
  { color: PALETTE.memtable, label: 'MemTable / WAL 当前段' },
  { color: PALETTE.update, label: 'WAL 已封口段（待落盘）' },
  { color: PALETTE.memtableFrozen, label: '已冻结待刷盘' },
  { color: PALETTE.sstLevel[0], label: 'L0（区间重叠）' },
  { color: PALETTE.sstLevel[1], label: 'L1' },
  { color: PALETTE.sstLevel[2], label: 'L2+' },
  { color: PALETTE.compacting, label: '正在压实 / 压实任务积压' },
  { color: PALETTE.tombstone, label: '墓碑占比高' },
];

const COLUMNAR_LEGEND: { color: string; label: string }[] = [
  { color: PALETTE.chunkDelta, label: 'delta 编码（递增列）' },
  { color: PALETTE.chunkDictionary, label: 'dictionary 编码（低基数）' },
  { color: PALETTE.chunkRle, label: 'rle 编码（连续重复）' },
  { color: PALETTE.chunkPlain, label: 'plain（压不动）' },
  { color: PALETTE.chunkRead, label: '本次读了这一列' },
  { color: PALETTE.chunkSkipped, label: '区间统计整块跳过' },
];

const KV_LEGEND: { color: string; label: string }[] = [
  { color: PALETTE.kvBucketFilled, label: '哈希桶（高度=冲突链）' },
  { color: PALETTE.kvBucketEmpty, label: '空桶' },
  { color: PALETTE.kvRecordLive, label: '有效记录' },
  { color: PALETTE.kvRecordDead, label: '已被覆盖的垃圾' },
  { color: PALETTE.kvLogActive, label: '活动文件（可写）' },
  { color: PALETTE.kvProbe, label: '本次探测' },
];

const SHORTCUTS = [
  ['空格', '播放 / 暂停'],
  ['← →', '单步'],
  ['Shift+← →', '上/下一条命令'],
  ['1–7', '切换速度'],
  ['F / G', '飞入选中页 / 适应视图'],
  ['M', '打点'],
  ['B / L', '缓冲池 / 标签'],
];

/**
 * 3D 视口上的 2D 覆盖层。
 *
 * 它盖在主角身上，所以只留**真正随时要看**的东西：当前操作与实时读数。
 * 图例可折叠（认熟了就收起来），快捷键默认收成一个小按钮 ——
 * 它以前长期占着左下角，但绝大多数时候没人在看。
 */
export function SceneOverlay() {
  const [legendOpen, setLegendOpen] = useState(true);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const state = useLabState();
  const selectedPageId = useSimStore((s) => s.selectedPageId);
  const selectedSstId = useSimStore((s) => s.selectedSstId);
  const hasHeap = useCapability('heap');
  const hasLsm = useCapability('lsm');
  const hasBTree = useCapability('btree');
  const hasColumnar = useCapability('columnar');
  const hasKv = useCapability('kv');
  const activeCommand = state.activeCommand;
  const result = state.lastResult;
  const mv = state.mvcc;

  const legend = hasColumnar
    ? COLUMNAR_LEGEND
    : hasKv
      ? KV_LEGEND
      : hasLsm
        ? LSM_LEGEND
        : hasHeap
          ? [...HEAP_LEGEND, ...BTREE_LEGEND.slice(1, 3)]
          : BTREE_LEGEND;

  return (
    <>
      <div className="absolute left-3 top-3 flex max-w-[320px] flex-col gap-2">
        <div className="pointer-events-none rounded-md border border-ink-700 bg-ink-900/85 px-2.5 py-2 backdrop-blur">
          <div className="mb-1 text-[10px] uppercase tracking-wider text-mute-400">当前操作</div>
          <div className="num text-[12px] text-mute-200">
            {activeCommand ? activeCommand.label : '空闲'}
            {activeCommand?.running && <span className="ml-1 text-accent-400">执行中…</span>}
          </div>
          {hasBTree && state.path.length > 0 && (
            <div className="num mt-1 text-[11px] text-amber-500">路径 {state.path.map((p) => `#${p}`).join(' → ')}</div>
          )}
          {mv?.current && (
            <div className="num mt-1 text-[11px] text-violet-400">
              事务 xid={mv.current.xid}
              {mv.snapshot && ` · 快照 [${mv.snapshot.xmin}, ${mv.snapshot.xmax})`}
            </div>
          )}
          {mv?.fetch && (
            <div className="num mt-1 text-[11px] text-accent-400">
              回堆 → ({mv.fetch.tid.pageId},{mv.fetch.tid.slot})
              {mv.fetch.chainSteps > 0 && ` · 沿链 ${mv.fetch.chainSteps} 步`}
              {mv.fetch.found ? '' : ' · 无可见版本'}
            </div>
          )}
          {state.lsm?.lastGet && (
            <div className="num mt-1 text-[11px] text-teal-500">
              读放大 {state.lsm.lastGet.probes} 个 SST · 布隆跳过 {state.lsm.lastGet.bloomSkips}
            </div>
          )}
          {state.lsm && state.lsm.bgQueue.length > 0 && (
            <div className="num mt-1 text-[11px] text-orange-500">
              后台积压 {state.lsm.bgQueue.length} 个任务（刷写/压实都不在写路径上）
            </div>
          )}
          {state.columnar?.lastScan && (
            <div className="num mt-1 text-[11px] text-amber-500">
              只读 {state.columnar.lastScan.columnsRead.length} 列 · 跳过{' '}
              {state.columnar.lastScan.rowGroupsSkipped} 个行组 · {state.columnar.lastScan.bytesRead} B
            </div>
          )}
          {state.kv?.lastProbe && (
            <div className="num mt-1 text-[11px] text-amber-500">
              桶 {state.kv.lastProbe.bucket} · 链上 {state.kv.lastProbe.chainSteps} 步 ·{' '}
              {state.kv.lastProbe.found ? '一次磁盘读' : '没碰磁盘'}
            </div>
          )}
          {state.lsm?.lastStall && (
            <div className="num mt-1 max-w-[300px] text-[11px] text-red-500">⚠ 写停顿 ×{state.lsm.stalls}</div>
          )}
          {result && (
            <div className={`num mt-1 text-[11px] ${result.found ? 'text-green-500' : 'text-red-500'}`}>
              {result.found
                ? `命中 key=${result.key}${result.pageId !== null ? ` @ #${result.pageId} slot ${result.slot}` : ''}`
                : `未找到 key=${result.key}`}
            </div>
          )}
          {state.scanOutput.length > 0 && (
            <div className="num mt-1 max-w-[260px] truncate text-[11px] text-teal-500">
              扫描输出 {state.scanOutput.slice(0, 12).join(', ')}
              {state.scanOutput.length > 12 ? ' …' : ''}
            </div>
          )}
        </div>

        <div className="pointer-events-auto rounded-md border border-ink-700 bg-ink-900/85 backdrop-blur">
          <button
            className="flex w-full items-center gap-1 px-2.5 py-1.5 text-[10px] uppercase tracking-wider text-mute-400 hover:text-mute-200"
            onClick={() => setLegendOpen(!legendOpen)}
            title={legendOpen ? '收起图例' : '展开图例'}
          >
            {legendOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
            图例
            {!legendOpen && <span className="ml-1 normal-case tracking-normal text-mute-400/70">{legend.length} 项</span>}
          </button>
          {legendOpen && (
            <div className="grid grid-cols-2 gap-x-3 gap-y-1 px-2.5 pb-2">
              {legend.map((l) => (
                <div key={l.label} className="flex items-center gap-1.5 text-[11px] text-mute-300">
                  <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: l.color }} />
                  {l.label}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* 快捷键：默认收成一个小按钮。它以前长期占着左下角，但绝大多数时候没人在看。 */}
      <div className="absolute bottom-3 left-3">
        {shortcutsOpen ? (
          <div className="rounded-md border border-ink-700 bg-ink-900/85 px-2.5 py-2 backdrop-blur">
            <button
              className="mb-1 flex items-center gap-1 text-[10px] uppercase tracking-wider text-mute-400 hover:text-mute-200"
              onClick={() => setShortcutsOpen(false)}
            >
              <ChevronDown size={11} /> 快捷键
            </button>
            <div className="grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5">
              {SHORTCUTS.map(([k, v]) => (
                <div key={k} className="contents">
                  <kbd className="num text-[10px] text-accent-400">{k}</kbd>
                  <span className="text-[10px] text-mute-400">{v}</span>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <button
            className="rounded-md border border-ink-700 bg-ink-900/70 px-2 py-1.5 text-[10px] text-mute-400 backdrop-blur hover:text-mute-200"
            onClick={() => setShortcutsOpen(true)}
            title="显示快捷键"
          >
            <Keyboard size={12} />
          </button>
        )}
      </div>

      {(selectedPageId !== null || selectedSstId !== null) && (
        <div className="pointer-events-none absolute right-3 top-3 rounded-md border border-accent-500/40 bg-ink-900/85 px-2.5 py-1.5 backdrop-blur">
          <span className="num text-[11px] text-accent-400">
            {selectedSstId !== null ? `已选中 ${selectedSstId}` : `已选中页 #${selectedPageId}`}
          </span>
        </div>
      )}
    </>
  );
}
