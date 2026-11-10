/**
 * Which names a server-placed order asks for, and which daemons may take it.
 *
 * A row holds the names typed for it. A site that pins the row may also answer
 * on the other spelling its www mode adds, and with a pinned certificate that
 * name is served with the same pair, so the order asks for the row's names
 * plus every www name of the sites that pin it. A daemon that lists
 * `acme-issue-one-cert-v1` gets one certificate for all of them; an older one
 * gets one certificate per name, which a row cannot hold, so it is sent only a
 * single-name order.
 */
import { hostingCertificateNames } from '../../../contracts/commands/hostname.ts'
import type { HostingWwwMode } from '../../../contracts/commands/hostname.ts'
import { ACME_ISSUE_FEATURE, ACME_ISSUE_ONE_CERT_FEATURE } from '../../../lib/version-wire.ts'

export type PinningSite = { hostnames: readonly string[]; www: HostingWwwMode }

/**
 * The row's names first, then each www name a pinning site adds, each once and
 * lowercased. Null when the row names nothing or any name is a wildcard (that
 * needs the DNS proof).
 */
export function orderNamesFor(
  rowNames: readonly string[],
  sites: readonly PinningSite[]
): string[] | null {
  const typed = rowNames.map((name) => name.trim().toLowerCase()).filter((n) => n.length > 0)
  if (typed.length === 0) return null
  const rowSet = new Set(typed)
  const added = sites.flatMap((site) => {
    // Only a site whose typed names the row covers adds its other spellings.
    const own = site.hostnames.map((name) => name.trim().toLowerCase())
    if (!own.every((name) => rowSet.has(name))) return []
    return hostingCertificateNames({ hostnames: own, www: site.www })
  })
  const names = [...new Set([...typed, ...added])]
  return names.some((name) => name.includes('*')) ? null : names
}

/** Whether a daemon with these features can take an order for these names. */
export function takesOrderFor(features: readonly string[], names: readonly string[]): boolean {
  if (!features.includes(ACME_ISSUE_FEATURE)) return false
  return names.length <= 1 || features.includes(ACME_ISSUE_ONE_CERT_FEATURE)
}
