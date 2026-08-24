/**
 * Optional wire fields without one spread guard per key.
 *
 * Command payloads, prepare results and the deploy source entries are JSON
 * documents where an absent field means "nothing to say" — never `null`, never
 * `[]`. Written literally that is a `...(x === undefined ? {} : { x })` per
 * key, which is most of what made those builders unreadable.
 *
 * The return type is the input type: the caller states the shape once, and the
 * target's own optional properties absorb whatever was dropped.
 */

/** Drop keys whose value is `undefined`. */
export function definedFields<T extends Record<string, unknown>>(fields: T): T {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  ) as T
}

/**
 * Drop keys whose value is `undefined` **or an empty array**.
 *
 * The deploy payload omits an empty list rather than sending `[]`: the daemon
 * reads "absent" and "empty" the same way, and the row is smaller for it.
 */
export function presentFields<T extends Record<string, unknown>>(fields: T): T {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) =>
      value !== undefined && !(Array.isArray(value) && value.length === 0)
    ),
  ) as T
}
