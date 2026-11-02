/**
 * Checks before the authority is asked for anything: the zone is on the
 * connected account, the token can write a TXT record there, CAA allows the
 * issuer, and the zone's nameservers are known. The same module later checks
 * that the challenge record is visible on every authoritative nameserver.
 */
import type { DnsChallengeProvider } from '../../../../features/tls/dns-certificates/dns-provider.ts'
import { TunnelProviderError } from '../../../../features/tunnels/errors.ts'
import { type ProviderZone, zoneForName } from '../accounts.ts'
import type { PreflightCheck } from '../provider.ts'
import { check } from '../planner.ts'
import type { Dns01Failure } from './state.ts'

/** The record types this module asks for; a thin seam over `Deno.resolveDns`. */
export type DnsLookup = {
  caa(name: string): Promise<{ tag: string; value: string }[]>
  ns(name: string): Promise<string[]>
  addresses(name: string): Promise<string[]>
  /** TXT values at `name` as one authoritative server (by address) answers. */
  txtAt(name: string, server: string): Promise<string[]>
}

export type Dns01Preflight = {
  ok: boolean
  checks: PreflightCheck[]
  failure: Dns01Failure | null
  zone: ProviderZone | null
  nameservers: string[]
}

/** Let's Encrypt's CAA identity; its staging directory uses the same one. */
export const LETS_ENCRYPT_CAA = ['letsencrypt.org'] as const
const LOOKUP_TIMEOUT_MS = 3_000

function stop(
  checks: PreflightCheck[],
  failure: Dns01Failure,
  zone: ProviderZone | null
): Dns01Preflight {
  return {
    ok: false,
    checks: [...checks, check(failure.cause, false, failure.detail)],
    failure,
    zone,
    nameservers: [],
  }
}

async function probeWrite(
  provider: DnsChallengeProvider,
  zone: ProviderZone,
  host: string
): Promise<boolean> {
  const value = crypto.randomUUID()
  let ref: Awaited<ReturnType<DnsChallengeProvider['present']>> | null = null
  try {
    ref = await provider.present({ zoneId: zone.id, name: `_turbopanel-probe.${host}`, value })
    return true
  } catch (err) {
    if (
      err instanceof TunnelProviderError &&
      (err.code === 'unauthorized' || err.code === 'forbidden')
    ) {
      return false
    }
    throw err
  } finally {
    if (ref) await provider.remove(ref).catch(() => undefined)
  }
}

/** Names from the host up to the zone apex, nearest first. */
export function caaWalk(host: string, zoneName: string): string[] {
  const labels = host.split('.')
  const names: string[] = []
  for (let i = 0; i < labels.length; i++) {
    const name = labels.slice(i).join('.')
    names.push(name)
    if (name === zoneName) break
  }
  return names
}

function issuerOf(value: string): string {
  return value.split(';')[0]!.trim().toLowerCase()
}

/** The first name with CAA records decides; no `issue` record there means any issuer. */
export async function caaAllows(
  dns: DnsLookup,
  host: string,
  zoneName: string,
  identities: readonly string[]
): Promise<{ ok: boolean; name: string | null }> {
  for (const name of caaWalk(host, zoneName)) {
    const records = await dns.caa(name).catch(() => [])
    if (records.length === 0) continue
    const issue = records.filter((record) => record.tag.toLowerCase() === 'issue')
    if (issue.length === 0) return { ok: true, name }
    return { ok: issue.some((record) => identities.includes(issuerOf(record.value))), name }
  }
  return { ok: true, name: null }
}

async function nameserverAddresses(dns: DnsLookup, zoneName: string): Promise<string[]> {
  const servers = await dns.ns(zoneName).catch(() => [])
  const addresses = await Promise.all(
    servers.map((server) => dns.addresses(server.replace(/\.$/, '')).catch(() => []))
  )
  return [...new Set(addresses.flat())]
}

export async function preflightDns01(input: {
  provider: DnsChallengeProvider
  dns: DnsLookup
  zones: readonly ProviderZone[]
  host: string
  identities?: readonly string[]
}): Promise<Dns01Preflight> {
  const { host, dns } = input
  const zone = zoneForName(input.zones, host)
  if (!zone) {
    const detail = `The zone for ${host} is not on the connected Cloudflare account.`
    return stop([], { cause: 'zone-not-on-provider', detail }, null)
  }
  const checks = [check('zone-on-provider', true, `${host} is in the ${zone.name} zone.`)]
  if (!(await probeWrite(input.provider, zone, host))) {
    return stop(
      checks,
      { cause: 'scope-missing', detail: `The token cannot edit DNS records in ${zone.name}.` },
      zone
    )
  }
  checks.push(check('scope-dns-write', true, `The token can write records in ${zone.name}.`))
  const caa = await caaAllows(dns, host, zone.name, input.identities ?? LETS_ENCRYPT_CAA)
  if (!caa.ok) {
    const detail = `A CAA record on ${caa.name} does not allow this certificate authority.`
    return stop(checks, { cause: 'caa-forbids', detail }, zone)
  }
  checks.push(check('caa', true, 'CAA records allow this certificate authority.'))
  const nameservers = await nameserverAddresses(dns, zone.name)
  if (nameservers.length === 0) {
    return stop(
      checks,
      { cause: 'provider-error', detail: "Could not read the zone's nameservers." },
      zone
    )
  }
  checks.push(check('nameservers', true, `Found ${nameservers.length} nameserver addresses.`))
  return { ok: true, checks, failure: null, zone, nameservers }
}

/** Whether every authoritative server already answers the challenge value. */
export async function txtVisibleOnAll(
  dns: DnsLookup,
  servers: readonly string[],
  name: string,
  value: string
): Promise<{ ok: boolean; missing: string[] }> {
  const seen = await Promise.all(
    servers.map(async (server) => {
      const values: string[] = await dns.txtAt(name, server).catch(() => [])
      return { server, ok: values.includes(value) }
    })
  )
  const missing = seen.filter((item) => !item.ok).map((item) => item.server)
  return { ok: missing.length === 0, missing }
}

type DenoCaa = { critical: boolean; tag: string; value: string }

function withTimeout(): { signal: AbortSignal } {
  return { signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) }
}

/** The real lookups. Straight to the DNS, not the system resolver: authoritative answers are the point. */
export const denoDnsLookup: DnsLookup = {
  caa: async (name) =>
    ((await Deno.resolveDns(name, 'CAA', withTimeout())) as DenoCaa[]).map((record) => ({
      tag: record.tag,
      value: record.value,
    })),
  ns: (name) => Deno.resolveDns(name, 'NS', withTimeout()),
  addresses: async (name) => {
    const [v4, v6] = await Promise.all([
      Deno.resolveDns(name, 'A', withTimeout()).catch(() => []),
      Deno.resolveDns(name, 'AAAA', withTimeout()).catch(() => []),
    ])
    return [...v4, ...v6]
  },
  txtAt: async (name, server) => {
    const answer = await Deno.resolveDns(name, 'TXT', {
      ...withTimeout(),
      nameServer: { ipAddr: server, port: 53 },
    })
    return answer.map((chunks) => chunks.join(''))
  },
}
