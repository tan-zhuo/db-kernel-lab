import { Crosshair } from 'lucide-react';
import { formatBytes, formatPercent, formatTid } from '@dbkl/shared';
import { PAGE_HEADER_BYTES, estimateRecordBytes } from '@dbkl/shared';
import { pageCapacity, pageFill, pageUsedBytes, type HeapTupleState, type SstState } from '@dbkl/simulation-core';
import { useLabState, useSimStore } from '@/state/store';
import { Panel, Stat } from '@/components/ui/Panel';

/**
 * 检查器：把选中对象的内部结构摊开。
 *
 * 三种对象各有各的「内部」：
 *  - B+ 树页 → 页头 + 槽位目录 + 记录；
 *  - 堆页 → 行指针数组 + 每个元组的 (xmin, xmax, t_ctid)；
 *  - SST 文件 → 键区间 + 条目列表（哪些是墓碑）。
 */
export function InspectorPanel() {
  const state = useLabState();
  const selectedPageId = useSimStore((s) => s.selectedPageId);
  const selectedSstId = useSimStore((s) => s.selectedSstId);
  const page = selectedPageId !== null ? state.pages[selectedPageId] : undefined;
  const sst = selectedSstId !== null ? state.lsm?.ssts[selectedSstId] : undefined;

  if (sst) return <SstInspector sst={sst} />;
  if (page?.type === 'heap') return <HeapInspector pageId={page.id} />;
  if (page) return <TreePageInspector pageId={page.id} />;

  return (
    <Panel title="检查器" subtitle="在 3D 视图中点击任意对象">
      <p className="text-[12px] leading-relaxed text-mute-400">
        未选中对象。点击 3D 场景里的页 / 堆页 / SST 砖块，这里会展开它的内部结构；
        按 <kbd className="num">F</kbd> 飞入选中页。
      </p>
    </Panel>
  );
}

