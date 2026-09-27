/**
 * Invitation landing page (owner decision 2026-09-27). The emailed link opens
 * a console page that never accepts on load:
 *
 *   GET  /auth/invitations/:id
 *     What the page needs to choose a path: the organization, who invited,
 *     the invited email, whether an account already uses that email, and the
 *     invitation's state. Unauthenticated — the id travels only in the email,
 *     so holding it proves the reader controls the invited address.
 *   POST /auth/invitations/:id/sign-up { password }
 *     The invited email has no account yet: create one with that email
 *     (verified — the click proved it), accept the invitation and sign in, in
 *     one step, with no personal organization and no confirm. Refused with
 *     `account_exists` when the email already has an account (the page sends
 *     that person to sign in, then shows the Accept button).
 *
 * The signed-in **Accept invitation** button stays `POST /invitations/:id/accept`.
 */
import { eq } from 'drizzle-orm'
import type { Context, Env, Hono } from 'hono'
import type { Db } from '../../db/connection.ts'
import { getDb } from '../../db/connection.ts'
import { invitation, organization, team, user } from '../../db/schema.ts'
import { hashPassword } from '../../lib/secrets/password.ts'
import { acceptInvitationForUser } from '../access/invitation-accept.ts'
import { invitationAcceptErrorPayload, isUuid } from '../access/routes-helpers.ts'
import {
  AUTH_INVITATION_SIGN_UP_MAX_BODY_BYTES,
  MAX_AUTH_PASSWORD_CHARS,
} from './auth-body-limits.ts'
import {
  type AuthBodyValidation,
  type AuthRouteOpts,
  createSignupUser,
  enforceAuthRateLimit,
  readGatedAuthJsonBody,
  startSessionResponse,
} from './http.ts'
import { isInstanceInstalled, validateSuperadminPassword } from './install-state.ts'

export type InvitationStatus = 'pending' | 'expired' | 'accepted' | 'revoked'

export type InvitationPreview = {
  ok: true
  status: InvitationStatus
  organizationName: string
  teamName: string
  inviterName: string | null
  /** Only for a pending invitation — the page needs it to choose a path. */
  email?: string
  accountExists?: boolean
}

type InvitationRow = {
  email: string
  status: string
  expiresAt: string
  teamId: string
  inviterId: string
}

/** The state the page shows: a pending row past its expiry reads as expired. */
export function invitationStatus(
  row: Pick<InvitationRow, 'status' | 'expiresAt'>,
  now: string
): InvitationStatus {
  if (row.status === 'accepted' || row.status === 'revoked') return row.status
  if (row.status !== 'pending' || row.expiresAt <= now) return 'expired'
  return 'pending'
}

async function loadInvitation(db: Db, id: string): Promise<InvitationRow | undefined> {
  const rows = await db
    .select({
      email: invitation.email,
      status: invitation.status,
      expiresAt: invitation.expiresAt,
      teamId: invitation.teamId,
      inviterId: invitation.userId,
    })
    .from(invitation)
    .where(eq(invitation.id, id))
    .limit(1)
  return rows[0]
}

async function accountIdForEmail(db: Db, email: string): Promise<string | undefined> {
  const rows = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, email.trim().toLowerCase()))
    .limit(1)
  return rows[0]?.id
}

async function buildPreview(db: Db, row: InvitationRow): Promise<InvitationPreview> {
  const [teamRows, inviterRows] = await Promise.all([
    db
      .select({ teamName: team.name, organizationName: organization.name })
      .from(team)
      .innerJoin(organization, eq(organization.id, team.organizationId))
      .where(eq(team.id, row.teamId))
      .limit(1),
    db
      .select({ name: user.name, email: user.email })
      .from(user)
      .where(eq(user.id, row.inviterId))
      .limit(1),
  ])
  const status = invitationStatus(row, new Date().toISOString())
  const inviter = inviterRows[0]
  const preview: InvitationPreview = {
    ok: true,
    status,
    organizationName: teamRows[0]?.organizationName?.trim() || 'an organization',
    teamName: teamRows[0]?.teamName?.trim() || 'a team',
    inviterName: inviter?.name?.trim() || inviter?.email || null,
  }
  if (status !== 'pending') return preview
  return {
    ...preview,
    email: row.email,
    accountExists: (await accountIdForEmail(db, row.email)) !== undefined,
  }
}

