/** How a server learned the control plane's key: at install, on upgrade, with the unsafe flag, or not at all. */
export const PINNED_BY_VALUES = ['install', 'upgrade', 'unsafe', 'none'] as const
export type PinnedBy = (typeof PINNED_BY_VALUES)[number]

/**
 * The pinned-by state of a server row: its `trustPinnedBy` column when the
 * row carries it and the value is known, else `none` (never reported, or a
 * read that did not select the column). This is the one place to change; the
 * admin read and the client server read model both call it.
 */
export function resolvePinnedBy(row: object): PinnedBy {
  const value = 'trustPinnedBy' in row ? row.trustPinnedBy : null
  return value === 'install' || value === 'upgrade' || value === 'unsafe' ? value : 'none'
}
