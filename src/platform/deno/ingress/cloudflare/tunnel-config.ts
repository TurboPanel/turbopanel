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
import {
  type InstanceHostnameRecord,
  isAcmeHostnameSource,
} from '../../../../features/install/instance-hostnames.ts'
import type { HostnameWithState, IngressPhase } from '../provider.ts'

/** The loopback hop from the connector to the control plane listener. */
export const PANEL_ORIGIN_DIAL = 'https://127.0.0.1:8443'
/**
 * The shape of the panel's tunnel rules. Raise it when `buildPanelIngress`
 * changes in a way an existing tunnel must pick up: the ingress tick re-applies
 * every tunnel row stored with an older version. 2: no `httpHostHeader` (a
 * forced bare Host looped the edge-port redirect).
 */
export const PANEL_RULES_VERSION = 2
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
  /**
   * True when the tunnel existed before (made in the Cloudflare dashboard, or
   * found through the name's CNAME): its other rules are kept, and removing
   * the last name never deletes it or stops its connector.
   */
  adopted: boolean
  tokenPushedAt: string
  /** True when the rule for this name verifies the origin certificate (a public pair is live for it). */
  originVerified: boolean
  /** `PANEL_RULES_VERSION` when the rules were last written; state from before it counts as 1. */
  rulesVersion: number
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
 * Whether the listener presents a publicly trusted certificate for this name,
 * so the loopback hop can verify it: an ACME pair (HTTP-01 or DNS-01) that is
 * issued and unexpired. Uploaded and Platform CA pairs may be private, so they
 * keep the unverified hop.
 */
export function originCertVerifiable(
  row: Pick<InstanceHostnameRecord, 'source' | 'status'>
): boolean {
  return row.status === 'ready' && isAcmeHostnameSource(row.source)
}

/**
 * One rule per name, all to the loopback listener, then the catch-all.
 * `noTLSVerify` stays on for the loopback hop unless the name is in
 * `verified` (a public pair is live for it; `originServerName` makes the
 * listener present that pair and the connector checks it). For the rest it
 * stays on until the connector can read the Platform CA (`caPool` is a later
 * step).
 */
export function buildPanelIngress(
  names: readonly string[],
  existing: readonly CloudflareIngressRule[] = [],
  dropped: readonly string[] = [],
  verified: ReadonlySet<string> = new Set()
): CloudflareIngressRule[] {
  const unique = [...new Set(names.map((name) => name.toLowerCase()))].sort((a, b) =>
    a.localeCompare(b)
  )
  const ours = new Set([...unique, ...dropped.map((name) => name.toLowerCase())])
  // Rules someone else put on an adopted tunnel stay, in their order, ahead of
  // ours; its own catch-all (whatever it serves) stays last.
  const kept = existing.filter((rule) => !rule.hostname || !ours.has(rule.hostname.toLowerCase()))
  const last = kept.at(-1)
  const catchAll = last && !last.hostname ? last : { service: 'http_status:404' }
  const before = last && !last.hostname ? kept.slice(0, -1) : kept
  const rules: CloudflareIngressRule[] = unique.map((hostname) => ({
    hostname,
    service: PANEL_ORIGIN_DIAL,
    originRequest: {
      originServerName: hostname,
      // No httpHostHeader: the visitor's own Host (with :8443 when they used
      // it) must reach Caddy, whose edge-port redirect reads the port from it.
      // A forced bare name looks like port 443 and loops the redirect.
      noTLSVerify: !verified.has(hostname),
    },
  }))
  return [...before, ...rules, catchAll]
}

/** The tunnel id a `<id>.cfargotunnel.com` CNAME points at, or null. */
export function tunnelIdFromTarget(content: string | undefined): string | null {
  const match = /^([0-9a-f-]{36})\.cfargotunnel\.com\.?$/i.exec(content ?? '')
  return match ? match[1]!.toLowerCase() : null
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
    adopted: raw.adopted === true,
    tokenPushedAt: typeof raw.tokenPushedAt === 'string' ? raw.tokenPushedAt : '',
    originVerified: raw.originVerified === true,
    rulesVersion: typeof raw.rulesVersion === 'number' ? raw.rulesVersion : 1,
  }
}

/**
 * Whether a tunnel row must be applied again: its rule's origin check no
 * longer matches its certificate, or its rules were written in an older shape.
 */
export function tunnelRulesStale(state: TunnelState, originVerifiable: boolean): boolean {
  return state.originVerified !== originVerifiable || state.rulesVersion < PANEL_RULES_VERSION
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
