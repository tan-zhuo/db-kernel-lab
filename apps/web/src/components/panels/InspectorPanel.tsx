import { Crosshair } from 'lucide-react';
import { formatBytes, formatPercent } from '@dbkl/shared';
import { PAGE_HEADER_BYTES, estimateRecordBytes } from '@dbkl/shared';
import { pageCapacity, pageFill, pageUsedBytes } from '@dbkl/simulation-core';
import { useLabState, useSimStore } from '@/state/store';
import { Panel, Stat } from '@/components/ui/Panel';

/**
 * 页检查器：把选中页的「页头 + 槽位目录 + 行记录」摊开。
 * 这是从宏观 3D 结构下钻到页内部微观结构的入口（文档 §6.2）。
 */
export function InspectorPanel() {
  const state = useLabState();
  const selectedPageId = useSimStore((s) => s.selectedPageId);
  const focusPage = useSimStore((s) => s.focusPage);
  const page = selectedPageId !== null ? state.pages[selectedPageId] : undefined;
  const capacity = pageCapacity(state.config);

  if (!page) {
    return (
      <Panel title="页检查器" subtitle="在 3D 视图中点击任意页">
        <p className="text-[12px] leading-relaxed text-mute-400">
          未选中页。点击 3D 场景中的页盒子查看页头、槽位目录与行记录；按 <kbd className="num">F</kbd> 飞入选中页。
        </p>
      </Panel>
    );
  }

  const fill = pageFill(page, state.config);
  const used = pageUsedBytes(page, state.schema);
  const perRecord = page.type === 'leaf' ? estimateRecordBytes(state.schema) : 9;

  return (
    <Panel
      title={`页 #${page.id}`}
      subtitle={`${page.type === 'leaf' ? '叶子页（聚簇索引数据页）' : `内部页 level ${page.level}`}`}
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
          <span>{page.type === 'leaf' ? '行记录' : '分隔键条目'} × {page.keys.length}</span>
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
                  {page.type === 'leaf' ? (
                    formatRow(page.rows[i])
                  ) : (
                    <PageLink id={page.children[i + 1]} />
                  )}
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
    .map(([, v]) => String(v))
    .join(' / ');
}
