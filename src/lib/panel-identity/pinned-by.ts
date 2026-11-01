/** How a server learned the control plane's key: at install, on upgrade, with the unsafe flag, or not at all. */
export const PINNED_BY_VALUES = ['install', 'upgrade', 'unsafe', 'none'] as const
export type PinnedBy = (typeof PINNED_BY_VALUES)[number]

/**
 * The pinned-by state of a server row.
 *
 * The server table does not record a pin yet, so every server reads as `none`.
 * This is the one place to change; the admin read and the client server read
 * model both call it.
 */
export function resolvePinnedBy(_row: object): PinnedBy {
  return 'none'
}
