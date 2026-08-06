/**
 * Secrets-free resolution of services that need a per-service Traefik ingress
 * project (at least one `tcp`/`udp` hosting with non-empty `ports`).
 *
 * Shared by deploy-preview and deploy so operators see `<service.id>-in`
 * before the daemon applies it.
 */

import { eq } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import { hosting, service } from '../../lib/db/schema.ts'
import {
  parseHostingOptions,
  resolveHostingProtocol,
} from '../../lib/hosting-options.ts'

export type TcpUdpIngressService = {
  serviceId: string
  composeServiceName: string
}

/**
 * Services in `environmentId` that publish at least one `tcp`/`udp` port via
 * hosting options. Deduped by `serviceId`. No secrets / TLS / daemon-key work.
 */
export async function resolveTcpUdpIngressServices(
  db: Db,
  environmentId: string,
): Promise<TcpUdpIngressService[]> {
  const rows = await db
    .select({
      serviceId: service.id,
      composeServiceName: service.composeServiceName,
      hostingOptions: hosting.options,
    })
    .from(service)
    .innerJoin(hosting, eq(hosting.serviceId, service.id))
    .where(eq(service.environmentId, environmentId))

  const byService = new Map<string, TcpUdpIngressService>()
  for (const row of rows) {
    if (byService.has(row.serviceId)) continue
    const options = parseHostingOptions(row.hostingOptions)
    const protocol = resolveHostingProtocol(options)
    if (protocol !== 'tcp' && protocol !== 'udp') continue
    if (!options?.ports || options.ports.length === 0) continue
    byService.set(row.serviceId, {
      serviceId: row.serviceId,
      composeServiceName: row.composeServiceName,
    })
  }

  return [...byService.values()].sort((a, b) =>
    a.composeServiceName.localeCompare(b.composeServiceName)
  )
}