export function parseInvitationSignUpBody(body: unknown): AuthBodyValidation<{ password: string }> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'Invalid request' }
  }
  const { password } = body as { password?: unknown }
  if (typeof password !== 'string' || !password || password.length > MAX_AUTH_PASSWORD_CHARS) {
    return { ok: false, error: 'Invalid request' }
  }
  const passwordError = validateSuperadminPassword(password)
  if (passwordError) return { ok: false, error: passwordError }
  return { ok: true, value: { password } }
}

function unavailable(c: Context, status: InvitationStatus | 'missing'): Response {
  return c.json({ ok: false, error: 'invitation_unavailable', status }, 410)
}

export function registerInvitationLandingRoutes<E extends Env>(
  auth: Hono<E>,
  opts: AuthRouteOpts
): void {
  auth.get('/invitations/:id', async (c) => {
    const id = c.req.param('id')
    const limited = await enforceAuthRateLimit(c, 'invitation-preview', id, opts.runtime)
    if (limited) return limited
    const db = getDb(c)
    if (db === undefined) return c.json({ ok: false, error: 'Database unavailable' }, 503)
    if (!isUuid(id)) return c.json({ ok: false, error: 'not_found' }, 404)
    const row = await loadInvitation(db, id)
    if (!row) return c.json({ ok: false, error: 'not_found' }, 404)
    return c.json(await buildPreview(db, row))
  })

  auth.post('/invitations/:id/sign-up', async (c) => {
    const id = c.req.param('id')
    const gated = await readGatedAuthJsonBody(c, {
      runtime: opts.runtime,
      purpose: 'invitation-sign-up',
      maxBytes: AUTH_INVITATION_SIGN_UP_MAX_BODY_BYTES,
      parse: parseInvitationSignUpBody,
      identity: () => id,
    })
    if (!gated.ok) return gated.response

    const db = getDb(c)
    if (db === undefined) return c.json({ ok: false, error: 'Database unavailable' }, 503)
    const secrets = opts.secrets
    if (!secrets) return c.json({ ok: false, error: 'Not configured' }, 503)
    if (opts.runtime === 'deno' && !(await isInstanceInstalled(db))) {
      return c.json({ ok: false, error: 'Complete initial setup first' }, 403)
    }
    if (!isUuid(id)) return unavailable(c, 'missing')

    const row = await loadInvitation(db, id)
    if (!row) return unavailable(c, 'missing')
    const status = invitationStatus(row, new Date().toISOString())
    if (status !== 'pending') return unavailable(c, status)

    const email = row.email.trim().toLowerCase()
    if ((await accountIdForEmail(db, email)) !== undefined) {
      return c.json({ ok: false, error: 'account_exists' }, 409)
    }

    // Hash before any transaction: argon2 is slow and must never run while
    // this request's single database connection is held (see #47).
    const hashedPassword = await hashPassword(gated.value.password)
    // `false` = verification not required: the invited address is verified
    // by the click that brought this person here.
    const created = await createSignupUser(db, email, hashedPassword, false)
    if (!created.ok) {
      return created.conflict
        ? c.json({ ok: false, error: 'account_exists' }, 409)
        : c.json({ ok: false, error: 'Sign-up failed' }, 500)
    }

    const accepted = await acceptInvitationForUser(db, id, created.userId)
    if ('error' in accepted) {
      // Revoked or expired between the check and the claim: the account
      // stands (the email is still verified), without the membership.
      const payload = invitationAcceptErrorPayload(accepted.error)
      return c.json(payload.body, payload.status)
    }

    return await startSessionResponse(c, opts, db, secrets, created.userId, {
      organizationId: accepted.organizationId,
    })
  })
}
