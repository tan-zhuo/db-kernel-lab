import { useState } from 'react';
import { Database, Layers, Search, Trash2, Zap } from 'lucide-react';
import type { Command } from '@dbkl/simulation-core';
import { useSimStore } from '@/state/store';
import { Field, Panel } from '@/components/ui/Panel';

/** 批量插入的上限：再大就该用「导入轨迹」而不是现场仿真了。 */
const MAX_BULK = 5000;

export function OperationsPanel() {
  const run = useSimStore((s) => s.run);
  const busy = useSimStore((s) => s.busy);
  const [key, setKey] = useState(42);
  const [bulkCount, setBulkCount] = useState(20);
  const [pattern, setPattern] = useState<'sequential' | 'random' | 'reverse'>('sequential');
  const [from, setFrom] = useState(10);
  const [to, setTo] = useState(30);

  const exec = (command: Command) => void run(command);

  return (
    <Panel title="操作" subtitle="每个操作都会在 Worker 中生成事件流">
      <div className="flex flex-col gap-3">
        <div className="flex items-end gap-2">
          <Field label="主键 key">
            <input
              className="dbkl-input"
              type="number"
              value={key}
              onChange={(e) => setKey(Number(e.target.value))}
            />
          </Field>
          <button className="dbkl-btn dbkl-btn-primary" disabled={busy} onClick={() => exec({ kind: 'insert', key })}>
            <Database size={13} /> 插入
          </button>
          <button className="dbkl-btn" disabled={busy} onClick={() => exec({ kind: 'search', key })}>
            <Search size={13} /> 点查
          </button>
          <button className="dbkl-btn" disabled={busy} onClick={() => exec({ kind: 'delete', key })}>
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
            <select
              className="dbkl-input"
              value={pattern}
              onChange={(e) => setPattern(e.target.value as typeof pattern)}
            >
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
          <button className="dbkl-btn" disabled={busy} onClick={() => exec({ kind: 'range_scan', from, to })}>
            扫描
          </button>
        </div>

        <div className="flex flex-wrap gap-2">
          <button className="dbkl-btn" disabled={busy} onClick={() => exec({ kind: 'full_scan' })}>
            <Layers size={13} /> 全索引扫描
          </button>
          <button className="dbkl-btn" disabled={busy} onClick={() => exec({ kind: 'flush_all' })}>
            刷脏页
          </button>
        </div>
      </div>
    </Panel>
  );
}
