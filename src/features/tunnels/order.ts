/**
 * Fixed text order for tables and lists that feed a hash or are compared: plain
 * code-point order, the same on every runtime whatever its locale.
 */
export function compareText(a: string, b: string): number {
  if (a < b) return -1
  return a > b ? 1 : 0
}
