import { useState } from 'react';
import { Plus, Table2, Trash2 } from 'lucide-react';
import type { ColumnDef, ColumnType, TableSchema } from '@dbkl/shared';
import { DEFAULT_SCHEMA } from '@dbkl/simulation-core';
import { estimateRecordBytes, formatBytes } from '@dbkl/shared';
import { useLabState, useSimStore } from '@/state/store';
import { Field, Panel } from '@/components/ui/Panel';

const TYPES: ColumnType[] = ['int', 'bigint', 'varchar', 'bool', 'timestamp'];

/**
 * CREATE TABLE 表单。
 *
 * 改表结构等于重建整棵聚簇索引，所以这里直接走「重置 + 建表」——
 * 与真实系统里 ALTER TABLE 需要重建表空间是同一个道理（Phase 2 会做在线 DDL 过程动画）。
 */
export function SchemaPanel() {
  const state = useLabState();
  const busy = useSimStore((s) => s.busy);
  const resetEngine = useSimStore((s) => s.resetEngine);
  const current = state.schema ?? DEFAULT_SCHEMA;

  const [draft, setDraft] = useState<TableSchema>(current);
  const rowBytes = estimateRecordBytes(draft);

  const setColumn = (i: number, patch: Partial<ColumnDef>) => {
    const columns = draft.columns.map((c, idx) => (idx === i ? { ...c, ...patch } : c));
    setDraft({ ...draft, columns });
  };

  const removeColumn = (i: number) => {
    const removed = draft.columns[i];
    const columns = draft.columns.filter((_, idx) => idx !== i);
    setDraft({
      ...draft,
      columns,
      primaryKey: removed.name === draft.primaryKey ? (columns[0]?.name ?? '') : draft.primaryKey,
    });
  };

  const addColumn = () => {
    const name = `col${draft.columns.length + 1}`;
    setDraft({ ...draft, columns: [...draft.columns, { name, type: 'int' }] });
  };

  const pkColumn = draft.columns.find((c) => c.name === draft.primaryKey);
  const pkIsNumeric = pkColumn ? pkColumn.type !== 'varchar' : false;
  const valid =
    draft.name.trim().length > 0 &&
    draft.columns.length > 0 &&
    new Set(draft.columns.map((c) => c.name)).size === draft.columns.length &&
    draft.columns.every((c) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(c.name)) &&
    pkIsNumeric;

  return (
    <Panel
      title="表结构"
      subtitle={`${current.name}(${current.columns.length} 列) · 行约 ${formatBytes(estimateRecordBytes(current))}`}
      collapsible
      defaultOpen={false}
    >
      <div className="flex flex-col gap-2">
        <div className="grid grid-cols-[1fr_1fr] gap-2">
          <Field label="表名">
            <input
              data-testid="schema-name"
              className="dbkl-input"
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </Field>
          <Field label="主键列" hint={pkIsNumeric ? '' : '必须是数值列'}>
            <select
              className="dbkl-input"
              value={draft.primaryKey}
              onChange={(e) => setDraft({ ...draft, primaryKey: e.target.value })}
            >
              {draft.columns.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <ul className="flex flex-col gap-1">
          {draft.columns.map((c, i) => (
            <li key={i} className="grid grid-cols-[1fr_84px_60px_auto] items-center gap-1.5">
              <input
                className="dbkl-input"
                value={c.name}
                onChange={(e) => setColumn(i, { name: e.target.value })}
                aria-label={`列 ${i + 1} 名称`}
              />
              <select
                className="dbkl-input"
                value={c.type}
                onChange={(e) => setColumn(i, { type: e.target.value as ColumnType })}
                aria-label={`列 ${i + 1} 类型`}
              >
                {TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
              <input
                className="dbkl-input"
                type="number"
                min={1}
                max={255}
                value={c.length ?? 32}
                disabled={c.type !== 'varchar'}
                onChange={(e) => setColumn(i, { length: Number(e.target.value) })}
                aria-label={`列 ${i + 1} 长度`}
              />
              <button
                className="dbkl-btn"
                disabled={draft.columns.length <= 1}
                onClick={() => removeColumn(i)}
                title="删除列"
              >
                <Trash2 size={12} />
              </button>
            </li>
          ))}
        </ul>

        <div className="flex items-center justify-between gap-2">
          <button className="dbkl-btn" onClick={addColumn}>
            <Plus size={13} /> 添加列
          </button>
          <span className="num text-[10.5px] text-mute-400">估算行长 {formatBytes(rowBytes)}</span>
        </div>

        <button
          data-testid="create-table"
          className="dbkl-btn dbkl-btn-primary"
          disabled={busy || !valid}
          onClick={() => void resetEngine(undefined, draft)}
          title={valid ? '重建表（会清空当前实验）' : '表名/列名不合法，或主键不是数值列'}
        >
          <Table2 size={13} /> CREATE TABLE（重置实验）
        </button>
        <p className="text-[10px] leading-relaxed text-mute-400/80">
          Phase 1 的主键与索引键都必须是数值列；varchar 列可以存在，但不能作为主键或索引键
          （字符串键需要通用比较器，排在 Phase 2）。
        </p>
      </div>
    </Panel>
  );
}
