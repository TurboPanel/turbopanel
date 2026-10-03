/**
 * Step-up re-authentication for permanent actions, switched on per
 * organization (`organization.options.requireReauthForDestructive`, owner-only,
 * default off).
 *
 * Model: a successful `POST /auth/reauth` writes one `verification` row,
 * `reauth:<sessionId>`, expiring {@link STEP_UP_WINDOW_MS} later. It is keyed on
 * the session (never the user), so a second device or a stolen cookie for
 * another session gets nothing from it, and it lapses on its own. No session
 * column and no table. A session that signed in within the same window counts
 * as just re-authenticated, so nobody is asked straight after signing in.
 *
 * The routes in `step-up-actions.ts` call {@link requireStepUpIfConfigured}.
 */
import { and, eq } from 'drizzle-orm'
import type { Context } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import { type Db, getDb } from '../../db/connection.ts'
import { account, organization, verification } from '../../db/schema.ts'
import {
  parseOrganizationOptions,
  resolveRequireReauthForDestructive,
} from '../../features/organizations/organization-options.ts'
import type { StepUpAction } from './step-up-actions.ts'
import type { SessionData } from './session-store.ts'
import { getTwoFactorStatus } from './two-factor.ts'

/** How long one re-authentication keeps permanent actions unlocked. */
export const STEP_UP_WINDOW_MS = 5 * 60 * 1000

/**
 * How a person can prove themselves right now. `totp` replaces `password` when
 * an authenticator is enrolled (the password alone would be weaker than their
 * sign-in); `signin` means neither exists (passkey / OAuth only): sign in again.
 */
export type StepUpMethod = 'password' | 'totp' | 'signin'

export function stepUpIdentifier(sessionId: string): string {
  return `reauth:${sessionId}`
}

function isWithinWindow(startedAt: string | undefined, nowMs: number): boolean {
  if (!startedAt) return false
  const ageMs = nowMs - Date.parse(startedAt)
  return Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= STEP_UP_WINDOW_MS
}

/** Record that this session just re-authenticated. */
export async function stampStepUp(
  db: Db,
  sessionId: string,
  method: StepUpMethod,
  nowMs: number = Date.now()
): Promise<void> {
  const expiresAt = new Date(nowMs + STEP_UP_WINDOW_MS).toISOString()
  await db
    .insert(verification)
    .values({ identifier: stepUpIdentifier(sessionId), value: method, expiresAt })
    .onConflictDoUpdate({
      target: verification.identifier,
      set: { value: method, expiresAt, updatedAt: new Date(nowMs).toISOString() },
    })
}

/** Did this session re-authenticate (or sign in) inside the window? */
export async function hasRecentStepUp(
  db: Db,
  session: Pick<SessionData, 'sessionId' | 'createdAt'>,
  nowMs: number = Date.now()
): Promise<boolean> {
  if (isWithinWindow(session.createdAt, nowMs)) return true
  const [row] = await db
    .select({ expiresAt: verification.expiresAt })
    .from(verification)
    .where(eq(verification.identifier, stepUpIdentifier(session.sessionId)))
    .limit(1)
  return row !== undefined && Date.parse(row.expiresAt) > nowMs
}

/** The stored password hash of a credential account, or `null` when there is none. */
export async function loadCredentialPasswordHash(db: Db, userId: string): Promise<string | null> {
  const [credential] = await db
    .select({ password: account.password })
    .from(account)
    .where(and(eq(account.userId, userId), eq(account.providerId, 'credential')))
    .limit(1)
  return credential?.password || null
}

/** The ways this person can re-authenticate (see {@link StepUpMethod}). */
export async function listStepUpMethods(db: Db, userId: string): Promise<StepUpMethod[]> {
  const status = await getTwoFactorStatus(db, userId)
  if (status.enabled) return ['totp']
  return (await loadCredentialPasswordHash(db, userId)) ? ['password'] : ['signin']
}

/** Is the step-up gate on for this organization? */
export async function isStepUpRequired(db: Db, organizationId: string): Promise<boolean> {
  const [row] = await db
    .select({ options: organization.options })
    .from(organization)
    .where(eq(organization.id, organizationId))
    .limit(1)
  return resolveRequireReauthForDestructive(parseOrganizationOptions(row?.options))
}

/**
 * Gate a permanent action. Returns `null` to carry on (gate off, or the session
 * re-authenticated recently), a 401 without a session, otherwise 403
 * `reauth_required` naming the action and the ways to re-authenticate. Call it
 * after the route's permission check and before any change.
 */
export async function requireStepUpIfConfigured(
  c: Context<AppEnv>,
  organizationId: string,
  action: StepUpAction
): Promise<Response | null> {
  const db = getDb(c)
  if (!db) return c.json({ error: 'Database unavailable' }, 503)
  const session = c.get('session')
  if (!session) return c.json({ error: 'Unauthorized' }, 401)

  if (!(await isStepUpRequired(db, organizationId))) return null
  if (await hasRecentStepUp(db, session)) return null

  const methods = await listStepUpMethods(db, session.userId)
  return c.json(
    {
      ok: false,
      error: 'reauth_required',
      code: 'reauth_required',
      action,
      methods,
      windowSeconds: STEP_UP_WINDOW_MS / 1000,
    },
    403
  )
}

/** Same gate under its plain name. */
export const requireStepUp = requireStepUpIfConfigured
