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

export function codeForStatus(status: number): TunnelErrorCode {
  if (status === 401) return 'unauthorized'
  if (status === 403) return 'forbidden'
  if (status === 404) return 'not_found'
  if (status === 409) return 'conflict'
  if (status === 429) return 'rate_limited'
  return 'provider_error'
}
