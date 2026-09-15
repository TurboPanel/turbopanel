import { and, eq, gt } from 'drizzle-orm'
import type { Context } from 'hono'
import type { AuthRouteOpts } from '../authn/http.ts'
import {
  parseInvitationGrants,
  type InvitationGrantSpec,
} from '../authn/invitation-grants.ts'
import { isPermissionKey } from '../authz/catalog.ts'
import {
  validateGrantEntityTarget,
  validatePermissionEntityCompatibility,
} from '../authz/create-access-grant.ts'
import { can, canInviteToTeam, canManageOrganization } from '../authz/index.ts'
import type { Db } from '../../db.ts'
import { getDb } from '../../db.ts'
import {
  invitation,
  organization,
  team,
  user,
} from '../../lib/db/schema.ts'
import { getEmailQueue } from '../../lib/email/types.ts'
import { isNoopEmailQueue } from '../../lib/email/noop-queue.ts'
import { resolvePublicBaseUrl } from '../../lib/resolve-public-base-url.ts'
import { getOrgId } from '../shared.ts'
import {
  parseCreateInvitationBody,
  type CreateInvitationInput,
} from './routes-helpers.ts'

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000

class InvitationEmailError extends Error {
  constructor() {
    super('email_unavailable')
    this.name = 'InvitationEmailError'
  }
}

async function parseCreateInvitationRequest(
  c: Context,
): Promise<CreateInvitationInput | { response: Response }> {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return { response: c.json({ error: 'Invalid request' }, 400) }
  }

  const parsed = parseCreateInvitationBody(body)
  if ('ok' in parsed) {
    return { response: c.json({ error: parsed.error }, parsed.status) }
  }
  return parsed
}

async function loadTeamInOrganization(
  db: Db,
  teamId: string,
  organizationId: string,
): Promise<{ id: string; name: string | null } | null> {
  const rows = await db
    .select({
      id: team.id,
      name: team.name,
      organizationId: team.organizationId,
    })
    .from(team)
    .where(eq(team.id, teamId))
    .limit(1)
  const row = rows[0]
  if (row?.organizationId !== organizationId) return null
  return { id: row.id, name: row.name }
}

async function hasPendingInvitation(
  db: Db,
  teamId: string,
  email: string,
  nowIso: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: invitation.id })
    .from(invitation)
    .where(
      and(
        eq(invitation.teamId, teamId),
        eq(invitation.email, email),
        eq(invitation.status, 'pending'),
        gt(invitation.expiresAt, nowIso),
      ),
    )
    .limit(1)
  return rows.length > 0
}

type StoredGrantsResult =
  | { ok: true; grants: InvitationGrantSpec[] | null }
  | { ok: false; error: string; status: 400 | 403 | 404 }

async function resolveCreateInvitationGrants(
  db: Db,
  userId: string,
  organizationId: string,
  grants: unknown[] | undefined,
): Promise<StoredGrantsResult> {
  if (grants === undefined) {
    return { ok: true, grants: null }
  }

  const isOwner = await can(
    db,
    userId,
    'organization:own',
    'organization',
    organizationId,
  )
  if (!isOwner) {
    return { ok: false, error: 'grants_require_owner', status: 403 }
  }

  const parsed = parseInvitationGrants(grants)
  if (!parsed) {
    return { ok: false, error: 'Invalid invitation grants', status: 400 }
  }

  for (const spec of parsed) {
    if (!isPermissionKey(spec.permissionKey)) {
      return { ok: false, error: 'Invalid invitation grants', status: 400 }
    }
    const permissionCompat = validatePermissionEntityCompatibility(
      spec.permissionKey,
      spec.entityType,
    )
    if (!permissionCompat.ok) {
      return { ok: false, error: permissionCompat.error, status: 400 }
    }

    const target = await validateGrantEntityTarget(
      db,
      spec.entityType,
      spec.entityId,
      organizationId,
    )
    if (!target.ok) {
      return { ok: false, error: target.error, status: target.status }
    }
  }

  return { ok: true, grants: parsed }
}

async function loadInvitationEmailNames(
  db: Db,
  organizationId: string,
  teamId: string,
): Promise<{ organizationName: string; teamName: string }> {
  const [orgRows, teamRows] = await Promise.all([
    db
      .select({ name: organization.name })
      .from(organization)
      .where(eq(organization.id, organizationId))
      .limit(1),
    db
      .select({ name: team.name })
      .from(team)
      .where(eq(team.id, teamId))
      .limit(1),
  ])
  return {
    organizationName: orgRows[0]?.name?.trim() || 'an organization',
    teamName: teamRows[0]?.name?.trim() || 'a team',
  }
}

function invitationEmailFrom(c: Context, opts: AuthRouteOpts): string {
  return c.get('emailFrom') || opts.emailFrom || 'noreply@turbopanel.local'
}

