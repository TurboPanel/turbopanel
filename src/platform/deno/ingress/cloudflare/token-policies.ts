/**
 * What a Cloudflare API token may do, read from its own policies (the
 * `policies` of GET /user/tokens/{id} or /accounts/{id}/tokens/{id}). Pure:
 * no requests here.
 *
 * Rules:
 * - Cloudflare Tunnel Edit counts only in an allow policy whose resources
 *   cover the account (`com.cloudflare.api.account.<id>: "*"` or the
 *   all-accounts wildcard). The same permission in a zone-only policy does not
 *   count.
 * - DNS Edit covers a zone through the zone itself, the all-zones wildcard,
 *   an account-level resource (every zone of that account), or the nested
 *   "zones of this account" form.
 * - A deny policy covering the same resource wins over any allow.
 */
import type { ProviderZone } from '../accounts.ts'

export type CloudflarePermissionGroup = { id?: string; name?: string }
export type CloudflareTokenPolicy = {
  id?: string
  effect?: string
  resources?: Record<string, unknown>
  permission_groups?: CloudflarePermissionGroup[]
}

const ACCOUNT_PREFIX = 'com.cloudflare.api.account.'
const ZONE_PREFIX = 'com.cloudflare.api.account.zone.'
const ALL_ACCOUNTS = `${ACCOUNT_PREFIX}*`
const ALL_ZONES = `${ZONE_PREFIX}*`

/** API names (Write) and dashboard names (Edit), lower case. */
const TUNNEL_WRITE = new Set([
  'cloudflare tunnel write',
  'cloudflare tunnel edit',
  'argo tunnel write',
])
const DNS_WRITE = new Set(['dns write', 'dns edit'])

type Effect = 'allow' | 'deny'

function effectOf(policy: CloudflareTokenPolicy): Effect | null {
  const effect = policy.effect?.toLowerCase()
  return effect === 'allow' || effect === 'deny' ? effect : null
}

function grants(policy: CloudflareTokenPolicy, names: ReadonlySet<string>): boolean {
  return (policy.permission_groups ?? []).some((group) =>
    names.has((group.name ?? '').trim().toLowerCase())
  )
}

function entries(policy: CloudflareTokenPolicy): [string, unknown][] {
  const resources = policy.resources
  return resources && typeof resources === 'object' ? Object.entries(resources) : []
}

function isAccountKey(key: string, accountId: string): boolean {
  return key === ALL_ACCOUNTS || key === `${ACCOUNT_PREFIX}${accountId}`
}

/** The account itself (not only its zones). */
function coversAccount(policy: CloudflareTokenPolicy, accountId: string): boolean {
  return entries(policy).some(([key, value]) => isAccountKey(key, accountId) && value === '*')
}

function zoneKeyCovers(key: string, value: unknown, zoneId: string): boolean {
  return value === '*' && (key === ALL_ZONES || key === `${ZONE_PREFIX}${zoneId}`)
}

function coversZone(policy: CloudflareTokenPolicy, accountId: string, zoneId: string): boolean {
  return entries(policy).some(([key, value]) => {
    if (zoneKeyCovers(key, value, zoneId)) return true
    if (!isAccountKey(key, accountId)) return false
    if (value === '*') return true
    if (typeof value !== 'object' || value === null) return false
    return Object.entries(value).some(([inner, innerValue]) =>
      zoneKeyCovers(inner, innerValue, zoneId)
    )
  })
}

/** Whether the policy reaches every zone of the account, not a chosen few. */
function coversAllZones(policy: CloudflareTokenPolicy, accountId: string): boolean {
  return entries(policy).some(([key, value]) => {
    if (key === ALL_ZONES && value === '*') return true
    if (!isAccountKey(key, accountId)) return false
    if (value === '*') return true
    return (
      typeof value === 'object' &&
      value !== null &&
      (value as Record<string, unknown>)[ALL_ZONES] === '*'
    )
  })
}

/** Zone ids a policy names one by one, flat or nested. */
function namedZoneIds(policy: CloudflareTokenPolicy): string[] {
  return entries(policy).flatMap(([key, value]) => {
    const inner = typeof value === 'object' && value !== null ? Object.keys(value) : []
    return [key, ...inner]
      .filter((item) => item.startsWith(ZONE_PREFIX) && item !== ALL_ZONES)
      .map((item) => item.slice(ZONE_PREFIX.length))
  })
}

function withEffect(
  policies: readonly CloudflareTokenPolicy[],
  effect: Effect,
  names: ReadonlySet<string>
): CloudflareTokenPolicy[] {
  return policies.filter((policy) => effectOf(policy) === effect && grants(policy, names))
}

export type TunnelGrant =
  | { kind: 'account' }
  | { kind: 'denied' }
  | { kind: 'zone-only'; zoneIds: string[] }
  | { kind: 'missing' }

export type DnsGrant = {
  /** Zones of the account the token may edit records in, after deny policies. */
  zones: ProviderZone[]
  /** The grant reaches every zone of the account, more than the control plane needs. */
  allZones: boolean
  /** DNS Edit was granted somewhere but deny policies took every zone away. */
  denied: boolean
}

export function tunnelGrant(
  policies: readonly CloudflareTokenPolicy[],
  accountId: string
): TunnelGrant {
  const allows = withEffect(policies, 'allow', TUNNEL_WRITE)
  const denies = withEffect(policies, 'deny', TUNNEL_WRITE)
  const onAccount = allows.some((policy) => coversAccount(policy, accountId))
  if (onAccount) {
    return denies.some((policy) => coversAccount(policy, accountId))
      ? { kind: 'denied' }
      : { kind: 'account' }
  }
  const zoneIds = [...new Set(allows.flatMap(namedZoneIds))]
  const anyZone = allows.some((policy) => coversAllZones(policy, accountId))
  if (zoneIds.length > 0 || anyZone) return { kind: 'zone-only', zoneIds }
  return { kind: 'missing' }
}

export function dnsGrant(
  policies: readonly CloudflareTokenPolicy[],
  accountId: string,
  zones: readonly ProviderZone[]
): DnsGrant {
  const allows = withEffect(policies, 'allow', DNS_WRITE)
  const denies = withEffect(policies, 'deny', DNS_WRITE)
  const covered = (list: CloudflareTokenPolicy[], zone: ProviderZone) =>
    list.some((policy) => coversZone(policy, accountId, zone.id))
  const allowed = zones.filter((zone) => covered(allows, zone))
  const kept = allowed.filter((zone) => !covered(denies, zone))
  return {
    zones: kept.map((zone) => ({ id: zone.id, name: zone.name.toLowerCase() })),
    allZones: kept.length > 0 && allows.some((policy) => coversAllZones(policy, accountId)),
    denied: allowed.length > 0 && kept.length === 0,
  }
}
