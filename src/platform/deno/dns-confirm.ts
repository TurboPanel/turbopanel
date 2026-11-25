/**
 * The read-back for a challenge record on the Deno panel: the record counts as
 * visible once every authoritative nameserver of the zone returns it, which is
 * what the certificate authority will ask. The nameservers come from the DNS
 * provider's own API as host names; a provider that lists none is read through
 * its API only.
 *
 * A nameserver is asked by address, so each name is resolved first, the way
 * the preflight does for the order it runs before asking the authority.
 */
import {
  type DnsConfirm,
  confirmThroughProvider,
} from '../../features/tls/http-issuance/dns-relay.ts'
import { type DnsLookup, denoDnsLookup, txtVisibleOnAll } from './ingress/dns01/preflight.ts'

export function confirmOnNameserversWith(lookup: DnsLookup): DnsConfirm {
  return async (input) => {
    const names = (await input.dns.nameservers?.(input.zoneId)) ?? []
    if (names.length === 0) return await confirmThroughProvider(input)
    const resolved = await Promise.all(
      names.map((name) => lookup.addresses(name.replace(/\.$/, '')).catch(() => []))
    )
    const addresses = [...new Set(resolved.flat())]
    // No address to ask is no answer: keep waiting, as the order check does.
    if (addresses.length === 0) return false
    return (await txtVisibleOnAll(lookup, addresses, input.name, input.value)).ok
  }
}

export const confirmOnNameservers: DnsConfirm = confirmOnNameserversWith(denoDnsLookup)
