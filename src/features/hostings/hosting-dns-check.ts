/**
 * "Can Let's Encrypt check this name on this server?" for the Let's Encrypt
 * button, the waiting sweep and the Check DNS action.
 *
 * Asking Let's Encrypt to issue before the name is ready just burns its
 * failed-validation limit (five per name per hour), so the control plane looks
 * first: every A and AAAA answer must be a serving server's address (the
 * authority tries IPv6 first, so a stale AAAA record fails even beside a right
 * A record), port 80 must answer from the internet, and CAA must allow the
 * authority. The lookups are injected: tests never touch the network, Deno uses
 * its own resolver, and Workers (which has no DNS API) uses DNS-over-HTTPS.
 */

import { dohLookup } from '../../lib/http/doh-resolve.ts'
import { ipAddressScope, normalizeIpAddress } from '../../lib/ip-address.ts'
import { type CertificatePrecheckProbes, checkCaa } from './certificate-precheck.ts'
import type { HostingDnsHostname, HostingDnsReport } from './hosting-certificate.ts'

export type DnsLookup = (name: string, recordType: 'A' | 'AAAA') => Promise<string[]>

type DenoResolveDns = (name: string, recordType: 'A' | 'AAAA') => Promise<string[]>

/** Deno's resolver where there is one, DNS-over-HTTPS otherwise. */
export function runtimeDnsLookup(): DnsLookup {
  const deno = (globalThis as { Deno?: { resolveDns?: unknown } }).Deno
  if (typeof deno?.resolveDns === 'function') return deno.resolveDns as DenoResolveDns
  return (name, recordType) => dohLookup(name, recordType)
}

/** A or AAAA failures ("no such name", timeout) count as "no records of that type". */
async function addressesOf(lookup: DnsLookup, name: string): Promise<string[]> {
  const settled = await Promise.allSettled([lookup(name, 'A'), lookup(name, 'AAAA')])
  const found: string[] = []
  for (const result of settled) {
    if (result.status !== 'fulfilled') continue
    for (const raw of result.value) {
      const address = normalizeIpAddress(raw)
      if (address !== null) found.push(address)
    }
  }
  return [...new Set(found)]
}

const UNREACHABLE_SCOPES = new Set(['loopback', 'link-local', 'private'])

function listed(addresses: readonly string[]): string {
  return addresses.join(', ')
}

/** The plain sentence for an address problem, or null when the addresses are fine. */
function addressProblem(
  hostname: string,
  addresses: readonly string[],
  wrong: readonly string[],
  expected: ReadonlySet<string>
): string | null {
  if (addresses.length === 0) return `${hostname} has no A or AAAA record yet.`
  const unreachable = addresses.filter((a) => UNREACHABLE_SCOPES.has(ipAddressScope(a) ?? ''))
  if (unreachable.length > 0) {
    return `${hostname} points at ${listed(unreachable)}, a private address the internet cannot reach.`
  }
  if (wrong.length === 0) return null
  const servers = listed([...expected])
  const ipv6 = wrong.some((a) => a.includes(':'))
    ? " Let's Encrypt tries IPv6 first, so a wrong AAAA record fails even when the A record is right."
    : " Let's Encrypt may use any of the addresses."
  return `${hostname} points at ${listed(wrong)}, which is not this site's server (${servers}).${ipv6}`
}

async function checkOneName(
  hostname: string,
  expected: ReadonlySet<string>,
  lookup: DnsLookup,
  probes: CertificatePrecheckProbes
): Promise<HostingDnsHostname> {
  const addresses = await addressesOf(lookup, hostname)
  const wrong = expected.size === 0 ? [] : addresses.filter((a) => !expected.has(a))
  const entry: HostingDnsHostname = {
    hostname,
    resolves: addresses.length > 0 && wrong.length === 0,
    addresses,
    ...(wrong.length > 0 ? { wrongAddresses: wrong } : {}),
  }
  const problem = addressProblem(hostname, addresses, wrong, expected)
  if (problem !== null) return { ...entry, problem }
  const port80 = await checkPort80(probes.port80, hostname, addresses)
  if (port80.problem !== undefined) return { ...entry, ...port80 }
  return { ...entry, ...port80, ...(await checkCaaOf(probes.caaLookup, hostname)) }
}

type ProbeFinding = Pick<HostingDnsHostname, 'port80' | 'caa' | 'problem'>

async function checkPort80(
  probe: CertificatePrecheckProbes['port80'],
  hostname: string,
  addresses: readonly string[]
): Promise<ProbeFinding> {
  if (!probe) return {}
  const result = await probe(hostname)
  if (result.open) return { port80: 'open' }
  const why = result.error ? ` (${result.error})` : ''
  return {
    port80: 'closed',
    problem:
      `${hostname} points at ${listed(addresses)}, but port 80 there isn't reachable from the internet${why}. ` +
      "Let's Encrypt checks the name over port 80, so open or forward port 80 to the server.",
  }
}

async function checkCaaOf(
  lookup: CertificatePrecheckProbes['caaLookup'],
  hostname: string
): Promise<ProbeFinding> {
  if (!lookup) return {}
  const caa = await checkCaa(lookup, hostname)
  if (caa.allowed === null) return {}
  if (caa.allowed) return { caa: 'allowed' }
  return {
    caa: 'blocked',
    problem: `A CAA record on ${caa.recordAt} does not allow Let's Encrypt to issue for ${hostname}. Add letsencrypt.org to it, or remove the record.`,
  }
}

/**
 * A name is ready when it resolves, every answer is one of the serving
 * servers' public addresses (when those are known; with none on record any
 * public answer counts, since the owner may use a proxy or an address the panel
 * cannot see), port 80 answers, and CAA allows Let's Encrypt. Probes that are
 * not passed are skipped.
 */
export async function checkHostingDns(params: {
  hostnames: readonly string[]
  expectedAddresses: readonly string[]
  lookup: DnsLookup
  now: Date
  probes?: CertificatePrecheckProbes
}): Promise<HostingDnsReport> {
  const expected = new Set(
    params.expectedAddresses
      .map((address) => normalizeIpAddress(address))
      .filter((address): address is string => address !== null)
  )
  const hostnames = await Promise.all(
    params.hostnames.map((hostname) =>
      checkOneName(hostname, expected, params.lookup, params.probes ?? {})
    )
  )
  return {
    ready: hostnames.every((entry) => entry.problem === undefined),
    checkedAt: params.now.toISOString(),
    hostnames,
    expectedAddresses: [...expected],
  }
}
