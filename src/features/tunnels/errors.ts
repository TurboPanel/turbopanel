import { clip, scrubSecrets } from './scrub.ts'

export type TunnelErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'rate_limited'
  | 'provider_error'
  | 'unreachable'
  | 'unsupported'

/**
 * A failure talking to a tunnel provider. The message is scrubbed on
 * construction, so it is safe to log, audit, store and return.
 */
export class TunnelProviderError extends Error {
  readonly code: TunnelErrorCode
  readonly status: number | null

  constructor(
    code: TunnelErrorCode,
    message: string,
    status: number | null,
    secrets: string[] = []
  ) {
    super(clip(scrubSecrets(message, secrets)))
    this.name = 'TunnelProviderError'
    this.code = code
    this.status = status
  }
}

export function codeForStatus(status: number): TunnelErrorCode {
  if (status === 401) return 'unauthorized'
  if (status === 403) return 'forbidden'
  if (status === 404) return 'not_found'
  if (status === 429) return 'rate_limited'
  return 'provider_error'
}
