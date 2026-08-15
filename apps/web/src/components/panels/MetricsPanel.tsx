import { formatNumber, formatPercent } from '@dbkl/shared';
import {
  bloatRatio,
  createLsmState,
  dirtyPageCount,
  hitRate,
  lsmLiveKeys,
  primaryIndex,
  secondaryIndexes,
  writeAmplification,
} from '@dbkl/simulation-core';
import { useCapability, useLabState } from '@/state/store';
import { Panel, Stat } from '@/components/ui/Panel';

/**
 * 仿真指标面板。
 *
 * 指标集合随引擎能力变化：InnoDB 看分裂与命中率，PostgreSQL 看回堆次数与膨胀率，
 * LSM 看放大三兄弟。共通的那几个（行数、逻辑读）永远在最上面，方便跨引擎横向对比。
 */
export function MetricsPanel() {
  const state = useLabState();
  const hasBufferPool = useCapability('buffer-pool');
  const hasHeap = useCapability('heap');
  const hasLsm = useCapability('lsm');
  const hasBTree = useCapability('btree');

  const m = state.metrics;
  const pages = Object.keys(state.pages).length;
  const leaves = Object.values(state.pages).filter((p) => p.type === 'leaf').length;
  const rate = hitRate(m);
  const clustered = primaryIndex(state);
  const secondaries = secondaryIndexes(state);
  const dirty = dirtyPageCount(state);
  const bloat = bloatRatio(state);
  const lsm = hasLsm ? (state.lsm ?? createLsmState(state.config.memtableLimit)) : null;
  const rows = lsm ? lsmLiveKeys(lsm).length : state.recordCount;

  return (
    <Panel title="仿真指标" subtitle="随时间轴游标实时变化">
      <div className="grid grid-cols-3 gap-1.5">
        <Stat label="行数" value={formatNumber(rows)} tone="accent" />
        {hasBTree && <Stat label="树高" value={clustered?.height ?? 0} hint="主键索引树高" />}
        {hasBTree && <Stat label="页数" value={`${pages}`} hint={`叶子 ${leaves} / 其它 ${pages - leaves}`} />}
        {lsm && (
          <>
            <Stat label="SST 文件" value={Object.keys(lsm.ssts).length} />
            <Stat label="层数" value={lsm.levels.length} />
          </>
        )}

        <Stat label="逻辑读" value={formatNumber(m.logicalReads)} hint="每次访问页计一次" />
        {hasBufferPool && (
          <>
            <Stat
              label="命中率"
              value={Number.isNaN(rate) ? '—' : formatPercent(rate, 1)}
              tone={Number.isNaN(rate) ? 'default' : rate > 0.8 ? 'good' : rate > 0.5 ? 'warn' : 'bad'}
            />
            <Stat label="淘汰" value={formatNumber(m.evictions)} tone={m.evictions > 0 ? 'warn' : 'default'} />
          </>
        )}

        {hasBTree && (
          <>
            <Stat label="叶子分裂" value={formatNumber(m.leafSplits)} tone={m.leafSplits > 0 ? 'good' : 'default'} />
            <Stat label="内部分裂" value={formatNumber(m.internalSplits)} />
            <Stat label="合并/借位" value={`${m.merges}/${m.redistributes}`} />
          </>
        )}

        {hasBufferPool && (
          <>
            <Stat label="脏页" value={`${dirty}`} tone={dirty > 0 ? 'warn' : 'good'} />
            <Stat label="刷盘" value={formatNumber(m.flushes)} />
          </>
        )}
        <Stat label="扫描行" value={formatNumber(m.scanRows)} />

        {/* —— InnoDB：回表 —— */}
        {!hasHeap && !hasLsm && (
          <>
            <Stat
              label="回表"
              value={formatNumber(m.lookups)}
              tone={m.lookups > 0 ? 'warn' : 'default'}
              hint="二级索引查询回聚簇索引取整行的次数"
            />
            <Stat
              label="二级索引"
              value={secondaries.length}
              hint={secondaries.map((s) => `${s.name}(${s.column})`).join('、') || '无'}
            />
          </>
        )}

        {/* —— PostgreSQL：回堆、版本、膨胀 —— */}
        {hasHeap && (
          <>
            <Stat
              label="回堆"
              value={formatNumber(m.heapFetches)}
              tone={m.heapFetches > 0 ? 'warn' : 'default'}
              hint="索引项 → 堆元组的跳转次数：PostgreSQL 里任何索引扫描都要付这笔钱"
            />
            <Stat
              label="版本数"
              value={formatNumber(m.versionsWritten)}
              hint="写入的元组版本总数；UPDATE 会写新版本，所以它 > 行数"
            />
            <Stat
              label="膨胀率"
              value={Number.isNaN(bloat) ? '—' : formatPercent(bloat, 0)}
              tone={bloat > 0.3 ? 'bad' : bloat > 0.1 ? 'warn' : 'good'}
            />
            <Stat label="HOT/非 HOT" value={`${m.hotUpdates}/${m.coldUpdates}`} hint="HOT 更新不写索引" />
            <Stat label="可见性判定" value={formatNumber(m.visibilityChecks)} />
            <Stat label="VACUUM 清理" value={formatNumber(m.vacuumedTuples)} />
            <Stat label="索引数" value={Object.keys(state.indexes).length} hint="PostgreSQL 里主键索引也只是一棵普通 B 树" />
          </>
        )}

        {/* —— LSM：放大三兄弟 —— */}
        {lsm && (
          <>
            <Stat label="MemTable 写入" value={formatNumber(m.memtableWrites)} />
            <Stat label="落盘条目" value={formatNumber(m.entriesWritten)} />
            <Stat
              label="总写放大"
              value={Number.isNaN(writeAmplification(lsm)) ? '—' : `${writeAmplification(lsm).toFixed(2)}×`}
              tone={writeAmplification(lsm) > 3 ? 'bad' : 'warn'}
            />
            <Stat label="刷写/压实" value={`${m.memtableFlushes}/${m.compactions}`} />
            <Stat label="读 SST" value={formatNumber(m.sstReads)} hint="读放大：真正打开过的文件数" />
            <Stat
              label="布隆跳过"
              value={formatNumber(m.bloomSkips)}
              tone={m.bloomSkips > 0 ? 'good' : 'default'}
              hint="布隆过滤器判定「一定不存在」而省掉的文件读"
            />
            <Stat
              label="后台积压"
              value={formatNumber(lsm.bgQueue.length)}
              tone={lsm.bgQueue.length > 3 ? 'bad' : lsm.bgQueue.length > 0 ? 'warn' : 'good'}
              hint="排队等着刷写 / 压实的任务数 —— 压实债务"
            />
            <Stat
              label="写停顿"
              value={formatNumber(lsm.stalls)}
              tone={lsm.stalls > 0 ? 'bad' : 'good'}
              hint="写入跑赢后台压实，写路径被迫停下来等"
            />
            <Stat
              label="WAL 待恢复"
              value={formatNumber(lsm.wal.segments.reduce((n, seg) => n + seg.records.length, 0))}
              hint="还没落成 SST、崩溃后要靠重放救回来的条数"
            />
          </>
        )}
      </div>
      <p className="mt-2 text-[10.5px] leading-relaxed text-mute-400/80">
        指标由事件流归约得出：把时间轴拖到任意时刻，这里显示的就是那一刻的历史值，而不是最终值。
      </p>
    </Panel>
  );
}