/** B+ 树页：页头开销、槽位目录、记录 / 子指针。 */
function TreePageInspector({ pageId }: { pageId: number }) {
  const state = useLabState();
  const focusPage = useSimStore((s) => s.focusPage);
  const page = state.pages[pageId]!;
  const capacity = pageCapacity(state.config);
  const fill = pageFill(page, state.config);
  const used = pageUsedBytes(page, state.schema);
  const perRecord = page.type === 'leaf' ? estimateRecordBytes(state.schema) : 9;
  const index = state.indexes[page.indexId];

  return (
    <Panel
      title={`页 #${page.id}`}
      subtitle={
        page.type === 'leaf'
          ? `叶子页 · ${index?.clustered ? '聚簇索引数据页' : `索引 ${index?.name ?? page.indexId}`}`
          : `内部页 level ${page.level}`
      }
      right={
        <button className="dbkl-btn" onClick={() => focusPage(page.id)}>
          <Crosshair size={13} /> 飞入
        </button>
      }
    >
      <div className="grid grid-cols-3 gap-1.5">
        <Stat label="槽位" value={`${page.keys.length}/${capacity}`} tone={fill > 0.9 ? 'warn' : 'default'} />
        <Stat label="填充率" value={formatPercent(fill, 0)} tone={fill > 0.9 ? 'warn' : 'good'} />
        <Stat label="状态" value={page.dirty ? '脏页' : '干净'} tone={page.dirty ? 'warn' : 'good'} />
        <Stat label="驻留" value={page.resident ? `frame ${page.frame}` : '已淘汰'} tone={page.resident ? 'accent' : 'bad'} />
        <Stat label="LSN" value={page.lsn} hint="简化模型：最后修改事件的序号" />
        <Stat label="父页" value={page.parentId === null ? 'ROOT' : `#${page.parentId}`} />
      </div>

      <div className="mt-2 rounded-md border border-ink-700 bg-ink-850/60 p-2 text-[11px] text-mute-400">
        <div className="mb-1 flex justify-between">
          <span>页头开销</span>
          <span className="num">{formatBytes(PAGE_HEADER_BYTES)}</span>
        </div>
        <div className="mb-1 flex justify-between">
          <span>
            {page.type === 'leaf' ? '行记录' : '分隔键条目'} × {page.keys.length}
          </span>
          <span className="num">{formatBytes(perRecord * page.keys.length)}</span>
        </div>
        <div className="flex justify-between border-t border-ink-700 pt-1 text-mute-300">
          <span>页内已用 / 页大小</span>
          <span className="num">
            {formatBytes(used)} / {formatBytes(state.config.pageSize)}
          </span>
        </div>
        {page.type === 'leaf' && (
          <div className="mt-1 flex justify-between">
            <span>叶子链表</span>
            <span className="num">
              {page.prev === null ? '∅' : `#${page.prev}`} ← → {page.next === null ? '∅' : `#${page.next}`}
            </span>
          </div>
        )}
      </div>

      <div className="mt-2 overflow-hidden rounded-md border border-ink-700">
        <table className="w-full border-collapse text-[11px]">
          <thead>
            <tr className="bg-ink-800 text-mute-400">
              <th className="px-2 py-1 text-left font-medium">slot</th>
              <th className="px-2 py-1 text-left font-medium">key</th>
              <th className="px-2 py-1 text-left font-medium">{page.type === 'leaf' ? 'row' : 'child'}</th>
            </tr>
          </thead>
          <tbody className="num">
            {page.type === 'internal' && (
              <tr className="border-t border-ink-700/70 text-mute-300">
                <td className="px-2 py-1 text-mute-400">—</td>
                <td className="px-2 py-1 text-mute-400">(-∞)</td>
                <td className="px-2 py-1">
                  <PageLink id={page.children[0]} />
                </td>
              </tr>
            )}
            {page.keys.map((key, i) => (
              <tr key={i} className="border-t border-ink-700/70">
                <td className="px-2 py-1 text-mute-400">{i}</td>
                <td className="px-2 py-1 text-accent-400">{key}</td>
                <td className="max-w-[190px] truncate px-2 py-1 text-mute-300">
                  {page.type === 'leaf' ? formatRow(page.rows[i]) : <PageLink id={page.children[i + 1]} />}
                </td>
              </tr>
            ))}
            {page.keys.length === 0 && (
              <tr>
                <td className="px-2 py-2 text-mute-400" colSpan={3}>
                  空页
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

/**
 * 堆页检查器：把 PostgreSQL 元组头摊开。
 *
 * `xmin` / `xmax` 决定这一版对谁可见，`t_ctid` 指向下一版 —— 这三列合起来就是版本链。
 * 「HOT」列标出哪些版本没有自己的索引项（读的时候要沿链走才能找到它们）。
 */
function HeapInspector({ pageId }: { pageId: number }) {
  const state = useLabState();
  const focusPage = useSimStore((s) => s.focusPage);
  const page = state.pages[pageId]!;
  const heap = page.heap!;
  const used = heap.tuples.filter((t) => t.lp !== 'unused').length;
  const dead = heap.tuples.filter((t) => t.lp === 'normal' && t.xmax !== null).length;

  return (
    <Panel
      title={`堆页 #${page.id}`}
      subtitle={`块号 ${heap.blockNo} · ${used}/${heap.slots} 个行指针在用`}
      right={
        <button className="dbkl-btn" onClick={() => focusPage(page.id)}>
          <Crosshair size={13} /> 飞入
        </button>
      }
    >
      <div className="grid grid-cols-3 gap-1.5">
        <Stat label="行指针" value={`${used}/${heap.slots}`} tone={heap.freeSlots === 0 ? 'warn' : 'default'} />
        <Stat label="死元组" value={dead} tone={dead > 0 ? 'warn' : 'good'} hint="等 VACUUM 回收" />
        <Stat
          label="可见性映射"
          value={heap.allVisible ? 'all-visible' : '未标记'}
          tone={heap.allVisible ? 'good' : 'default'}
          hint="all-visible 的页可以被 Index Only Scan 跳过"
        />
        <Stat label="状态" value={page.dirty ? '脏页' : '干净'} tone={page.dirty ? 'warn' : 'good'} />
        <Stat label="驻留" value={page.resident ? `frame ${page.frame}` : '已淘汰'} tone={page.resident ? 'accent' : 'bad'} />
        <Stat label="LSN" value={page.lsn} />
      </div>

      <div className="mt-2 overflow-hidden rounded-md border border-ink-700">
        <table className="w-full border-collapse text-[11px]">
          <thead>
            <tr className="bg-ink-800 text-mute-400">
              <th className="px-2 py-1 text-left font-medium">lp</th>
              <th className="px-2 py-1 text-left font-medium">key</th>
              <th className="px-2 py-1 text-right font-medium">xmin</th>
              <th className="px-2 py-1 text-right font-medium">xmax</th>
              <th className="px-2 py-1 text-left font-medium">t_ctid</th>
            </tr>
          </thead>
          <tbody className="num">
            {heap.tuples.map((t, i) => (
              <tr key={i} className={`border-t border-ink-700/70 ${tupleRowClass(t)}`}>
                <td className="px-2 py-1">
                  {i}
                  <span className="ml-1 text-[9.5px] text-mute-400">{LP_LABEL[t.lp]}</span>
                </td>
                <td className="px-2 py-1 text-accent-400">{Number.isNaN(t.key) ? '—' : t.key}</td>
                <td className="px-2 py-1 text-right text-mute-300">{t.lp === 'unused' ? '—' : t.xmin}</td>
                <td className={`px-2 py-1 text-right ${t.xmax !== null ? 'text-red-500' : 'text-mute-400'}`}>
                  {t.lp === 'unused' ? '—' : (t.xmax ?? '∅')}
                </td>
                <td className="px-2 py-1 text-mute-400">
                  {t.lp === 'redirect' ? `→ lp ${t.redirectTo}` : formatTid(t.next)}
                  {t.hot && <span className="ml-1 text-green-500">HOT</span>}
                </td>
              </tr>
            ))}
            {heap.tuples.length === 0 && (
              <tr>
                <td className="px-2 py-2 text-mute-400" colSpan={5}>
                  空页
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="mt-2 text-[10.5px] leading-relaxed text-mute-400/80">
        xmin = 插入它的事务，xmax = 删除/更新它的事务。读的时候拿快照跟这两个数比一比，就知道这一版对你可不可见。
        t_ctid 指向下一个版本，一串就是版本链；标了 HOT 的版本没有自己的索引项。
      </p>
    </Panel>
  );
}

/** SST 检查器：键区间、条目、墓碑占比。 */
function SstInspector({ sst }: { sst: SstState }) {
  const selectSst = useSimStore((s) => s.selectSst);
  const tombstones = sst.entries.filter((e) => e.tombstone).length;

  return (
    <Panel
      title={`${sst.id} @ L${sst.level}`}
      subtitle={`${sst.source === 'flush' ? 'MemTable 刷写产生' : '压实产生'} · ${sst.entries.length} 条`}
      right={
        <button className="dbkl-btn" onClick={() => selectSst(null)}>
          取消选中
        </button>
      }
    >
      <div className="grid grid-cols-3 gap-1.5">
        <Stat label="条目" value={sst.entries.length} tone="accent" />
        <Stat label="墓碑" value={tombstones} tone={tombstones > 0 ? 'warn' : 'good'} />
        <Stat label="大小" value={formatBytes(sst.bytes)} />
        <Stat label="最小键" value={sst.minKey} />
        <Stat label="最大键" value={sst.maxKey} />
        <Stat label="层" value={`L${sst.level}`} />
      </div>

      <div className="mt-2 overflow-hidden rounded-md border border-ink-700">
        <div className="bg-ink-800 px-2 py-1 text-[10px] uppercase tracking-wide text-mute-400">
          条目（最多显示 60 条）
        </div>
        <div className="num flex max-h-[180px] flex-wrap gap-1 overflow-y-auto p-2">
          {sst.entries.slice(0, 60).map((e, i) => (
            <span
              key={i}
              className={`rounded px-1 py-[1px] text-[10px] ${
                e.tombstone ? 'bg-red-500/15 text-red-500' : 'bg-ink-700 text-mute-300'
              }`}
              title={e.tombstone ? '墓碑：这个键被删除了，等压实到最底层才会真正消失' : undefined}
            >
              {e.key}
              {e.tombstone ? ' ✗' : ''}
            </span>
          ))}
        </div>
      </div>

      <p className="mt-2 text-[10.5px] leading-relaxed text-mute-400/80">
        SST 一旦写出就永不修改。「更新」这个键只会在更上层出现一条新记录，
        下层的旧值要等压实把它们归并掉才会消失 —— 这就是空间放大。
      </p>
    </Panel>
  );
}

const LP_LABEL: Record<string, string> = {
  normal: '',
  redirect: 'redirect',
  dead: 'dead',
  unused: 'unused',
};

function tupleRowClass(t: HeapTupleState): string {
  if (t.lp === 'unused') return 'text-mute-400/60';
  if (t.lp === 'redirect') return 'bg-amber-500/8';
  if (t.xmax !== null) return 'bg-red-500/8';
  return '';
}

function PageLink({ id }: { id: number | undefined }) {
  const select = useSimStore((s) => s.select);
  if (id === undefined) return <span className="text-mute-400">—</span>;
  return (
    <button className="text-violet-400 hover:underline" onClick={() => select(id)}>
      #{id}
    </button>
  );
}

function formatRow(row: Record<string, unknown> | null): string {
  if (!row) return '—';
  return Object.entries(row)
    .slice(1)
    .map(([k, v]) => (k === 'ctid' ? formatTid(unpack(Number(v))) : String(v)))
    .join(' / ');
}

/** 索引项里的 ctid 是打包过的整数，展示时还原成 (页,槽)。 */
function unpack(packed: number): { pageId: number; slot: number } | null {
  if (!Number.isFinite(packed) || packed < 0) return null;
  return { pageId: Math.floor(packed / 4096), slot: packed % 4096 };
}
