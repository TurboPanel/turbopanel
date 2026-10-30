/**
 * Which serving servers take part in one certificate order, and what each one
 * is told. Pure: the caller gathers who is online, which daemons list the
 * feature, each server's known public addresses and the addresses the name's
 * DNS answers with.
 *
 * Rule: only a server that is online, runs a daemon with the feature and is in
 * the name's DNS takes part. Every other serving server is skipped for the
 * check and receives the finished certificate later. When no serving server
 * has a known public address at all, every online server with the feature
 * counts as in DNS (the strict, safe reading).
 */

export type ServingServer = {
  serverId: string
  /** The name shown to people in status lines. */
  label: string
  online: boolean
  /** Its daemon lists `acme-issue-v1`. */
  hasFeature: boolean
  /** Public addresses the server is known by (canonical form). */
  addresses: readonly string[]
}

export type SkipReason = 'offline' | 'not_in_dns' | 'old_daemon'

export type Participants = {
  issuer: ServingServer
  /** Other servers that pass the proof path on, each with the address DNS knows it by. */
  helpers: Array<{ server: ServingServer; address: string }>
  /** The address helpers pass the proof path to: the issuing server's own address in DNS. */
  issuerAddress: string
  skipped: Array<{ server: ServingServer; reason: SkipReason }>
}

export type Choice =
  | ({ ok: true } & Participants)
  | { ok: false; reason: 'no_servers' | 'none_in_dns'; skipped: Participants['skipped'] }

function addressInDns(server: ServingServer, dns: ReadonlySet<string>): string | null {
  return server.addresses.find((a) => dns.has(a)) ?? null
}

export function chooseParticipants(params: {
  servers: readonly ServingServer[]
  /** The A and AAAA answers for the name, canonical form. */
  dnsAddresses: readonly string[]
  /** The server that issued the last certificate; kept when it still qualifies. */
  previousIssuerId?: string | null
  /** The server that failed the last attempt; another one is preferred. */
  avoidServerId?: string | null
}): Choice {
  const dns = new Set(params.dnsAddresses)
  const anyKnown = params.servers.some((s) => s.addresses.length > 0)
  const skipped: Participants['skipped'] = []
  const eligible: Array<{ server: ServingServer; address: string }> = []
  const ordered = [...params.servers].sort((a, b) =>
    a.serverId < b.serverId ? -1 : a.serverId > b.serverId ? 1 : 0
  )
  for (const server of ordered) {
    if (!server.online) skipped.push({ server, reason: 'offline' })
    else if (!server.hasFeature) skipped.push({ server, reason: 'old_daemon' })
    else {
      const address = addressInDns(server, dns)
      if (address !== null) eligible.push({ server, address })
      else if (!anyKnown && server.addresses.length === 0 && dns.size > 0) {
        eligible.push({ server, address: [...dns][0] })
      } else skipped.push({ server, reason: 'not_in_dns' })
    }
  }
  if (params.servers.length === 0) return { ok: false, reason: 'no_servers', skipped }
  if (eligible.length === 0) return { ok: false, reason: 'none_in_dns', skipped }

  const rank = (id: string): number => {
    if (id === params.avoidServerId && eligible.length > 1) return 2
    return id === params.previousIssuerId ? 0 : 1
  }
  const sorted = [...eligible].sort((a, b) => rank(a.server.serverId) - rank(b.server.serverId))
  const [first, ...rest] = sorted
  return {
    ok: true,
    issuer: first.server,
    issuerAddress: first.address,
    helpers: rest.map((r) => ({ server: r.server, address: r.address })),
    skipped,
  }
}
