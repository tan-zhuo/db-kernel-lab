export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[dbkl] invariant violated: ${message}`);
}

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

/** 在有序数组中找到第一个 >= key 的下标（lower bound）。 */
export function lowerBound(keys: readonly number[], key: number): number {
  let lo = 0;
  let hi = keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (keys[mid] < key) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** 在有序数组中找到第一个 > key 的下标（upper bound）。 */
export function upperBound(keys: readonly number[], key: number): number {
  let lo = 0;
  let hi = keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (keys[mid] <= key) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function formatPercent(v: number, digits = 1): string {
  if (!Number.isFinite(v)) return '—';
  return `${(v * 100).toFixed(digits)}%`;
}

export function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}
