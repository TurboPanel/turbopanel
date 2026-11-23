import type { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { AppEnv } from './app.ts'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { ApiError, apiError, apiErrorBody } from '../lib/http/api-error.ts'
import type { ApiErrorCode } from '../lib/http/error-codes.ts'
import { logError } from '../lib/logger.ts'

/** SQLSTATE `invalid_text_representation`: "invalid input syntax for type uuid". */
const PG_INVALID_TEXT_REPRESENTATION = '22P02'
const MAX_CAUSE_DEPTH = 4

/**
 * True when `err` (or a `.cause` beneath it — drizzle 0.45 wraps driver errors
 * in `DrizzleQueryError`) is Postgres refusing a non-UUID string for a uuid
 * column or `::uuid` cast. That is a bad id in the request, not a server fault.
 */
export function isInvalidUuidError(err: unknown): boolean {
  let current: unknown = err
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== 'object' || current === null) return false
    const { code, message, cause } = current as {
      code?: unknown
      message?: unknown
      cause?: unknown
    }
    if (
      code === PG_INVALID_TEXT_REPRESENTATION &&
      typeof message === 'string' &&
      message.includes('type uuid')
    ) {
      return true
    }
    current = cause
  }
  return false
}

/** The code a thrown `HTTPException` answers with, by status. */
function codeForStatus(status: number): ApiErrorCode {
  switch (status) {
    case 400:
      return 'invalid_request'
    case 401:
      return 'unauthorized'
    case 403:
      return 'forbidden'
    case 404:
      return 'not_found'
    case 409:
      return 'conflict'
    case 413:
      return 'request_body_too_large'
    case 429:
      return 'rate_limited'
    default:
      return status >= 500 ? 'internal_error' : 'http_error'
  }
}

/**
 * The app-level error handler. Every `/api/*` error leaves in the envelope
 * (`src/lib/http/api-error.ts`):
 *
 * - a thrown `ApiError` answers with its own status and code;
 * - a thrown `HTTPException` that carries its own response passes through,
 *   one without answers in the envelope with a code for its status;
 * - a path or body id that is not a UUID answers 404 (the resource cannot
 *   exist) instead of a 500;
 * - anything else is logged and answers a JSON 500 that does not leak the
 *   error text.
 */
export function registerInvalidIdErrorHandler(app: Hono<AppEnv>): void {
  app.onError((err, c) => {
    if (err instanceof ApiError) {
      return c.json(apiErrorBody(err.code, err.explicitMessage, err.details), err.status)
    }
    if (err instanceof HTTPException) {
      if (err.res) return err.getResponse()
      const status = err.status as ContentfulStatusCode
      return apiError(c, status, codeForStatus(status), err.message || undefined)
    }
    if (isInvalidUuidError(err)) return apiError(c, 404, 'not_found', 'Not found')
    logError('app', 'unhandled error', err)
    return apiError(c, 500, 'internal_error')
  })
  // Unmatched `/api/*` paths answer in the envelope too; other paths keep
  // Hono's default so the web shell and static files behave as before.
  app.notFound((c) => {
    if (c.req.path === '/api' || c.req.path.startsWith('/api/')) {
      return apiError(c, 404, 'not_found', 'Not found')
    }
    return c.text('404 Not Found', 404)
  })
}
