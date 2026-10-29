/**
 * Back-off for origin certificate work that fails. A row that cannot be
 * renewed (or revoked) waits before the sweep touches it again: one hour after
 * the first failure, doubling up to a day, cleared by the next success. When
 * the provider says how long to wait (`Retry-After` on a 429 or 503) that time
 * is used as is and every row of the same API token pauses with it.
 *
 * The state sits beside the provider link in the row's private metadata
 * (`originRetry`), not inside it, so rebuilding the link never drops it, and
 * the public row never copies it. No table and no migration.
 */
import { eq, sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { tls } from '../../db/schema.ts'
import { TunnelProviderError } from './errors.ts'

export const ORIGIN_RETRY_KEY = 'originRetry'
const HOUR_MS = 3_600_000
/** Longest wait between tries on a row that keeps failing. */
export const ORIGIN_RETRY_MAX_MS = 24 * HOUR_MS
/** A provider that says "retry after 0" is still not asked again inside a minute. */
const MIN_PAUSE_MS = 60_000

export type OriginRetry = { attempts: number; nextTryAt: string | null }

const NO_RETRY: OriginRetry = { attempts: 0, nextTryAt: null }

export function readOriginRetry(metadata: unknown): OriginRetry {
  const raw =
    typeof metadata === 'object' && metadata !== null
      ? (metadata as Record<string, unknown>)[ORIGIN_RETRY_KEY]
      : null
  if (typeof raw !== 'object' || raw === null) return NO_RETRY
  const r = raw as Record<string, unknown>
  const attempts = typeof r.attempts === 'number' && r.attempts > 0 ? Math.floor(r.attempts) : 0
  const at = typeof r.nextTryAt === 'string' && !Number.isNaN(Date.parse(r.nextTryAt))
  return { attempts, nextTryAt: at ? (r.nextTryAt as string) : null }
}

/** Is the row still waiting out an earlier failure or a provider pause? */
export function originRetryWaiting(metadata: unknown, now: Date): boolean {
  const { nextTryAt } = readOriginRetry(metadata)
  return nextTryAt !== null && Date.parse(nextTryAt) > now.getTime()
}

/** The provider asked callers to slow down and said for how long. */
export function throttleWait(err: unknown): number | null {
  return err instanceof TunnelProviderError ? err.retryAfterMs : null
}

/** What to remember after a failure: the provider's own wait, or the doubling hour-to-day back-off. */
export function nextOriginRetry(previous: OriginRetry, err: unknown, now: Date): OriginRetry {
  const asked = throttleWait(err)
  if (asked !== null) {
    const until = now.getTime() + Math.max(asked, MIN_PAUSE_MS)
    return { attempts: previous.attempts, nextTryAt: new Date(until).toISOString() }
  }
  const attempts = previous.attempts + 1
  const wait = Math.min(2 ** (attempts - 1) * HOUR_MS, ORIGIN_RETRY_MAX_MS)
  return { attempts, nextTryAt: new Date(now.getTime() + wait).toISOString() }
}

/** Write (or with null clear) a row's back-off, leaving the rest of its metadata alone. */
export async function saveOriginRetry(db: Db, id: string, retry: OriginRetry | null) {
  await db
    .update(tls)
    .set({
      metadata:
        retry === null
          ? sql`${tls.metadata} - ${ORIGIN_RETRY_KEY}::text`
          : sql`jsonb_set(coalesce(${tls.metadata}, '{}'::jsonb), ${`{${ORIGIN_RETRY_KEY}}`}::text[], ${JSON.stringify(retry)}::jsonb)`,
    })
    .where(eq(tls.id, id))
}

/** Hold a row off until `until`, keeping a later time it already waits for. */
export async function pauseOriginRow(db: Db, row: { id: string; metadata: unknown }, until: Date) {
  const current = readOriginRetry(row.metadata)
  const later = current.nextTryAt !== null && Date.parse(current.nextTryAt) > until.getTime()
  if (later) return
  await saveOriginRetry(db, row.id, { attempts: current.attempts, nextTryAt: until.toISOString() })
}
