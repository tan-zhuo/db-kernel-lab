import { useMemo, useState } from 'react';
import { Play } from 'lucide-react';
import { orderedIndexes, predicateToSql, type Predicate } from '@dbkl/simulation-core';
import { useLabState, useSimStore } from '@/state/store';
import { Field, Panel } from '@/components/ui/Panel';

type Op = 'eq' | 'range' | 'all';

/**
 * 查询构造器：产出一条 `query` 命令，交给引擎里的优化器决定走索引还是全表扫描。
 * 「投影列」与「索引提示」是两个最重要的实验旋钮：
 * 前者决定能否用覆盖索引，后者用来强行对比不同方案的代价。
 */
export function QueryPanel() {
  const state = useLabState();
  const run = useSimStore((s) => s.run);
  const busy = useSimStore((s) => s.busy);

  const columns = state.schema?.columns ?? [];
  const numericColumns = columns.filter((c) => c.type !== 'varchar');
  const indexes = orderedIndexes(state);

  const [op, setOp] = useState<Op>('eq');
  const [column, setColumn] = useState(numericColumns[0]?.name ?? 'id');
  const [value, setValue] = useState(42);
  const [from, setFrom] = useState(10);
  const [to, setTo] = useState(20);
  const [covering, setCovering] = useState(false);
  const [hint, setHint] = useState('auto');

  const activeColumn = numericColumns.some((c) => c.name === column) ? column : (numericColumns[0]?.name ?? 'id');

  const predicate = useMemo<Predicate>(() => {
    if (op === 'all') return { kind: 'all' };
    if (op === 'eq') return { kind: 'eq', column: activeColumn, value };
    return { kind: 'range', column: activeColumn, from, to };
  }, [op, activeColumn, value, from, to]);

  const projection: string[] | '*' = covering
    ? [activeColumn, state.schema?.primaryKey ?? 'id']
    : '*';

  const sql = predicateToSql(predicate, state.schema?.name ?? 'users', projection);

  return (
    <Panel title="查询" subtitle="优化器会在全表扫描与索引之间选择">
      <div className="flex flex-col gap-2">
        <div className="grid grid-cols-[1fr_1fr] gap-2">
          <Field label="条件">
            <select data-testid="q-op" className="dbkl-input" value={op} onChange={(e) => setOp(e.target.value as Op)}>
              <option value="eq">等值 =</option>
              <option value="range">范围 BETWEEN</option>
              <option value="all">无条件（全表）</option>
            </select>
          </Field>
          <Field label="列">
            <select
              data-testid="q-column"
              className="dbkl-input"
              value={activeColumn}
              disabled={op === 'all'}
              onChange={(e) => setColumn(e.target.value)}
            >
              {numericColumns.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
        </div>

        {op === 'eq' && (
          <Field label="值">
            <input
              data-testid="q-value"
              className="dbkl-input"
              type="number"
              value={value}
              onChange={(e) => setValue(Number(e.target.value))}
            />
          </Field>
        )}
        {op === 'range' && (
          <div className="grid grid-cols-2 gap-2">
            <Field label="from">
              <input className="dbkl-input" type="number" value={from} onChange={(e) => setFrom(Number(e.target.value))} />
            </Field>
            <Field label="to">
              <input className="dbkl-input" type="number" value={to} onChange={(e) => setTo(Number(e.target.value))} />
            </Field>
          </div>
        )}

        <div className="grid grid-cols-[1fr_1fr] gap-2">
          <Field label="索引提示">
            <select data-testid="q-hint" className="dbkl-input" value={hint} onChange={(e) => setHint(e.target.value)}>
              <option value="auto">自动（按代价）</option>
              <option value="none">强制全表扫描</option>
              {indexes.map((ix) => (
                <option key={ix.id} value={ix.id}>
                  强制 {ix.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="投影列" hint={covering ? '可能覆盖索引' : '需要整行'}>
            <select
              data-testid="q-projection"
              className="dbkl-input"
              value={covering ? 'covering' : 'all'}
              onChange={(e) => setCovering(e.target.value === 'covering')}
            >
              <option value="all">SELECT *（要回表）</option>
              <option value="covering">仅索引列 + 主键</option>
            </select>
          </Field>
        </div>

        <code className="num block truncate rounded border border-ink-700 bg-ink-950 px-2 py-1.5 text-[11px] text-teal-500" title={sql}>
          {sql}
        </code>

        <button
          data-testid="q-run"
          className="dbkl-btn dbkl-btn-primary"
          disabled={busy || !state.schema}
          onClick={() => void run({ kind: 'query', predicate, columns: projection, hint })}
        >
          <Play size={13} /> 执行查询
        </button>
      </div>
    </Panel>
  );
}
