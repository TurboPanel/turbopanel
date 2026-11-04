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

/**
 * The zone's nameserver names: the provider's own list first, then this
 * host's resolver. A resolver behind split DNS answers the zone locally and
 * lists no nameservers (or its own), so it is only the fallback. A provider
 * that cannot say, or refuses the read, leaves the resolver to answer.
 */
async function nameserverNames(
  provider: DnsChallengeProvider,
  dns: DnsLookup,
  zone: ProviderZone
): Promise<string[]> {
  const listed = provider.nameservers ? await provider.nameservers(zone.id).catch(() => []) : []
  if (listed.length > 0) return listed
  return await dns.ns(zone.name).catch(() => [])
}

async function nameserverAddresses(
  provider: DnsChallengeProvider,
  dns: DnsLookup,
  zone: ProviderZone
): Promise<string[]> {
  const servers = await nameserverNames(provider, dns, zone)
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
  const nameservers = await nameserverAddresses(input.provider, dns, zone)
  if (nameservers.length === 0) {
    const detail = `No nameservers found for ${zone.name}: the DNS provider listed none and this server's resolver returned no NS records.`
    return stop(checks, { cause: 'provider-error', detail }, zone)
  }
  checks.push(check('nameservers', true, `Found ${nameservers.length} nameserver addresses.`))
  return { ok: true, checks, failure: null, zone, nameservers }
}

/** What the authoritative servers said about the challenge value. */
export type TxtVisibility = {
  ok: boolean
  /** Servers that answered with the value. */
  confirmed: string[]
  /** Servers that answered without the value: the record has not reached them yet. */
  missing: string[]
  /** Servers that gave no answer (unreachable from this host, such as IPv6 on an IPv4-only host, or timed out). */
  unreachable: string[]
}

/**
 * Whether the challenge value is visible on the authoritative servers. A server
 * that answers without it holds the check back; a server this host cannot reach
 * says nothing either way and is left out, as long as at least one answers with
 * the value. An IPv4-only host would otherwise wait on every IPv6 address the
 * zone lists until the order gave up.
 */
export async function txtVisibleOnAll(
  dns: DnsLookup,
  servers: readonly string[],
  name: string,
  value: string
): Promise<TxtVisibility> {
  const seen = await Promise.all(
    servers.map(async (server) => {
      try {
        const values = await dns.txtAt(name, server)
        return { server, outcome: values.includes(value) ? 'confirmed' : 'missing' }
      } catch {
        return { server, outcome: 'unreachable' }
      }
    })
  )
  const pick = (outcome: string) =>
    seen.filter((item) => item.outcome === outcome).map((item) => item.server)
  const confirmed = pick('confirmed')
  const missing = pick('missing')
  const unreachable = pick('unreachable')
  return { ok: missing.length === 0 && confirmed.length > 0, confirmed, missing, unreachable }
}

/** The detail for a challenge record that is still not visible when the wait runs out. */
export function txtNotVisibleDetail(visible: TxtVisibility): string {
  if (visible.missing.length > 0) {
    const answered = visible.missing.length + visible.confirmed.length
    return `The challenge record is not visible on ${visible.missing.length} of ${answered} authoritative nameservers that answered yet.`
  }
  return `No authoritative nameserver could be reached to check the challenge record (${visible.unreachable.length} tried).`
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
    try {
      const answer = await Deno.resolveDns(name, 'TXT', {
        ...withTimeout(),
        nameServer: { ipAddr: server, port: 53 },
      })
      return answer.map((chunks) => chunks.join(''))
    } catch (err) {
      // NotFound is an answer: the server has no TXT record at the name.
      // Anything else (unreachable network, timeout) is no answer and throws on.
      if (err instanceof Deno.errors.NotFound) return []
      throw err
    }
  },
}
