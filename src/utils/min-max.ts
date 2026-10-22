/** Min/max without argument spread: Math.min(...arr) throws RangeError above ~120k elements. */
export function minOf(values: Iterable<number>): number {
  let m = Infinity;
  for (const v of values) if (v < m) m = v;
  return m;
}

export function maxOf(values: Iterable<number>): number {
  let m = -Infinity;
  for (const v of values) if (v > m) m = v;
  return m;
}
