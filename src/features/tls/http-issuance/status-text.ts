/**
 * The one-line-per-server status the Certificate panel shows while a
 * server-placed order runs. Plain sentences, never a raw error, never a word
 * that suggests the key was exposed.
 */
import type { HttpIssuanceState, RosterEntry } from './state.ts'

export type ServerStatusLine = { serverId: string; text: string }

/** `: reason` when there is one, else a full stop. */
function reasonSuffix(reason: string | null | undefined): string {
  return reason ? `: ${reason}` : '.'
}

function skippedLine(entry: RosterEntry): string {
  if (entry.skip === 'offline') {
    return `${entry.label} is offline. It will get the certificate when it is back.`
  }
  if (entry.skip === 'no_dns_orders') {
    return `${entry.label} needs a newer TurboPanel version to order this kind of certificate. It will get the certificate once it is installed.`
  }
  return `${entry.label} is not in this name's DNS records, so it did not take part in the check. It has the certificate installed and will use it if you add it to DNS.`
}

function helperLine(entry: RosterEntry, state: HttpIssuanceState, issuerLabel: string): string {
  const forward = state.forwards.find((f) => f.serverId === entry.serverId)
  if (forward?.outcome === 'ready')
    return `${entry.label} passed the check along to ${issuerLabel}.`
  if (forward?.outcome === 'failed') {
    return `${entry.label} could not pass the check along${reasonSuffix(forward.reason)}`
  }
  if (forward?.outcome === 'skipped') {
    return `${entry.label} did not answer in time and was left out of this attempt.`
  }
  return `${entry.label} is getting ready to pass the check along to ${issuerLabel}.`
}

function issuerLine(entry: RosterEntry, state: HttpIssuanceState): string {
  if (state.phase === 'issued') return `${entry.label} answered the check.`
  if (state.phase === 'failed') {
    return `${entry.label} could not finish the order${reasonSuffix(state.lastError)}`
  }
  if (state.challenge === 'dns-01' && state.phase === 'ordering') {
    return `${entry.label} is ordering the certificate. The panel adds the DNS records it needs.`
  }
  return state.phase === 'ordering'
    ? `${entry.label} is ordering the certificate.`
    : `${entry.label} will order the certificate once the other servers are ready.`
}

/** One line for each server in the request's roster, in the roster's order. */
export function serverStatusLines(state: HttpIssuanceState): ServerStatusLine[] {
  const issuer = state.roster.find((e) => e.role === 'issuer')
  const issuerLabel = issuer?.label ?? 'the issuing server'
  const lineFor = (entry: RosterEntry): string => {
    if (entry.role === 'issuer') return issuerLine(entry, state)
    if (entry.role === 'helper') return helperLine(entry, state, issuerLabel)
    return skippedLine(entry)
  }
  return state.roster.map((entry) => ({ serverId: entry.serverId, text: lineFor(entry) }))
}

/** What the Certificate panel says when no server can take the order yet. */
export function waitingText(
  reason: 'no_servers' | 'none_in_dns' | 'no_contact' | 'none_take_dns' | 'no_site'
): string {
  if (reason === 'none_take_dns') {
    return 'Waiting for an online server with a version that can order this kind of certificate.'
  }
  if (reason === 'no_site') return 'Waiting for a site to use this certificate.'
  if (reason === 'no_servers') return 'Waiting for a server to serve this name.'
  if (reason === 'no_contact') {
    return 'Waiting for a contact email address for certificates to be set for this organization.'
  }
  return 'Waiting for a server that DNS points at to come online.'
}
