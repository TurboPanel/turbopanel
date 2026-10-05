/**
 * "Does this name already point at this server?" for the Let's Encrypt button.
 *
 * Asking Let's Encrypt to issue before the name resolves to the server just
 * burns its failed-validation limit, so the control plane looks first. The
 * lookup is injected: tests never touch the network, Deno uses its own
 * resolver, and Workers (which has no DNS API) uses DNS-over-HTTPS.
 */

import { dohLookup } from '../../lib/http/doh-resolve.ts'
import { normalizeIpAddress } from '../../lib/ip-address.ts'
import type { HostingDnsReport } from './hosting-certificate.ts'

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

/**
 * A name is ready when it resolves, and, when the server's public addresses are
 * known, at least one answer is one of them. With no known addresses any answer
 * counts (the owner may use a proxy or an address we cannot see).
 */
export async function checkHostingDns(params: {
  hostnames: readonly string[]
  expectedAddresses: readonly string[]
  lookup: DnsLookup
  now: Date
}): Promise<HostingDnsReport> {
  const expected = new Set(
    params.expectedAddresses
      .map((address) => normalizeIpAddress(address))
      .filter((address): address is string => address !== null)
  )
  const hostnames = await Promise.all(
    params.hostnames.map(async (hostname) => {
      const addresses = await addressesOf(params.lookup, hostname)
      const pointsHere = expected.size === 0 || addresses.some((a) => expected.has(a))
      return { hostname, resolves: addresses.length > 0 && pointsHere, addresses }
    })
  )
  return {
    ready: hostnames.every((entry) => entry.resolves),
    checkedAt: params.now.toISOString(),
    hostnames,
    expectedAddresses: [...expected],
  }
}
