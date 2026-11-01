/**
 * Public origins of the control plane, built from hostname rows.
 *
 * A stored hostname is the dial the panel listens on (`:8443`). What visitors
 * type is the row's public port: 443 when an edge or tunnel answers there,
 * 8443 otherwise. Links, passkey origins, webhook URLs and install commands
 * use the public origin; Caddy and certificates keep the dial. Rows arrive in
 * creation order, so "oldest" is the first row. Pure: no I/O, safe on Workers.
 */

import { DEFAULT_PUBLIC_PORT, isPublicPort } from './ingress-modes.ts'
import {
  formatHostForUrl,
  hostFromPublicUrlEntry,
  publicUrlEntryToInstallOrigin,
} from './public-urls.ts'

export type PublicOriginRow = {
  host: string
  publicPort?: number
  isPrimary?: boolean
  isDaemonDial?: boolean
}

/** `https://host` when the public port is 443, else `https://host:<port>`. Null for an unusable host. */
export function publicOriginForHostname(row: PublicOriginRow): string | null {
  const bare = hostFromPublicUrlEntry(row.host)
  if (!bare) return null
  const port = isPublicPort(row.publicPort) ? row.publicPort : DEFAULT_PUBLIC_PORT
  return `https://${formatHostForUrl(bare, port === 443 ? undefined : String(port))}`
}

/** The primary row, else the oldest. Null when there are no rows. */
export function primaryHostname<T extends PublicOriginRow>(rows: readonly T[]): T | null {
  return rows.find((row) => row.isPrimary) ?? rows[0] ?? null
}

function primaryFirst<T extends PublicOriginRow>(rows: readonly T[]): T[] {
  const primary = rows.find((row) => row.isPrimary)
  return primary ? [primary, ...rows.filter((row) => row !== primary)] : [...rows]
}

function uniqueOrigins(origins: readonly (string | null)[]): string[] {
  return [...new Set(origins.filter((origin): origin is string => origin !== null))]
}

/** Public origins, the primary first, then creation order, without duplicates. */
export function orderedPublicOrigins(rows: readonly PublicOriginRow[]): string[] {
  return uniqueOrigins(primaryFirst(rows).map(publicOriginForHostname))
}

/** Public origins of the rows a server dials, the primary first when it is one of them. */
export function installUrlsFor(rows: readonly PublicOriginRow[]): string[] {
  return orderedPublicOrigins(rows.filter((row) => row.isDaemonDial ?? true))
}

/**
 * Every origin a browser can report for the passkey RP ID `rpId`: the row's
 * public origin and the panel's own `:8443` listener on the same host. A
 * different host is a different RP ID and never matches.
 */
export function publicOriginsForRpId(rows: readonly PublicOriginRow[], rpId: string): string[] {
  const wanted = hostFromPublicUrlEntry(rpId)?.toLowerCase()
  if (!wanted) return []
  const origins: (string | null)[] = []
  for (const row of primaryFirst(rows)) {
    if (hostFromPublicUrlEntry(row.host)?.toLowerCase() !== wanted) continue
    origins.push(publicOriginForHostname(row), publicUrlEntryToInstallOrigin(row.host))
  }
  return uniqueOrigins(origins)
}

export type PrimaryChange = {
  /** `primary-host-changed` also moves the passkey RP ID; `primary-origin-changed` is the port only. */
  code: 'primary-host-changed' | 'primary-origin-changed'
  previousPrimaryOrigin: string
  primaryOrigin: string | null
}

/** How the primary's public address moved, or null when it did not. */
export function describePrimaryChange(
  previous: string | null,
  next: string | null
): PrimaryChange | null {
  if (previous === null || previous === next) return null
  const sameHost =
    next !== null && hostFromPublicUrlEntry(previous) === hostFromPublicUrlEntry(next)
  return {
    code: sameHost ? 'primary-origin-changed' : 'primary-host-changed',
    previousPrimaryOrigin: previous,
    primaryOrigin: next,
  }
}
