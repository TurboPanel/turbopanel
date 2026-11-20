/**
 * The read-back for a challenge record on the Deno panel: the record counts as
 * visible once every authoritative nameserver of the zone returns it, which is
 * what the certificate authority will ask. The nameservers come from the DNS
 * provider's own API; a provider that lists none is read through its API only.
 */
import {
  type DnsConfirm,
  confirmThroughProvider,
} from '../../features/tls/http-issuance/dns-relay.ts'
import { denoDnsLookup, txtVisibleOnAll } from './ingress/dns01/preflight.ts'

export const confirmOnNameservers: DnsConfirm = async (input) => {
  const servers = (await input.dns.nameservers?.(input.zoneId)) ?? []
  if (servers.length === 0) return await confirmThroughProvider(input)
  return (await txtVisibleOnAll(denoDnsLookup, servers, input.name, input.value)).ok
}
