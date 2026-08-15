import { useState } from 'react';
import { Database, Layers, Pencil, Search, Trash2, Zap } from 'lucide-react';
import { bumpRow, type Command } from '@dbkl/simulation-core';
import { useCapability, useLabState, useSimStore } from '@/state/store';
import { Field, Panel } from '@/components/ui/Panel';

/** 批量插入的上限：再大就该用「导入轨迹」而不是现场仿真了。 */
const MAX_BULK = 5000;

/**
 * 操作面板。
 *
 * 三个引擎吃同一套命令，但**同一条命令在它们内部发生的事完全不同**：
 * 一条 UPDATE 在 InnoDB 里是就地改叶子记录，在 PostgreSQL 里是写新版本 + 打 xmax，
 * 在 LSM 里则只是往 MemTable 里再追加一条。这正是并排对比的价值。
 */
export function OperationsPanel() {
  const state = useLabState();
  const run = useSimStore((s) => s.run);
  const busy = useSimStore((s) => s.busy);
  const hasLsm = useCapability('lsm');
  const hasBufferPool = useCapability('buffer-pool');
  const hasHeap = useCapability('heap');

  const [key, setKey] = useState(42);
  const [bulkCount, setBulkCount] = useState(20);
  const [pattern, setPattern] = useState<'sequential' | 'random' | 'reverse'>('sequential');
  const [from, setFrom] = useState(10);
  const [to, setTo] = useState(30);
  /** 「再更新一次」的代数：每点一次就写出一个新版本，方便看版本链 / LSM 的多版本覆盖。 */
  const [generation, setGeneration] = useState(1);

  const exec = (command: Command) => void run(command);

  const doUpdate = () => {
    const schema = state.schema;
    if (!schema) return;
    exec({ kind: 'update', key, row: bumpRow(schema, key, generation) });
    setGeneration(generation + 1);
  };

  return (
    <Panel title="操作" subtitle="每个操作都会在 Worker 中生成事件流">
      <div className="flex flex-col gap-3">
        {/* 键单独一行、四个动作排成 2×2：挤在一行里时窄侧栏会把标签压成竖排。 */}
        <Field label="主键 key">
          <input className="dbkl-input" type="number" value={key} onChange={(e) => setKey(Number(e.target.value))} />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <button
            className="dbkl-btn dbkl-btn-primary"
            data-testid="op-insert"
            disabled={busy}
            onClick={() => exec({ kind: 'insert', key })}
          >
            <Database size={13} /> 插入
          </button>
          <button
            className="dbkl-btn"
            data-testid="op-update"
            disabled={busy || !state.schema}
            onClick={doUpdate}
            title={
              hasHeap
                ? '写一个新版本并给旧版本打 xmax（满足条件时走 HOT）'
                : hasLsm
                  ? '往 MemTable 再追加一条同键记录，旧版本仍留在下层文件里'
                  : '就地更新聚簇索引叶子里的记录'
            }
          >
            <Pencil size={13} /> 更新
          </button>
          <button
            className="dbkl-btn"
            data-testid="op-search"
            disabled={busy}
            onClick={() => exec({ kind: 'search', key })}
          >
            <Search size={13} /> 点查
          </button>
          <button
            className="dbkl-btn"
            data-testid="op-delete"
            disabled={busy}
            onClick={() => exec({ kind: 'delete', key })}
          >
            <Trash2 size={13} /> 删除
          </button>
        </div>

        <div className="grid grid-cols-[1fr_1fr_auto] items-end gap-2">
          <Field label="批量插入" hint={`≤ ${MAX_BULK}`}>
            <input
              className="dbkl-input"
              type="number"
              min={1}
              max={MAX_BULK}
              value={bulkCount}
              onChange={(e) => setBulkCount(Math.min(MAX_BULK, Math.max(1, Number(e.target.value))))}
            />
          </Field>
          <Field label="模式">
            <select className="dbkl-input" value={pattern} onChange={(e) => setPattern(e.target.value as typeof pattern)}>
              <option value="sequential">递增</option>
              <option value="random">随机</option>
              <option value="reverse">递减</option>
            </select>
          </Field>
          <button
            className="dbkl-btn dbkl-btn-primary"
            disabled={busy}
            onClick={() => exec({ kind: 'bulk_insert', count: bulkCount, pattern })}
          >
            <Zap size={13} /> 执行
          </button>
        </div>

        <div className="grid grid-cols-[1fr_1fr_auto] items-end gap-2">
          <Field label="范围扫描 from">
            <input className="dbkl-input" type="number" value={from} onChange={(e) => setFrom(Number(e.target.value))} />
          </Field>
          <Field label="to">
            <input className="dbkl-input" type="number" value={to} onChange={(e) => setTo(Number(e.target.value))} />
          </Field>
          <button className="dbkl-btn" data-testid="op-range" disabled={busy} onClick={() => exec({ kind: 'range_scan', from, to })}>
            扫描
          </button>
        </div>

        <div className="flex flex-wrap gap-2">
          <button className="dbkl-btn" data-testid="op-full-scan" disabled={busy} onClick={() => exec({ kind: 'full_scan' })}>
            <Layers size={13} />
            {hasHeap ? '顺序扫描（Seq Scan）' : hasLsm ? '归并全表扫描' : '全索引扫描'}
          </button>
          {hasBufferPool && (
            <button className="dbkl-btn" disabled={busy} onClick={() => exec({ kind: 'flush_all' })}>
              刷脏页
            </button>
          )}
        </div>
      </div>
    </Panel>
  );
}
