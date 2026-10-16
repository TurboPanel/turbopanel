/**
 * Series comparison for the privilege catalogue. A series is the operator-facing
 * version (`18`, `9.7`, `12.3`); parts compare as numbers.
 */

function parts(series: string): number[] {
  return series.split('.').map((part) => Number.parseInt(part, 10))
}

/** Negative when `a` is older than `b`, zero when equal, positive when newer. */
export function compareSeries(a: string, b: string): number {
  const left = parts(a)
  const right = parts(b)
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/** Whether an entry with these bounds exists in `series`. */
export function existsInSeries(
  bounds: { since?: string; removedIn?: string },
  series: string
): boolean {
  if (bounds.since !== undefined && compareSeries(series, bounds.since) < 0) return false
  if (bounds.removedIn !== undefined && compareSeries(series, bounds.removedIn) >= 0) return false
  return true
}
