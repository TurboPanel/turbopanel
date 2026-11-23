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

/** True for `/api` and everything under it: the paths that answer in the envelope. */
export function isApiPath(path: string): boolean {
  return path === '/api' || path.startsWith('/api/')
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
 *
 * Other paths (the web shell, `/webhook/*`, `/ws/*`) keep their earlier
 * answers: Hono's own response for an `HTTPException`, a JSON 404 for a bad
 * id, and the text "Internal Server Error" for anything else.
 */
export function registerInvalidIdErrorHandler(app: Hono<AppEnv>): void {
  app.onError((err, c) => {
    if (err instanceof ApiError) {
      return c.json(apiErrorBody(err.code, err.explicitMessage, err.details), err.status)
    }
    const api = isApiPath(c.req.path)
    if (err instanceof HTTPException) {
      if (err.res || !api) return err.getResponse()
      const status = err.status as ContentfulStatusCode
      return apiError(c, status, codeForStatus(status), err.message || undefined)
    }
    if (isInvalidUuidError(err)) {
      return api ? apiError(c, 404, 'not_found', 'Not found') : c.json({ error: 'Not found' }, 404)
    }
    logError('app', 'unhandled error', err)
    return api ? apiError(c, 500, 'internal_error') : c.text('Internal Server Error', 500)
  })
  registerApiNotFound(app)
}

/**
 * Unmatched `/api/*` paths answer in the envelope; other paths keep Hono's
 * default so the web shell and static files behave as before. Hono hands a
 * sub-app's `onError` to its routes but not its `notFound`, so the Workers
 * entry (which mounts the app under a per-request app) calls this too.
 */
export function registerApiNotFound(app: Hono<AppEnv>): void {
  app.notFound((c) => {
    if (isApiPath(c.req.path)) return apiError(c, 404, 'not_found', 'Not found')
    return c.text('404 Not Found', 404)
  })
}
