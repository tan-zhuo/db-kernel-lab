import { formatNumber, formatPercent } from '@dbkl/shared';
import { dirtyPageCount, hitRate, primaryIndex, secondaryIndexes } from '@dbkl/simulation-core';
import { useLabState } from '@/state/store';
import { Panel, Stat } from '@/components/ui/Panel';

/** 仿真指标面板：逻辑 IO、分裂次数、缓冲池命中率等（文档 §12）。 */
export function MetricsPanel() {
  const state = useLabState();
  const m = state.metrics;
  const pages = Object.keys(state.pages).length;
  const leaves = Object.values(state.pages).filter((p) => p.type === 'leaf').length;
  const rate = hitRate(m);
  const clustered = primaryIndex(state);
  const secondaries = secondaryIndexes(state);
  const dirty = dirtyPageCount(state);

  return (
    <Panel title="仿真指标" subtitle="随时间轴游标实时变化">
      <div className="grid grid-cols-3 gap-1.5">
        <Stat label="行数" value={formatNumber(state.recordCount)} tone="accent" />
        <Stat label="树高" value={clustered?.height ?? 0} hint="聚簇索引树高" />
        <Stat label="页数" value={`${pages}`} hint={`叶子 ${leaves} / 内部 ${pages - leaves}`} />

        <Stat label="逻辑读" value={formatNumber(m.logicalReads)} hint="每次访问页计一次" />
        <Stat
          label="命中率"
          value={Number.isNaN(rate) ? '—' : formatPercent(rate, 1)}
          tone={Number.isNaN(rate) ? 'default' : rate > 0.8 ? 'good' : rate > 0.5 ? 'warn' : 'bad'}
        />
        <Stat label="淘汰" value={formatNumber(m.evictions)} tone={m.evictions > 0 ? 'warn' : 'default'} />

        <Stat label="叶子分裂" value={formatNumber(m.leafSplits)} tone={m.leafSplits > 0 ? 'good' : 'default'} />
        <Stat label="内部分裂" value={formatNumber(m.internalSplits)} />
        <Stat label="合并/借位" value={`${m.merges}/${m.redistributes}`} />

        <Stat label="脏页" value={`${dirty}`} tone={dirty > 0 ? 'warn' : 'good'} />
        <Stat label="刷盘" value={formatNumber(m.flushes)} />
        <Stat label="扫描行" value={formatNumber(m.scanRows)} />
        <Stat label="回表" value={formatNumber(m.lookups)} tone={m.lookups > 0 ? 'warn' : 'default'} hint="二级索引查询回聚簇索引取整行的次数" />
        <Stat label="二级索引" value={secondaries.length} hint={secondaries.map((s) => `${s.name}(${s.column})`).join('、') || '无'} />
      </div>
      <p className="mt-2 text-[10.5px] leading-relaxed text-mute-400/80">
        指标由事件流归约得出：把时间轴拖到任意时刻，这里显示的就是那一刻的历史值，而不是最终值。
      </p>
    </Panel>
  );
}