export async function handleCreateInvitation(
  c: Context,
  opts: AuthRouteOpts,
): Promise<Response> {
  const db = getDb(c)
  if (!db) return c.json({ error: 'Database unavailable' }, 503)

  const session = c.get('session')
  if (!session?.userId) return c.json({ error: 'Unauthorized' }, 401)

  const orgResult = await getOrgId(c, session.userId)
  if (orgResult instanceof Response) return orgResult
  const organizationId = orgResult

  const parsed = await parseCreateInvitationRequest(c)
  if ('response' in parsed) return parsed.response

  const teamRow = await loadTeamInOrganization(db, parsed.teamId, organizationId)
  if (!teamRow) return c.json({ error: 'Not found' }, 404)

  const allowed = await canInviteToTeam(db, session.userId, parsed.teamId)
  if (!allowed) return c.json({ error: 'Forbidden' }, 403)

  const now = new Date()
  const nowIso = now.toISOString()
  if (await hasPendingInvitation(db, parsed.teamId, parsed.email, nowIso)) {
    return c.json({ error: 'invitation_pending' }, 409)
  }

  const grantsResult = await resolveCreateInvitationGrants(
    db,
    session.userId,
    organizationId,
    parsed.grants,
  )
  if (!grantsResult.ok) {
    return c.json({ error: grantsResult.error }, grantsResult.status)
  }

  const queue = getEmailQueue(c)
  if (isNoopEmailQueue(queue) || !queue) {
    return c.json({ error: 'email_unavailable' }, 503)
  }

  const expiresAt = new Date(now.getTime() + INVITATION_TTL_MS).toISOString()
  const names = await loadInvitationEmailNames(db, organizationId, parsed.teamId)
  const emailFrom = invitationEmailFrom(c, opts)
  const baseOrigin = await resolvePublicBaseUrl(c, { baseUrl: opts.baseUrl })

  try {
    const inserted = await db.transaction(async (tx) => {
      const rows = await tx
        .insert(invitation)
        .values({
          userId: session.userId,
          teamId: parsed.teamId,
          email: parsed.email,
          expiresAt,
          status: 'pending',
          grants: grantsResult.grants,
        })
        .returning({ id: invitation.id, expiresAt: invitation.expiresAt })
      const row = rows[0]
      if (!row) {
        throw new TypeError('invitation insert returned no row')
      }

      const acceptUrl = `${baseOrigin}/accept-invitation?id=${row.id}`
      try {
        await queue.enqueue({
          type: 'invitation',
          to: parsed.email,
          from: emailFrom,
          inviterEmail: session.email,
          organizationName: names.organizationName,
          teamName: names.teamName,
          acceptUrl,
        })
      } catch {
        throw new InvitationEmailError()
      }
      return row
    })

    return c.json({
      ok: true as const,
      id: inserted.id,
      expiresAt: inserted.expiresAt,
    })
  } catch (err) {
    if (err instanceof InvitationEmailError) {
      return c.json({ error: 'email_unavailable' }, 503)
    }
    throw err
  }
}

export async function handleListInvitations(c: Context): Promise<Response> {
  const db = getDb(c)
  if (!db) return c.json({ error: 'Database unavailable' }, 503)

  const session = c.get('session')
  if (!session?.userId) return c.json({ error: 'Unauthorized' }, 401)

  const orgResult = await getOrgId(c, session.userId)
  if (orgResult instanceof Response) return orgResult
  const organizationId = orgResult

  const visible = await canManageOrganization(db, session.userId, organizationId)
  if (!visible) return c.json({ error: 'Forbidden' }, 403)

  const nowIso = new Date().toISOString()
  const rows = await db
    .select({
      id: invitation.id,
      email: invitation.email,
      teamId: invitation.teamId,
      teamName: team.name,
      expiresAt: invitation.expiresAt,
      createdAt: invitation.createdAt,
      invitedBy: user.email,
    })
    .from(invitation)
    .innerJoin(team, eq(invitation.teamId, team.id))
    .innerJoin(user, eq(invitation.userId, user.id))
    .where(
      and(
        eq(team.organizationId, organizationId),
        eq(invitation.status, 'pending'),
        gt(invitation.expiresAt, nowIso),
      ),
    )

  return c.json({
    invitations: rows.map((row) => ({
      id: row.id,
      email: row.email,
      teamId: row.teamId,
      teamName: row.teamName,
      expiresAt: row.expiresAt,
      createdAt: row.createdAt,
      invitedBy: row.invitedBy,
    })),
  })
}

export async function handleRevokeInvitation(c: Context): Promise<Response> {
  const db = getDb(c)
  if (!db) return c.json({ error: 'Database unavailable' }, 503)

  const session = c.get('session')
  if (!session?.userId) return c.json({ error: 'Unauthorized' }, 401)

  const invitationId = c.req.param('id')
  if (!invitationId) return c.json({ error: 'Not found' }, 404)
  const inviteRows = await db
    .select({
      id: invitation.id,
      teamId: invitation.teamId,
    })
    .from(invitation)
    .where(eq(invitation.id, invitationId))
    .limit(1)

  const invite = inviteRows[0]
  if (!invite) return c.json({ error: 'Not found' }, 404)

  const allowed = await canInviteToTeam(db, session.userId, invite.teamId)
  if (!allowed) return c.json({ error: 'Forbidden' }, 403)

  const claimed = await db
    .update(invitation)
    .set({ status: 'revoked' })
    .where(
      and(eq(invitation.id, invitationId), eq(invitation.status, 'pending')),
    )
    .returning({ id: invitation.id })

  if (!claimed[0]) return c.json({ error: 'Not found' }, 404)

  return c.json({ ok: true as const })
}
