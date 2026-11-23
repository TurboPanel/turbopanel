/**
 * The one-time ticket a browser presents to open its terminal socket.
 *
 * A browser WebSocket cannot set headers and a cookie must not carry the
 * session onto the relay, so `POST .../terminal-sessions` hands out a short
 * signed ticket that the browser sends in `Sec-WebSocket-Protocol`
 * (`tp-shell.v1, tp-ticket.<ticket>`). The ticket names one session, one user
 * and the auth session that opened it, and is good for 30 seconds.
 *
 * It is a stateless HMAC envelope, `tpshell.v<n>.<payload>.<signature>`, signed
 * with the `shell-ticket` keyring. Single use is enforced by the cell: the
 * pending open it holds for `sid` is taken by the first socket that arrives, so
 * a replayed ticket finds nothing (`410`). The ticket carries no secret: the
 * session key never passes through the control plane in the clear.
 *
 * Pure Web Crypto, no I/O at module load: shared by the Workers route and the
 * self-hosted hub.
 */
import { base64urlDecode, base64urlEncode } from '../../lib/encoding/base64url.ts'
import { type DerivedSecretsConfig, findKeyForVersion } from '../../lib/secrets/secrets.ts'

export const SHELL_TICKET_PURPOSE = 'shell-ticket'
export const SHELL_TICKET_TTL_MS = 30_000

const SCHEME = 'tpshell'
const encoder = new TextEncoder()
const decoder = new TextDecoder()

export type ShellTicketClaims = {
  sid: string
  userId: string
  authSessionId: string
  serverId: string
  orgId: string
}

type Payload = ShellTicketClaims & { exp: number }

export async function signShellTicket(
  keyring: DerivedSecretsConfig,
  claims: ShellTicketClaims,
  nowMs: number = Date.now()
): Promise<{ ticket: string; expiresAtMs: number }> {
  const expiresAtMs = nowMs + SHELL_TICKET_TTL_MS
  const payload: Payload = { ...claims, exp: Math.floor(expiresAtMs / 1000) }
  const encoded = base64urlEncode(encoder.encode(JSON.stringify(payload)))
  const signature = await crypto.subtle.sign('HMAC', keyring.current.key, encoder.encode(encoded))
  return {
    ticket: `${SCHEME}.v${keyring.current.version}.${encoded}.${base64urlEncode(new Uint8Array(signature))}`,
    expiresAtMs,
  }
}

export type ShellTicketVerdict =
  { ok: true; claims: ShellTicketClaims } | { ok: false; reason: 'invalid' | 'expired' }

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

export async function verifyShellTicket(
  keyring: DerivedSecretsConfig,
  ticket: string,
  nowMs: number = Date.now()
): Promise<ShellTicketVerdict> {
  const parts = ticket.split('.')
  if (parts.length !== 4 || parts[0] !== SCHEME) return { ok: false, reason: 'invalid' }
  const [, versionText, encoded, encodedSignature] = parts
  const match = /^v(\d{1,9})$/.exec(versionText!)
  if (!match) return { ok: false, reason: 'invalid' }
  const key = findKeyForVersion(keyring, Number(match[1]))
  if (!key) return { ok: false, reason: 'invalid' }
  let payload: Partial<Payload>
  try {
    const signature = base64urlDecode(encodedSignature!)
    if (!(await crypto.subtle.verify('HMAC', key, signature, encoder.encode(encoded!)))) {
      return { ok: false, reason: 'invalid' }
    }
    payload = JSON.parse(decoder.decode(base64urlDecode(encoded!))) as Partial<Payload>
  } catch {
    return { ok: false, reason: 'invalid' }
  }
  if (
    !isNonEmptyString(payload.sid) ||
    !isNonEmptyString(payload.userId) ||
    !isNonEmptyString(payload.authSessionId) ||
    !isNonEmptyString(payload.serverId) ||
    !isNonEmptyString(payload.orgId) ||
    typeof payload.exp !== 'number'
  ) {
    return { ok: false, reason: 'invalid' }
  }
  if (payload.exp * 1000 <= nowMs) return { ok: false, reason: 'expired' }
  return {
    ok: true,
    claims: {
      sid: payload.sid,
      userId: payload.userId,
      authSessionId: payload.authSessionId,
      serverId: payload.serverId,
      orgId: payload.orgId,
    },
  }
}

/**
 * The ticket inside a `Sec-WebSocket-Protocol` offer, or null when the offer is
 * not exactly `tp-shell.v1` plus one `tp-ticket.<ticket>`. Any other token, a
 * missing ticket or a second ticket refuses: the offer is the credential.
 */
export function ticketFromProtocolHeader(header: string | null | undefined): string | null {
  if (!header) return null
  const offered = header
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
  if (offered.length !== 2 || !offered.includes('tp-shell.v1')) return null
  const ticketToken = offered.find((part) => part.startsWith('tp-ticket.'))
  if (!ticketToken) return null
  const ticket = ticketToken.slice('tp-ticket.'.length)
  return ticket.length > 0 ? ticket : null
}
