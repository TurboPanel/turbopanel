/**
 * One-click unsubscribe for notification email (RFC 8058).
 *
 * Every personal notification email carries `List-Unsubscribe` with one HTTPS
 * link and `List-Unsubscribe-Post: List-Unsubscribe=One-Click`. The link holds
 * a token, not a stored row: the claims (person, organization, project,
 * category, and the personal channel when it is not the account email) are
 * sealed with the install's data-encryption key (AES-GCM, so the token cannot
 * be forged or altered) behind a fixed domain tag, with an expiry. A POST to
 * the link needs no session and never redirects; it writes one `preference`
 * row with level `none` for email at that scope and category, so the next
 * event in that category is not mailed and the others still are.
 *
 * Workers-bundle safe: Web Crypto only, nothing at module load.
 */
import { and, eq, sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { notificationPreference, teammate, team } from '../../db/schema.ts'
import { decryptSecret, encryptSecret } from '../../lib/secrets/data-encryption.ts'
import type { DerivedSecretsConfig } from '../../lib/secrets/secrets.ts'

/** The client API prefix (`CLIENT_API_PREFIX` in `app/surfaces.ts`; features may not import surfaces). */
const CLIENT_API_PREFIX = '/api/client/v1'

/** Domain tag sealed in front of the claims, so no other sealed value reads as a token. */
const TOKEN_TAG = 'notification-unsubscribe.v1:'

/** How long an unsubscribe link keeps working. */
export const UNSUBSCRIBE_TOKEN_TTL_MS = 60 * 24 * 60 * 60 * 1000

export type UnsubscribeClaims = {
  userId: string
  organizationId: string | null
  projectId: string | null
  categoryCode: string | null
  /** A personal email channel other than the account email; null means every email. */
  channelId: string | null
}

type SealedClaims = {
  u: string
  o: string | null
  p: string | null
  c: string | null
  ch: string | null
  exp: number
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CATEGORY_RE = /^[a-z][a-z_]{1,39}$/

function optionalUuid(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && UUID_RE.test(value))
}

export async function sealUnsubscribeToken(
  secrets: DerivedSecretsConfig,
  claims: UnsubscribeClaims,
  nowMs: number = Date.now()
): Promise<string> {
  const sealed: SealedClaims = {
    u: claims.userId,
    o: claims.organizationId,
    p: claims.projectId,
    c: claims.categoryCode,
    ch: claims.channelId,
    exp: nowMs + UNSUBSCRIBE_TOKEN_TTL_MS,
  }
  return await encryptSecret(secrets, TOKEN_TAG + JSON.stringify(sealed))
}

/** The claims of a genuine, unexpired token; null for anything else. Never throws. */
export async function openUnsubscribeToken(
  secrets: DerivedSecretsConfig,
  token: string,
  nowMs: number = Date.now()
): Promise<UnsubscribeClaims | null> {
  let plain: string
  try {
    plain = await decryptSecret(secrets, token)
  } catch {
    return null
  }
  if (!plain.startsWith(TOKEN_TAG)) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(plain.slice(TOKEN_TAG.length))
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const c = parsed as Partial<SealedClaims>
  if (typeof c.u !== 'string' || !UUID_RE.test(c.u)) return null
  if (!optionalUuid(c.o ?? null) || !optionalUuid(c.p ?? null) || !optionalUuid(c.ch ?? null)) {
    return null
  }
  if (c.c != null && (typeof c.c !== 'string' || !CATEGORY_RE.test(c.c))) return null
  if (typeof c.exp !== 'number' || c.exp <= nowMs) return null
  if (c.p && !c.o) return null
  return {
    userId: c.u,
    organizationId: c.o ?? null,
    projectId: c.p ?? null,
    categoryCode: c.c ?? null,
    channelId: c.ch ?? null,
  }
}

/** The one-click link: the API path, under the public base URL. */
export function unsubscribeUrl(base: string, token: string): string {
  const root = base.endsWith('/') ? base.slice(0, -1) : base
  return `${root}${CLIENT_API_PREFIX}/notification-unsubscribe/${encodeURIComponent(token)}`
}

/** The web interface page a person lands on from the footer link. */
export function unsubscribePageUrl(base: string, token: string): string {
  const root = base.endsWith('/') ? base.slice(0, -1) : base
  return `${root}/account/unsubscribe?token=${encodeURIComponent(token)}`
}

/**
 * Write the `none` row the token asks for. The person must still belong to
 * the organization it names (a former member's link changes nothing, and
 * their rows there are gone already). Idempotent: a second click updates the
 * same row. Returns false when nothing could be written.
 */
export async function applyUnsubscribe(db: Db, claims: UnsubscribeClaims): Promise<boolean> {
  if (claims.organizationId) {
    const [member] = await db
      .select({ id: teammate.id })
      .from(teammate)
      .innerJoin(team, eq(teammate.teamId, team.id))
      .where(
        and(eq(teammate.userId, claims.userId), eq(team.organizationId, claims.organizationId))
      )
      .limit(1)
    if (!member) return false
  }
  try {
    await db
      .insert(notificationPreference)
      .values({
        userId: claims.userId,
        organizationId: claims.organizationId,
        projectId: claims.projectId,
        categoryCode: claims.categoryCode,
        channelId: claims.channelId,
        kind: claims.channelId ? null : 'email',
        level: 'none',
      })
      .onConflictDoUpdate({
        target: [
          notificationPreference.userId,
          notificationPreference.organizationId,
          notificationPreference.projectId,
          notificationPreference.environmentId,
          notificationPreference.serviceId,
          notificationPreference.serverId,
          notificationPreference.destinationId,
          notificationPreference.categoryCode,
          notificationPreference.topicCode,
          notificationPreference.kind,
          notificationPreference.channelId,
        ],
        set: { level: 'none', endsAt: null, updatedAt: sql`now()` },
      })
    return true
  } catch {
    // The project or channel is gone (foreign key): nothing left to stop.
    return false
  }
}
