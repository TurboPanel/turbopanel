/**
 * What a server's connector said about a tunnel that has no `portal` row for
 * that server. An all-servers tunnel stores no portals (only the exceptions),
 * so its connector answers are kept on the server, in
 * `server.metadata.tunnelConnectorReports`, keyed by the provider's tunnel id.
 * The whole object is rewritten from each answer, so a connector the daemon no
 * longer lists leaves nothing behind. Pure helpers only: `status.ts` writes the
 * object and `lifecycle.ts` reads it for the tunnel response.
 */
import type { TunnelStatusConnector } from '../../contracts/commands/tunnel-status.ts'

export type ConnectorReport = {
  reported: 'connected' | 'unknown' | 'down' | 'error'
  lastSeenAt: string
  lastError: string | null
  connectorVersion: string
}

export type PortalLike = {
  serverId: string
  wanted: string
  reported: string
  lastSeenAt: string | null
  lastError: string | null
  connectorVersion: string | null
}

const REPORTED = new Set(['connected', 'unknown', 'down', 'error'])

/** The stored report of one tunnel (by provider id) on a server, or null. */
export function connectorReportOf(metadata: unknown, providerId: string): ConnectorReport | null {
  const all = (metadata as { tunnelConnectorReports?: Record<string, unknown> } | null)
    ?.tunnelConnectorReports
  const raw = all?.[providerId] as Partial<ConnectorReport> | undefined
  if (!raw || typeof raw.reported !== 'string' || !REPORTED.has(raw.reported)) return null
  return {
    reported: raw.reported as ConnectorReport['reported'],
    lastSeenAt: typeof raw.lastSeenAt === 'string' ? raw.lastSeenAt : '',
    lastError: typeof raw.lastError === 'string' ? raw.lastError : null,
    connectorVersion: typeof raw.connectorVersion === 'string' ? raw.connectorVersion : '',
  }
}

/** One connector answer as the report kept for a tunnel without a portal row. */
export function reportOfConnector(
  connector: Pick<TunnelStatusConnector, 'version'>,
  reported: ConnectorReport['reported'],
  lastError: string | null,
  stamp: string
): ConnectorReport {
  return { reported, lastSeenAt: stamp, lastError, connectorVersion: connector.version }
}

/**
 * The servers that run an all-servers tunnel, as portals the panel shows: the
 * last report of each, or `unknown` while none arrived. A server that already
 * has a portal row keeps it. `wanted` is `run`: carrying is what it means.
 */
export function portalsForCarrying(
  carrying: readonly string[],
  stored: readonly PortalLike[],
  providerId: string | null,
  metadataByServer: ReadonlyMap<string, unknown>
): PortalLike[] {
  const have = new Set(stored.map((p) => p.serverId))
  const added = carrying
    .filter((id) => !have.has(id))
    .map((serverId): PortalLike => {
      const report = providerId
        ? connectorReportOf(metadataByServer.get(serverId), providerId)
        : null
      return {
        serverId,
        wanted: 'run',
        reported: report?.reported ?? 'unknown',
        lastSeenAt: report?.lastSeenAt ? report.lastSeenAt : null,
        lastError: report?.lastError ?? null,
        connectorVersion: report?.connectorVersion ? report.connectorVersion : null,
      }
    })
  return [...stored, ...added]
}
