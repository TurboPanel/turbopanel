/**
 * Why a name set to "Cloudflare Origin Certificate" has no certificate yet.
 *
 * Issuing runs outside the save that chose it (a provider call can fail or be
 * refused), so a name that could not get its certificate carries a reason the
 * panel shows instead of waiting in silence. The reasons sit on the hosting's
 * private `metadata` under {@link NAME_ORIGIN_ISSUES_KEY}, one entry per
 * hostname, with the attempt count and the earliest time the scheduled retry
 * tries again. No table and no migration. An entry is removed as soon as the
 * name is pinned or no longer asks for the origin certificate.
 */
import { eq, sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { hosting } from '../../db/schema.ts'

export const NAME_ORIGIN_ISSUES_KEY = 'nameOriginIssues'
const NAME_ORIGIN_ISSUES_PATH = `{${NAME_ORIGIN_ISSUES_KEY}}`

/** What went wrong; `no_badge` is "no API token can certify the zone", the rest are the issuing code's refusals. */
export type NameOriginIssueCode =
  | 'no_badge'
  | 'provider_error'
  | 'unsupported_provider'
  | 'zone_not_covered'
  | 'secrets_unavailable'
  | 'badge_cannot_certify'
  | 'origin_certificate_limit'
  | 'origin_certificate_names'

export type NameOriginIssue = {
  code: NameOriginIssueCode
  /** Plain words, scrubbed of secrets; safe to show. */
  message: string
  failedAt: string
  attempts: number
  /** The earliest time the scheduled retry tries again; null when it may try on the next pass. */
  nextTryAt: string | null
}

export type NameOriginIssues = Record<string, NameOriginIssue>

const CODES: ReadonlySet<string> = new Set<NameOriginIssueCode>([
  'no_badge',
  'provider_error',
  'unsupported_provider',
  'zone_not_covered',
  'secrets_unavailable',
  'badge_cannot_certify',
  'origin_certificate_limit',
  'origin_certificate_names',
])

function readIssue(raw: unknown): NameOriginIssue | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (typeof r.code !== 'string' || !CODES.has(r.code)) return null
  if (typeof r.message !== 'string' || typeof r.failedAt !== 'string') return null
  const attempts = typeof r.attempts === 'number' && r.attempts > 0 ? Math.floor(r.attempts) : 1
  const next =
    typeof r.nextTryAt === 'string' && !Number.isNaN(Date.parse(r.nextTryAt)) ? r.nextTryAt : null
  return {
    code: r.code as NameOriginIssueCode,
    message: r.message,
    failedAt: r.failedAt,
    attempts,
    nextTryAt: next,
  }
}

/** The recorded reasons of a hosting's `metadata`, keyed by lower-case hostname. Malformed entries are dropped. */
export function readNameOriginIssues(metadata: unknown): NameOriginIssues {
  if (typeof metadata !== 'object' || metadata === null) return {}
  const raw = (metadata as Record<string, unknown>)[NAME_ORIGIN_ISSUES_KEY]
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const out: NameOriginIssues = {}
  for (const [name, value] of Object.entries(raw)) {
    const issue = readIssue(value)
    if (issue) out[name] = issue
  }
  return out
}

/** Is the name still waiting out an earlier failure at `now`? */
export function nameOriginIssueWaiting(issue: NameOriginIssue | undefined, now: Date): boolean {
  return issue?.nextTryAt != null && Date.parse(issue.nextTryAt) > now.getTime()
}

/**
 * Store the reasons (an empty map removes the key), leaving the rest of the
 * metadata alone. `updatedAt` stays as it was: a reason is not an edit of the
 * site, and the certificate apply compares that time with the last deploy.
 */
export async function saveNameOriginIssues(
  db: Db,
  hostingId: string,
  issues: NameOriginIssues
): Promise<void> {
  const metadata =
    Object.keys(issues).length === 0
      ? sql`${hosting.metadata} - ${NAME_ORIGIN_ISSUES_KEY}::text`
      : sql`jsonb_set(coalesce(${hosting.metadata}, '{}'::jsonb), ${NAME_ORIGIN_ISSUES_PATH}::text[], ${JSON.stringify(issues)}::jsonb)`
  await db
    .update(hosting)
    .set({ metadata, updatedAt: sql`${hosting.updatedAt}` })
    .where(eq(hosting.id, hostingId))
}
