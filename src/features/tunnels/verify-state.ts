/**
 * The per-tunnel choice to verify the hop between the connector and the web
 * server. The choice (`tunnel.options.verifyOrigin`) is only half of it: the
 * connector may verify only while EVERY name of the tunnel is served with an
 * origin certificate that covers it, otherwise a site that is not set up yet
 * would be unreachable. `tunnelVerifyState` reads both halves; the routes sent
 * to the provider use `active`, never the bare choice.
 */
import { and, eq, inArray, ne } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { doorway, hosting, tls, tunnel } from '../../db/schema.ts'
import {
  originCertificateIsDue,
  readProviderOrigin,
  certificateCoversAll,
} from './origin-certificate.ts'

export type VerifyState = {
  /** The person asked for a verified connection. */
  enabled: boolean
  /** Every name is served with a covering origin certificate, so the connector verifies. */
  active: boolean
  /** Names still waiting for a site or a certificate. */
  pendingNames: string[]
}

export function verifyOriginOf(options: unknown): boolean {
  return (
    typeof options === 'object' &&
    options !== null &&
    (options as Record<string, unknown>).verifyOrigin === true
  )
}

export async function tunnelVerifyState(
  db: Db,
  row: { id: string; options: unknown },
  now: Date = new Date()
): Promise<VerifyState> {
  if (!verifyOriginOf(row.options)) return { enabled: false, active: false, pendingNames: [] }
  const doorways = await db
    .select({ hostname: doorway.hostname, hostingId: doorway.hostingId })
    .from(doorway)
    .where(and(eq(doorway.tunnelId, row.id), ne(doorway.status, 'removing')))
  const hostingIds = [...new Set(doorways.flatMap((d) => (d.hostingId ? [d.hostingId] : [])))]
  const pins =
    hostingIds.length === 0
      ? []
      : await db
          .select({ id: hosting.id, tlsId: hosting.tlsId })
          .from(hosting)
          .where(inArray(hosting.id, hostingIds))
  const tlsIds = [...new Set(pins.flatMap((p) => (p.tlsId ? [p.tlsId] : [])))]
  const certs =
    tlsIds.length === 0 ? [] : await db.select().from(tls).where(inArray(tls.id, tlsIds))
  const pinOf = new Map(pins.map((p) => [p.id, p.tlsId]))
  const certOf = new Map(certs.map((c) => [c.id, c]))
  const pendingNames = doorways
    .filter((d) => {
      const tlsId = d.hostingId ? pinOf.get(d.hostingId) : null
      const cert = tlsId ? certOf.get(tlsId) : null
      const link = cert?.source === 'provider_origin' ? readProviderOrigin(cert.metadata) : null
      return !(
        cert &&
        link &&
        cert.status === 'ready' &&
        !originCertificateIsDue(cert.notAfter, now) &&
        certificateCoversAll(link, [d.hostname])
      )
    })
    .map((d) => d.hostname)
  return { enabled: true, active: doorways.length > 0 && pendingNames.length === 0, pendingNames }
}

/** Hostnames (any tunnel of the organization) whose tunnel asks for a verified connection. */
export async function verifyOriginHostnames(db: Db, organizationId: string): Promise<string[]> {
  const rows = await db
    .select({ hostname: doorway.hostname, options: tunnel.options })
    .from(doorway)
    .innerJoin(tunnel, eq(tunnel.id, doorway.tunnelId))
    .where(and(eq(tunnel.organizationId, organizationId), ne(doorway.status, 'removing')))
  return rows.filter((r) => verifyOriginOf(r.options)).map((r) => r.hostname)
}
