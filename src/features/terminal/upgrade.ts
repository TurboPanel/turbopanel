/**
 * The checks a browser's terminal socket upgrade must pass before it reaches
 * the cell, shared by the Workers route and the self-hosted hub.
 *
 * A browser cannot send an `Authorization` header on a WebSocket, and a cookie
 * would let any page that can reach the panel open a socket (cross-site
 * WebSocket hijacking). So the upgrade carries two things: an `Origin` the
 * panel trusts (its own origin or a configured UI origin) and the one-time
 * ticket from `POST .../terminal-sessions` in `Sec-WebSocket-Protocol`.
 */
import { isShellSid } from '../../contracts/shell-relay.ts'
import type { DerivedSecretsConfig } from '../../lib/secrets/secrets.ts'
import { type ShellTicketClaims, ticketFromProtocolHeader, verifyShellTicket } from './ticket.ts'

/** The request's own origin and the configured UI origins are the only trusted `Origin` values. */
export function isAllowedShellOrigin(
  origin: string | null | undefined,
  requestUrl: string,
  configuredOrigins: readonly string[]
): boolean {
  if (!origin) return false
  let parsed: URL
  let request: URL
  try {
    parsed = new URL(origin)
    request = new URL(requestUrl)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false
  if (parsed.origin === 'null') return false
  if (configuredOrigins.includes(parsed.origin)) return true
  return parsed.host === request.host
}

export type ShellUpgradeVerdict =
  { ok: true; claims: ShellTicketClaims } | { ok: false; status: 400 | 401 | 403 }

export async function authenticateShellUpgrade(input: {
  sid: string
  origin: string | null | undefined
  protocolHeader: string | null | undefined
  requestUrl: string
  configuredOrigins: readonly string[]
  keyring: DerivedSecretsConfig
  nowMs?: number
}): Promise<ShellUpgradeVerdict> {
  const sid = input.sid.toLowerCase()
  if (!isShellSid(sid)) return { ok: false, status: 400 }
  if (!isAllowedShellOrigin(input.origin, input.requestUrl, input.configuredOrigins)) {
    return { ok: false, status: 403 }
  }
  const ticket = ticketFromProtocolHeader(input.protocolHeader)
  if (!ticket) return { ok: false, status: 401 }
  const verdict = await verifyShellTicket(input.keyring, ticket, input.nowMs)
  if (!verdict.ok) return { ok: false, status: 401 }
  if (verdict.claims.sid !== sid) return { ok: false, status: 403 }
  return { ok: true, claims: verdict.claims }
}
