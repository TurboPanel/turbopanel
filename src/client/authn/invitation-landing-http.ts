/**
 * Invitation landing page (owner decision 2026-09-27). The emailed link opens
 * `/accept-invitation?token=<secret>`, a console page that never accepts on
 * load:
 *
 *   GET  /auth/invitations/by-token/:token
 *     What the page needs to choose a path: organization, inviter, the invited
 *     email, whether an account already uses it, and the state.
 *   POST /auth/invitations/by-token/:token/sign-up { password }
 *     The invited email has no account yet: create one with that email
 *     (verified — the emailed secret proves the address), accept and sign in,
 *     one step, no personal organization, no confirm. `account_exists` sends
 *     the page to sign-in, then the Accept button.
 *   GET  /auth/invitations/:id
 *     Links sent before the secret existed (`?id=`). Organization, inviter and
 *     state only — never the email or whether it has an account.
 *
 * Only the **link secret** (`client/access/invitation-token.ts`), looked up by
 * its verifier, may reveal the invited email or stand in for proof of the
 * address. The invitation id cannot: organization managers list it and the
 * inviter receives it. Old `?id=` links sign in (or sign up) as usual and press
 * Accept (`POST /invitations/:id/accept`, which requires a session with the
 * invited email), or ask for the invitation to be re-sent.
 */
import { eq } from 'drizzle-orm'
import type { Context, Env, Hono } from 'hono'
import type { Db } from '../../db/connection.ts'
import { getDb } from '../../db/connection.ts'
import { invitation, organization, team, user } from '../../db/schema.ts'
import { hashPassword } from '../../lib/secrets/password.ts'
import { acceptInvitationForUser } from '../access/invitation-accept.ts'
import { invitationTokenHash, isInvitationToken } from '../access/invitation-token.ts'
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
  /** Token path + pending only. */
  email?: string
  /** Token path + pending only. */
  accountExists?: boolean
}

type InvitationRow = {
  id: string
  email: string
  status: string
  expiresAt: string
  teamId: string
  inviterId: string
}

const INVITATION_ROW = {
  id: invitation.id,
  email: invitation.email,
  status: invitation.status,
  expiresAt: invitation.expiresAt,
  teamId: invitation.teamId,
  inviterId: invitation.userId,
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

/** The invitation a link secret belongs to, looked up by its verifier. */
async function loadInvitationByToken(db: Db, token: string): Promise<InvitationRow | undefined> {
  if (!isInvitationToken(token)) return undefined
  const tokenHash = await invitationTokenHash(token)
  const rows = await db
    .select(INVITATION_ROW)
    .from(invitation)
    .where(eq(invitation.tokenHash, tokenHash))
    .limit(1)
  return rows[0]
}

async function loadInvitationById(db: Db, id: string): Promise<InvitationRow | undefined> {
  if (!isUuid(id)) return undefined
  const rows = await db
    .select(INVITATION_ROW)
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

/** Organization, inviter and state — safe for anyone who holds the invitation id. */
async function publicPreview(db: Db, row: InvitationRow): Promise<InvitationPreview> {
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
  const inviter = inviterRows[0]
  return {
    ok: true,
    status: invitationStatus(row, new Date().toISOString()),
    organizationName: teamRows[0]?.organizationName?.trim() || 'an organization',
    teamName: teamRows[0]?.teamName?.trim() || 'a team',
    inviterName: inviter?.name?.trim() || inviter?.email || null,
  }
}

/** Token path only: adds the invited email and whether it has an account. */
async function tokenPreview(db: Db, row: InvitationRow): Promise<InvitationPreview> {
  const preview = await publicPreview(db, row)
  if (preview.status !== 'pending') return preview
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

/** Rate-limit identity for a link secret: a prefix, so the secret never becomes a key. */
function tokenIdentity(token: string): string {
  return `t:${token.slice(0, 16)}`
}

export function registerInvitationLandingRoutes<E extends Env>(
  auth: Hono<E>,
  opts: AuthRouteOpts
): void {
  auth.get('/invitations/by-token/:token', async (c) => {
    const token = c.req.param('token')
    const limited = await enforceAuthRateLimit(
      c,
      'invitation-preview',
      tokenIdentity(token),
      opts.runtime
    )
    if (limited) return limited
    const db = getDb(c)
    if (db === undefined) return c.json({ ok: false, error: 'Database unavailable' }, 503)
    const row = await loadInvitationByToken(db, token)
    if (!row) return c.json({ ok: false, error: 'not_found' }, 404)
    return c.json(await tokenPreview(db, row))
  })

  auth.post('/invitations/by-token/:token/sign-up', async (c) => {
    const token = c.req.param('token')
    const gated = await readGatedAuthJsonBody(c, {
      runtime: opts.runtime,
      purpose: 'invitation-sign-up',
      maxBytes: AUTH_INVITATION_SIGN_UP_MAX_BODY_BYTES,
      parse: parseInvitationSignUpBody,
      identity: () => tokenIdentity(token),
    })
    if (!gated.ok) return gated.response

    const db = getDb(c)
    if (db === undefined) return c.json({ ok: false, error: 'Database unavailable' }, 503)
    const secrets = opts.secrets
    if (!secrets) return c.json({ ok: false, error: 'Not configured' }, 503)
    if (opts.runtime === 'deno' && !(await isInstanceInstalled(db))) {
      return c.json({ ok: false, error: 'Complete initial setup first' }, 403)
    }

    const row = await loadInvitationByToken(db, token)
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
    // `false` = verification not required: the emailed secret proves the address.
    const created = await createSignupUser(db, email, hashedPassword, false)
    if (!created.ok) {
      return created.conflict
        ? c.json({ ok: false, error: 'account_exists' }, 409)
        : c.json({ ok: false, error: 'Sign-up failed' }, 500)
    }

    const accepted = await acceptInvitationForUser(db, row.id, created.userId)
    if ('error' in accepted) {
      // Revoked, re-sent or expired between the check and the claim: the
      // account stands (the email is still verified), without the membership.
      const payload = invitationAcceptErrorPayload(accepted.error)
      return c.json(payload.body, payload.status)
    }

    return await startSessionResponse(c, opts, db, secrets, created.userId, {
      organizationId: accepted.organizationId,
    })
  })

  // Old `?id=` links: no email, no account oracle, no sign-up.
  auth.get('/invitations/:id', async (c) => {
    const id = c.req.param('id')
    const limited = await enforceAuthRateLimit(c, 'invitation-preview', `i:${id}`, opts.runtime)
    if (limited) return limited
    const db = getDb(c)
    if (db === undefined) return c.json({ ok: false, error: 'Database unavailable' }, 503)
    const row = await loadInvitationById(db, id)
    if (!row) return c.json({ ok: false, error: 'not_found' }, 404)
    return c.json(await publicPreview(db, row))
  })
}
