/**
 * Hosted sites may never use a hostname the panel itself serves.
 *
 * The panel's names live in the instance hostname registry
 * (`/api/admin/v1/instance/hostnames`). A site that took one would shadow or
 * take over the panel on that name, so every path that writes a site hostname
 * (panel create and update, compose-declared routes, the deploy payload) asks
 * here. Only the exact names are refused: a wildcard site hostname stays
 * valid, and the exact panel name wins over it at the serving layer.
 */

import { HTTPException } from 'hono/http-exception'
import type { Db } from '../../db/connection.ts'
import { listInstanceHostnames } from '../install/instance-hostnames.ts'
import { hostingCertificateNames, type HostingWwwMode } from '../../contracts/commands/hostname.ts'
import { normalizeHostForCompare } from '../../lib/hostname-compare.ts'

export function panelHostnameInUseMessage(host: string): string {
  return `${host} is used by the control panel itself and cannot be used by a site`
}

/**
 * Thrown inside a write transaction so the site write rolls back. It is a
 * Hono `HTTPException`, so a route that lets it pass answers `409` with the
 * plain message without every route repeating a catch.
 */
export class PanelHostnameClaimError extends HTTPException {
  constructor(readonly hostname: string) {
    const message = panelHostnameInUseMessage(hostname)
    super(409, {
      message,
      res: Response.json(
        { error: 'hostname_is_panel_hostname', hostname, message },
        { status: 409 }
      ),
    })
    this.name = 'PanelHostnameClaimError'
  }
}

/** The set of normalised names the panel serves. */
export async function loadPanelHostSet(db: Db): Promise<Set<string>> {
  const rows = await listInstanceHostnames(db)
  return new Set(rows.map((row) => normalizeHostForCompare(row.host)))
}

/** The first of `names` (as the caller wrote it) that the panel serves, or null. */
export function firstPanelHostIn(
  names: readonly string[],
  panel: ReadonlySet<string>
): string | null {
  if (panel.size === 0) return null
  for (const name of names) {
    if (panel.has(normalizeHostForCompare(name))) return name
  }
  return null
}

/**
 * Not atomic with the write that follows: a panel hostname added between this
 * read and the commit is not seen. The window is accepted; the deploy payload
 * check refuses such a route at the next deploy.
 */
export async function assertNotPanelHostnames(db: Db, names: readonly string[]): Promise<void> {
  if (names.length === 0) return
  const hit = firstPanelHostIn(names, await loadPanelHostSet(db))
  if (hit !== null) throw new PanelHostnameClaimError(hit)
}

/**
 * Deploy-time backstop: the refusal for a stored route (typed names plus the
 * www names its choice adds) that uses a panel hostname, or null.
 */
export async function panelHostnameRefusal(
  db: Db,
  composeServiceName: string,
  route: Readonly<{ hostnames: string[]; www: HostingWwwMode }>
): Promise<{
  kind: 'hosting_hostname_is_panel'
  composeServiceName: string
  hostname: string
} | null> {
  const hit = firstPanelHostIn(hostingCertificateNames(route), await loadPanelHostSet(db))
  if (hit === null) return null
  return { kind: 'hosting_hostname_is_panel', composeServiceName, hostname: hit }
}
