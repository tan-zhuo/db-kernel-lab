import { formatBytes, formatNumber, formatPercent } from '@dbkl/shared';
import { encodingColor } from '@dbkl/visualization';
import { bytesIfRowStore, columnarIoSaved } from '@dbkl/simulation-core';
import { useLabState } from '@/state/store';
import { Panel, Stat } from '@/components/ui/Panel';

const ENCODING_HINT: Record<string, string> = {
  plain: '原样存：这一列压不动（值太散）',
  dictionary: '字典编码：不同值很少，存字典 + 每行一个小下标',
  rle: '游程编码：连续重复，只存 (值, 重复次数)',
  delta: '差值编码：严格递增（自增主键就是这样），只存首值与差值',
};

/**
 * 列存面板：压缩比、列编码、以及**本次查询到底读了多少**。
 *
 * 最值得盯的是底部那组 IO 对比：同一条查询，列存只读用到的那几列，
 * 行存要把整行所有列都拖进来 —— 分析型负载上的差距全在这里。
 */
export function ColumnarPanel() {
  const state = useLabState();
  const c = state.columnar;
  if (!c || c.rowGroups.length === 0) {
    return (
      <Panel title="列存" subtitle="按列存放 · 只读用到的列">
        <p className="text-[12px] leading-relaxed text-mute-400">
          还没有行组。列存是**攒够一批才落盘**的（默认 {state.config.rowGroupSize} 行一组），
          先批量插入一些数据，写缓冲满了就会切成列块。
        </p>
      </Panel>
    );
  }

  const ratio = c.totalEncodedBytes === 0 ? Number.NaN : c.totalRawBytes / c.totalEncodedBytes;
  const scan = c.lastScan;
  const rowStoreBytes = bytesIfRowStore(c);
  const saved = columnarIoSaved(c);

  // 按列汇总编码与压缩比（取第一个行组的编码作为代表，实际每组可能不同）
  const perColumn = c.columns.map((column) => {
    let raw = 0;
    let encoded = 0;
    const encodings = new Set<string>();
    for (const g of c.rowGroups) {
      const chunk = g.chunks[column];
      if (!chunk) continue;
      raw += chunk.rawBytes;
      encoded += chunk.encodedBytes;
      encodings.add(chunk.encoding);
    }
    return {
      column,
      raw,
      encoded,
      ratio: encoded === 0 ? 1 : raw / encoded,
      encoding: [...encodings].join('/'),
      read: scan?.columnsRead.includes(column) ?? false,
    };
  });

  return (
    <Panel title="列存" subtitle="按列存放 · 只读用到的列 · 区间统计整块跳过">
      <div className="flex flex-col gap-2.5">
        <div className="grid grid-cols-3 gap-1.5">
          <Stat label="行组" value={c.rowGroups.length} tone="accent" hint={`每组 ${state.config.rowGroupSize} 行`} />
          <Stat label="列数" value={c.columns.length} />
          <Stat
            label="压缩比"
            value={Number.isNaN(ratio) ? '—' : `${ratio.toFixed(2)}×`}
            tone={ratio > 2 ? 'good' : 'default'}
            hint="原始字节 / 编码后字节。同一列的值同质，所以压得动"
          />
          <Stat label="原始" value={formatBytes(c.totalRawBytes)} />
          <Stat label="编码后" value={formatBytes(c.totalEncodedBytes)} tone="good" />
          <Stat label="总行数" value={formatNumber(state.recordCount)} />
        </div>

        <div className="overflow-hidden rounded-md border border-ink-700">
          <table className="w-full border-collapse text-[11px]">
            <thead>
              <tr className="bg-ink-800 text-mute-400">
                <th className="px-2 py-1 text-left font-medium">列</th>
                <th className="px-2 py-1 text-left font-medium">编码</th>
                <th className="px-2 py-1 text-right font-medium">压缩比</th>
                <th className="px-2 py-1 text-right font-medium">大小</th>
              </tr>
            </thead>
            <tbody className="num">
              {perColumn.map((col) => (
                <tr
                  key={col.column}
                  className={`border-t border-ink-700/70 ${col.read ? 'bg-amber-500/10' : ''}`}
                  title={ENCODING_HINT[col.encoding] ?? ''}
                >
                  <td className="px-2 py-1">
                    <span className={col.read ? 'text-amber-500' : 'text-mute-300'}>{col.column}</span>
                    {col.read && <span className="ml-1 text-[9px] text-amber-500">本次读了</span>}
                  </td>
                  <td className="px-2 py-1">
                    <span style={{ color: encodingColor(col.encoding) }}>{col.encoding}</span>
                  </td>
                  <td className={`px-2 py-1 text-right ${col.ratio > 2 ? 'text-green-500' : 'text-mute-300'}`}>
                    {col.ratio.toFixed(2)}×
                  </td>
                  <td className="px-2 py-1 text-right text-mute-400">{formatBytes(col.encoded)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {scan && (
          <div className="rounded-md border border-ink-700 bg-ink-850/60 p-2 text-[11px]">
            <div className="mb-1 text-[10px] uppercase tracking-wide text-mute-400">本次查询的 IO 账单</div>
            <div className="flex items-baseline justify-between">
              <span className="text-mute-400">读了几列</span>
              <span className="num text-amber-500">
                {scan.columnsRead.length}/{c.columns.length}（{scan.columnsRead.join(', ') || '—'}）
              </span>
            </div>
            <div className="mt-0.5 flex items-baseline justify-between">
              <span className="text-mute-400">行组：扫描 / 跳过</span>
              <span className="num text-mute-200">
                {scan.rowGroupsScanned} / <span className="text-green-500">{scan.rowGroupsSkipped}</span>
              </span>
            </div>
            <div className="mt-0.5 flex items-baseline justify-between border-t border-ink-700 pt-1">
              <span className="text-mute-400">列存读 / 行存要读</span>
              <span className="num text-mute-200">
                {formatBytes(scan.bytesRead)} / {formatBytes(rowStoreBytes)}
              </span>
            </div>
            {!Number.isNaN(saved) && (
              <div className="mt-1 text-[10.5px] leading-relaxed text-green-500">
                省了 {formatPercent(saved, 0)} 的 IO —— 行存必须把整行所有列都拖进来，列存只碰用到的那几条竖列。
              </div>
            )}
          </div>
        )}

        <p className="text-[10.5px] leading-relaxed text-mute-400/80">
          场景里横轴是**列**、纵轴是**行组**：砖块越厚压得越狠，颜色是它选中的编码；
          查询时只有用到的列会亮成金色，被区间统计跳过的整行会塌薄变灰。
          代价也别忽略：列存**没有主键索引**，点查一行反而比 InnoDB 贵，改一行更要重写整个行组。
        </p>
      </div>
    </Panel>
  );
}
