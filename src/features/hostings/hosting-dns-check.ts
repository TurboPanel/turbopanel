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

function listed(addresses: readonly string[]): string {
  return addresses.join(', ')
}

const isPublic = (address: string) => ipAddressScope(address) === 'public'

/**
 * What always blocks: no address at all, or any answer that is not a public
 * address (private, loopback, 0.0.0.0, multicast, broadcast). Such an answer
 * is never probed, and the authority can never reach it.
 */
function blockingAddressProblem(hostname: string, addresses: readonly string[]): string | null {
  if (addresses.length === 0) return `${hostname} has no A or AAAA record yet.`
  const unreachable = addresses.filter((a) => !isPublic(a))
  if (unreachable.length === 0) return null
  return `${hostname} points at ${listed(unreachable)}, an address the internet cannot reach.`
}

/** The plain sentence for public answers that are not a serving server's, or null. */
function wrongAddressProblem(
  hostname: string,
  wrong: readonly string[],
  expected: ReadonlySet<string>
): string | null {
  if (wrong.length === 0) return null
  const servers = listed([...expected])
  const ipv6 = wrong.some((a) => a.includes(':'))
    ? " Let's Encrypt tries IPv6 first, so a wrong AAAA record fails even when the A record is right."
    : " Let's Encrypt may use any of the addresses."
  return `${hostname} points at ${listed(wrong)}, which is not this site's server (${servers}).${ipv6}`
}

const isIpv6 = (address: string) => address.includes(':')

/**
 * The wrong answers that still leave every address family with at least one
 * answer pointing at a serving server: the authority may still pick a wrong
 * one, so they warn, but they do not block. A family whose answers are all
 * wrong (such as an AAAA record when the server has no IPv6) blocks.
 */
function onlyWarns(addresses: readonly string[], wrong: readonly string[]): boolean {
  if (wrong.length === 0) return false
  return [true, false].every((v6) => {
    const family = addresses.filter((a) => isIpv6(a) === v6)
    return family.length === 0 || family.some((a) => !wrong.includes(a))
  })
}

async function checkOneName(
  hostname: string,
  expected: ReadonlySet<string>,
  lookup: DnsLookup,
  probes: CertificatePrecheckProbes
): Promise<HostingDnsHostname> {
  const addresses = await addressesOf(lookup, hostname)
  const wrong = expected.size === 0 ? [] : addresses.filter((a) => !expected.has(a))
  const blocking = blockingAddressProblem(hostname, addresses)
  // A non-public answer never reaches the warn-only rule: it always blocks.
  const warnOnly = blocking === null && onlyWarns(addresses, wrong)
  const entry: HostingDnsHostname = {
    hostname,
    resolves: addresses.length > 0 && (wrong.length === 0 || warnOnly),
    addresses,
    ...(wrong.length > 0 ? { wrongAddresses: wrong } : {}),
  }
  if (blocking !== null) return { ...entry, resolves: false, problem: blocking }
  const problem = wrongAddressProblem(hostname, wrong, expected)
  if (problem !== null && !warnOnly) return { ...entry, problem }
  if (problem !== null) entry.warning = problem
  const port80 = await checkPort80(probes.port80, hostname, addresses.filter(isPublic))
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
  const result = await probe(hostname, addresses)
  if (result.state === 'unknown') return {}
  if (result.state === 'open') return { port80: 'open' }
  const where = result.address ?? listed(addresses)
  const why = result.error ? ` (${result.error})` : ''
  return {
    port80: 'closed',
    problem:
      `${hostname} points at ${where}, but port 80 there refused the connection${why}, so it isn't reachable from the internet. ` +
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
