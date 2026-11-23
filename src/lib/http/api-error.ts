import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { API_ERROR_CODES, type ApiErrorCode } from './error-codes.ts'

/**
 * The one JSON body every `/api/*` error answers with:
 *
 * - `code`: stable machine string from `API_ERROR_CODES`; clients branch on it.
 * - `message`: human text; may change, never branch on it.
 * - `details`: optional structured context for the code.
 * - `error`: the same text as `message` (or the code when the caller gave no
 *   text), kept because the web interface and the daemon still read it.
 * - `ok: false`: kept because the admin, install and daemon surfaces always
 *   sent it.
 */
export type ApiErrorBody = {
  ok: false
  error: string
  code: ApiErrorCode
  message: string
  details?: unknown
}

export function apiErrorBody(
  code: ApiErrorCode,
  message?: string,
  details?: unknown
): ApiErrorBody {
  const body: ApiErrorBody = {
    ok: false,
    error: message ?? code,
    code,
    message: message ?? API_ERROR_CODES[code],
  }
  if (details !== undefined) body.details = details
  return body
}

/** Answer an error in the envelope. The status is the caller's, as before. */
export function apiError(
  c: Context,
  status: ContentfulStatusCode,
  code: ApiErrorCode,
  message?: string,
  details?: unknown,
  headers?: Record<string, string>
): Response {
  return c.json(apiErrorBody(code, message, details), status, headers)
}

/** Throw from a handler or helper; the app-level handler answers it. */
export class ApiError extends Error {
  readonly status: ContentfulStatusCode
  readonly code: ApiErrorCode
  readonly details?: unknown
  /** The text the caller passed, if any (the envelope's `error` falls back to the code). */
  readonly explicitMessage?: string

  constructor(
    status: ContentfulStatusCode,
    code: ApiErrorCode,
    message?: string,
    details?: unknown
  ) {
    super(message ?? API_ERROR_CODES[code])
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.details = details
    this.explicitMessage = message
  }
}
