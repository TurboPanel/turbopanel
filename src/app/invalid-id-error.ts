import type { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { AppEnv } from './app.ts'
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

/**
 * Last-resort handler: a path or body id that is not a UUID answers 404 (the
 * resource cannot exist) instead of a 500. Everything else keeps Hono's
 * default behavior (HTTPException responses pass through, others are logged
 * and answer 500).
 */
export function registerInvalidIdErrorHandler(app: Hono<AppEnv>): void {
  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse()
    if (isInvalidUuidError(err)) return c.json({ error: 'Not found' }, 404)
    logError('app', 'unhandled error', err)
    return c.text('Internal Server Error', 500)
  })
}
