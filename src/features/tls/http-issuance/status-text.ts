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
  switch (entry.skip) {
    case 'offline':
      return `${entry.label} is offline. It will get the certificate when it is back.`
    case 'old_daemon':
      return `${entry.label} runs an older version, so it orders its own certificate until it is updated.`
    default:
      return `${entry.label} is not in this name's DNS records, so it did not take part in the check. It has the certificate installed and will use it if you add it to DNS.`
  }
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
export function waitingText(reason: 'no_servers' | 'none_in_dns' | 'no_contact'): string {
  if (reason === 'no_servers') return 'Waiting for a server to serve this name.'
  if (reason === 'no_contact')
    return "Waiting for a contact email address in the Let's Encrypt settings."
  return 'Waiting for a server that DNS points at to come online.'
}
