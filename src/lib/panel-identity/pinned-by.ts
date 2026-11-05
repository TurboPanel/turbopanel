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

/** What a server's last signed pin report said, as the server read model shows it. */
export type PinReportView = {
  /** The control plane key fingerprint its pin file holds; "" when nothing is pinned. */
  fingerprint: string
  keyset: number | null
  reportedAt: string | null
  /** Whether that key was this control plane's current or next key when reported. */
  matches: boolean
}

/**
 * The pin report columns of a server row, or null when no signed report has
 * arrived (an older daemon) or the read did not select them.
 */
export function resolvePinReport(row: object): PinReportView | null {
  const r = row as {
    trustPinFingerprint?: string | null
    trustPinKeyset?: number | null
    trustPinReportedAt?: Date | string | null
    isTrustPinMatching?: boolean | null
  }
  if (typeof r.trustPinFingerprint !== 'string' || typeof r.isTrustPinMatching !== 'boolean') {
    return null
  }
  const at = r.trustPinReportedAt
  return {
    fingerprint: r.trustPinFingerprint,
    keyset: r.trustPinKeyset ?? null,
    reportedAt: at instanceof Date ? at.toISOString() : (at ?? null),
    matches: r.isTrustPinMatching,
  }
}
