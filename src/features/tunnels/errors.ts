import { clip, scrubSecrets } from './scrub.ts'

export type TunnelErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'provider_error'
  | 'unreachable'
  | 'unsupported'
  | 'zone_not_found'
  /** What was sent is not an API token at all; the message says so in plain words. */
  | 'token_format'

/**
 * A failure talking to a tunnel provider. The message is scrubbed on
 * construction, so it is safe to log, audit, store and return.
 */
export class TunnelProviderError extends Error {
  readonly code: TunnelErrorCode
  readonly status: number | null
  /** How long the provider asked callers to wait (429 or 503 with `Retry-After`); null when it did not say. */
  readonly retryAfterMs: number | null

  constructor(
    code: TunnelErrorCode,
    message: string,
    status: number | null,
    secrets: string[] = [],
    retryAfterMs: number | null = null
  ) {
    super(clip(scrubSecrets(message, secrets)))
    this.name = 'TunnelProviderError'
    this.code = code
    this.status = status
    this.retryAfterMs = retryAfterMs
  }
}

/**
 * Cloudflare answers a tunnel delete with 400 (not 409) while a connector is
 * still connected, so the wording is what tells that case apart.
 */
const ACTIVE_CONNECTIONS = /\bactive connections?\b/i

/** The code for a refused request: its status, or `conflict` for a tunnel that still has connectors. */
export function codeForRefusal(status: number, detail: string): TunnelErrorCode {
  if (ACTIVE_CONNECTIONS.test(detail)) return 'conflict'
  return codeForStatus(status)
}

export function codeForStatus(status: number): TunnelErrorCode {
  if (status === 401) return 'unauthorized'
  if (status === 403) return 'forbidden'
  if (status === 404) return 'not_found'
  if (status === 409) return 'conflict'
  if (status === 429) return 'rate_limited'
  return 'provider_error'
}

/**
 * The name already has address records (A, AAAA or CNAME) that the person has
 * not agreed to replace. Carries what they are, so the screen can show them.
 */
export class DnsNameTaken extends Error {
  readonly hostname: string
  readonly records: readonly { id: string; type: string; content: string; proxied: boolean }[]

  constructor(
    hostname: string,
    records: readonly { id: string; type: string; content: string; proxied: boolean }[]
  ) {
    super(dnsNameTakenMessage(hostname, records))
    this.name = 'DnsNameTaken'
    this.hostname = hostname
    this.records = records
  }
}

/** "A DNS record for a.example.com already exists: A 203.0.113.4 (proxied). …" */
export function dnsNameTakenMessage(
  hostname: string,
  records: readonly { type: string; content: string; proxied: boolean }[]
): string {
  const listed = records
    .map((r) => `${r.type} ${clip(r.content, 100)}${r.proxied ? ' (proxied)' : ''}`)
    .join(', ')
  const which = records.length === 1 ? 'A DNS record' : 'DNS records'
  const it = records.length === 1 ? 'it' : 'them'
  return `${which} for ${hostname} already exist${records.length === 1 ? 's' : ''}: ${listed}. Replace ${it} to point the name at this Tunnel, or remove ${it} at your DNS provider first.`
}

/**
 * A confirmed replacement that did not finish: some of the name's records were
 * already deleted when a later step failed. Carries what was removed, so it is
 * kept on record (the audit) and can be put back by hand.
 */
export class DnsReplaceIncomplete extends Error {
  readonly hostname: string
  readonly removed: readonly { type: string; content: string; proxied: boolean }[]

  constructor(
    hostname: string,
    removed: readonly { type: string; content: string; proxied: boolean }[],
    cause: string
  ) {
    const listed = removed.map((r) => `${r.type} ${clip(r.content, 100)}`).join(', ')
    super(
      clip(
        `The DNS records for ${hostname} were only partly replaced: ${cause}. Already removed: ${listed}. Add them back at your DNS provider if the name still needs them.`,
        600
      )
    )
    this.name = 'DnsReplaceIncomplete'
    this.hostname = hostname
    this.removed = removed
  }
}
