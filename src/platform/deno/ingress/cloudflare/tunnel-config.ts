/**
 * Pure pieces of the control plane's own Cloudflare tunnel: its name, the
 * ingress rules, the stored state and the health reading. Every hostname in
 * `cloudflare-tunnel` mode on one account shares one tunnel, so the rule list
 * is rebuilt from all of them on every apply and remove.
 */
import type {
  CloudflareIngressRule,
  CloudflareTunnelDetail,
} from '../../../../features/tunnels/cloudflare-client.ts'
import { hostFromPublicUrlEntry } from '../../../../features/install/public-urls.ts'
import type { HostnameWithState, IngressPhase } from '../provider.ts'

/** The loopback hop from the connector to the control plane listener. */
export const PANEL_ORIGIN_DIAL = 'https://127.0.0.1:8443'
/** Cloudflare runs four connections per connector when it is fully up. */
export const HEALTHY_CONNECTIONS = 4
/** How long a pushed run token may take to bring the connector up before the tunnel counts as failed. */
export const CONNECT_GRACE_MS = 2 * 60_000

export type TunnelState = {
  tunnelId: string
  tunnelName: string
  accountId: string
  zoneId: string
  dnsRecordId: string
  /** True when this control plane created the DNS record, so remove deletes it. */
  createdRecord: boolean
  tokenPushedAt: string
}

export function tunnelName(instanceId: string): string {
  return `turbopanel-control-plane-${instanceId.slice(0, 12)}`
}

export function tunnelTarget(tunnelId: string): string {
  return `${tunnelId}.cfargotunnel.com`
}

/** The bare DNS name of a stored hostname entry (`https://name:8443` → `name`). */
export function dnsName(host: string): string | null {
  return hostFromPublicUrlEntry(host)?.toLowerCase().replace(/\.$/, '') ?? null
}

/**
 * One rule per name, all to the loopback listener, then the catch-all.
 * `noTLSVerify` stays on for the loopback hop until the connector can read the
 * Platform CA (`caPool` is a later step); `originServerName` still makes the
 * listener pick the right certificate.
 */
export function buildPanelIngress(names: readonly string[]): CloudflareIngressRule[] {
  const unique = [...new Set(names.map((name) => name.toLowerCase()))].sort()
  const rules: CloudflareIngressRule[] = unique.map((hostname) => ({
    hostname,
    service: PANEL_ORIGIN_DIAL,
    originRequest: { originServerName: hostname, httpHostHeader: hostname, noTLSVerify: true },
  }))
  rules.push({ service: 'http_status:404' })
  return rules
}

export function readTunnelState(value: unknown): TunnelState | null {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Partial<TunnelState>
  if (typeof raw.tunnelId !== 'string' || typeof raw.accountId !== 'string') return null
  return {
    tunnelId: raw.tunnelId,
    tunnelName: typeof raw.tunnelName === 'string' ? raw.tunnelName : '',
    accountId: raw.accountId,
    zoneId: typeof raw.zoneId === 'string' ? raw.zoneId : '',
    dnsRecordId: typeof raw.dnsRecordId === 'string' ? raw.dnsRecordId : '',
    createdRecord: raw.createdRecord === true,
    tokenPushedAt: typeof raw.tokenPushedAt === 'string' ? raw.tokenPushedAt : '',
  }
}

/** Tunnel rows on one account that are set up, other than `exceptId`. */
export function appliedTunnelRows(
  rows: readonly HostnameWithState[],
  ingressId: string,
  exceptId: string
): { row: HostnameWithState; state: TunnelState }[] {
  return rows.flatMap((row) => {
    if (row.id === exceptId || row.mode !== 'cloudflare-tunnel' || row.ingressId !== ingressId) {
      return []
    }
    const state = readTunnelState(row.providerState)
    return state ? [{ row, state }] : []
  })
}

/** Health of the tunnel as Cloudflare reports it, before the edge self-check. */
export function tunnelPhase(
  detail: Pick<CloudflareTunnelDetail, 'status' | 'connections'>,
  tokenPushedAt: string,
  now: Date
): { phase: IngressPhase; connections: number } {
  const connections = detail.connections?.length ?? 0
  if (detail.status === 'healthy' && connections >= HEALTHY_CONNECTIONS) {
    return { phase: 'healthy', connections }
  }
  if (connections > 0) return { phase: 'degraded', connections }
  const pushed = Date.parse(tokenPushedAt)
  const waiting = !Number.isNaN(pushed) && now.getTime() - pushed < CONNECT_GRACE_MS
  return { phase: waiting ? 'applying' : 'failed', connections }
}
