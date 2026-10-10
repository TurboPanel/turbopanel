/**
 * Atomic accept: failed checks must leave the invitation pending and create no
 * membership; success materializes grants once; double accept is idempotent.
 */
import { skipWithoutDatabase } from '../../test-fixtures/require-service.test.support.ts'
import { assertEquals } from '@std/assert'
import { and, eq, inArray } from 'drizzle-orm'
import { createDenoDb } from '../../db/connection.ts'
import { getDatabaseUrl } from '../../db/url.ts'
import { grant, invitation, organization, team, teammate, user } from '../../db/schema.ts'
import { mintInvitationToken } from './invitation-token.ts'
import { acceptInvitationForUser } from './invitation-accept.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const dbUrl = getDatabaseUrl()

type Db = ReturnType<typeof createDenoDb>

type Fixture = {
  db: Db
  organizationId: string
  otherOrganizationId: string
  teamId: string
  inviterId: string
  inviteeId: string
}

async function readInvitationStatus(db: Db, invitationId: string): Promise<string | undefined> {
  const rows = await db
    .select({ status: invitation.status })
    .from(invitation)
    .where(eq(invitation.id, invitationId))
    .limit(1)
  return rows[0]?.status
}

async function isTeammate(db: Db, teamId: string, userId: string): Promise<boolean> {
  const rows = await db
    .select({ userId: teammate.userId })
    .from(teammate)
    .where(and(eq(teammate.teamId, teamId), eq(teammate.userId, userId)))
    .limit(1)
  return rows.length > 0
}

async function userGrantCount(db: Db, userId: string): Promise<number> {
  const rows = await db.select({ id: grant.id }).from(grant).where(eq(grant.actorId, userId))
  return rows.length
}

async function insertPendingInvitation(
  fx: Fixture,
  values: {
    grants?: unknown
    teamId?: string
    expiresAt?: string
  } = {}
): Promise<string> {
  const { tokenHash } = await mintInvitationToken()
  const [row] = await fx.db
    .insert(invitation)
    .values({
      userId: fx.inviterId,
      teamId: values.teamId ?? fx.teamId,
      email: `invitee-${crypto.randomUUID()}@example.com`,
      status: 'pending',
      expiresAt: values.expiresAt ?? new Date(Date.now() + 86_400_000).toISOString(),
      grants: values.grants ?? null,
      tokenHash,
    })
    .returning({ id: invitation.id })
  return row!.id
}

async function withFixture(fn: (fx: Fixture) => Promise<void>): Promise<void> {
  const db = createDenoDb()
  const [org, otherOrg] = await db
    .insert(organization)
    .values([{ name: 'Accept Atomic Org' }, { name: 'Accept Atomic Other Org' }])
    .returning({ id: organization.id })
  const [teamRow] = await db
    .insert(team)
    .values({ name: 'Accept Atomic Team', organizationId: org!.id })
    .returning({ id: team.id })
  const users = await db
    .insert(user)
    .values(
      ['inviter', 'invitee'].map((label) => ({
        email: `invite-accept-${label}-${crypto.randomUUID()}@example.com`,
        isEmailVerified: true,
        role: 'user',
      }))
    )
    .returning({ id: user.id })
  const [inviterId, inviteeId] = [users[0]!.id, users[1]!.id]
  await db.insert(grant).values({
    entityType: 'organization',
    entityId: org!.id,
    actorType: 'user',
    actorId: inviterId,
    permission: 'organization:manage',
  })
  const fx: Fixture = {
    db,
    organizationId: org!.id,
    otherOrganizationId: otherOrg!.id,
    teamId: teamRow!.id,
    inviterId,
    inviteeId,
  }
  try {
    await fn(fx)
  } finally {
    await db.delete(invitation).where(eq(invitation.teamId, fx.teamId))
    await db.delete(teammate).where(eq(teammate.teamId, fx.teamId))
    await db.delete(grant).where(inArray(grant.actorId, [inviterId, inviteeId]))
    await db.delete(team).where(eq(team.organizationId, fx.organizationId))
    await db
      .delete(organization)
      .where(inArray(organization.id, [fx.organizationId, fx.otherOrganizationId]))
    await db.delete(user).where(inArray(user.id, [inviterId, inviteeId]))
  }
}

test('accept refuses invalid_grant when inviter no longer holds team grants', async () => {
  if (!dbUrl) {
    skipWithoutDatabase('invitation accept atomicity')
    return
  }
  await withFixture(async (fx) => {
    const invitationId = await insertPendingInvitation(fx)
    await fx.db.insert(grant).values({
      entityType: 'organization',
      entityId: fx.organizationId,
      actorType: 'team',
      actorId: fx.teamId,
      permission: 'organization:own',
    })

    const result = await acceptInvitationForUser(fx.db, invitationId, fx.inviteeId)
    assertEquals(result, { error: 'invalid_grant' })
    assertEquals(await readInvitationStatus(fx.db, invitationId), 'pending')
    assertEquals(await isTeammate(fx.db, fx.teamId, fx.inviteeId), false)
  })
})

test('accept answers gone when the invitation is expired without consuming it', async () => {
  if (!dbUrl) {
    skipWithoutDatabase('invitation accept atomicity')
    return
  }
  await withFixture(async (fx) => {
    const invitationId = await insertPendingInvitation(fx, {
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    })

    const result = await acceptInvitationForUser(fx.db, invitationId, fx.inviteeId)
    assertEquals(result, { error: 'gone' })
    assertEquals(await readInvitationStatus(fx.db, invitationId), 'pending')
    assertEquals(await isTeammate(fx.db, fx.teamId, fx.inviteeId), false)
  })
})

test('accept refuses invalid stored grants without membership or accepted status', async () => {
  if (!dbUrl) {
    skipWithoutDatabase('invitation accept atomicity')
    return
  }
  await withFixture(async (fx) => {
    const invitationId = await insertPendingInvitation(fx, {
      grants: [{ entityType: 'organization', entityId: fx.organizationId, allow: true }],
    })

    const result = await acceptInvitationForUser(fx.db, invitationId, fx.inviteeId)
    assertEquals(result, { error: 'invalid_grant' })
    assertEquals(await readInvitationStatus(fx.db, invitationId), 'pending')
    assertEquals(await isTeammate(fx.db, fx.teamId, fx.inviteeId), false)
  })
})

test('accept refuses grant materialization failure and leaves invitation pending', async () => {
  if (!dbUrl) {
    skipWithoutDatabase('invitation accept atomicity')
    return
  }
  await withFixture(async (fx) => {
    const invitationId = await insertPendingInvitation(fx, {
      grants: [
        {
          entityType: 'organization',
          entityId: fx.otherOrganizationId,
          permissionKey: 'organization:manage',
        },
      ],
    })

    const result = await acceptInvitationForUser(fx.db, invitationId, fx.inviteeId)
    assertEquals(result, { error: 'invalid_grant' })
    assertEquals(await readInvitationStatus(fx.db, invitationId), 'pending')
    assertEquals(await isTeammate(fx.db, fx.teamId, fx.inviteeId), false)
    assertEquals(await userGrantCount(fx.db, fx.inviteeId), 0)
  })
})

test('accept creates teammate, user grants, and accepted status once', async () => {
  if (!dbUrl) {
    skipWithoutDatabase('invitation accept atomicity')
    return
  }
  await withFixture(async (fx) => {
    const invitationId = await insertPendingInvitation(fx, {
      grants: [
        {
          entityType: 'organization',
          entityId: fx.organizationId,
          permissionKey: 'organization:manage',
        },
      ],
    })

    const result = await acceptInvitationForUser(fx.db, invitationId, fx.inviteeId)
    assertEquals(result, { ok: true, organizationId: fx.organizationId })
    assertEquals(await readInvitationStatus(fx.db, invitationId), 'accepted')
    assertEquals(await isTeammate(fx.db, fx.teamId, fx.inviteeId), true)
    assertEquals(await userGrantCount(fx.db, fx.inviteeId), 1)
  })
})

test('double accept by the same user is idempotent', async () => {
  if (!dbUrl) {
    skipWithoutDatabase('invitation accept atomicity')
    return
  }
  await withFixture(async (fx) => {
    const invitationId = await insertPendingInvitation(fx)

    const first = await acceptInvitationForUser(fx.db, invitationId, fx.inviteeId)
    const second = await acceptInvitationForUser(fx.db, invitationId, fx.inviteeId)
    assertEquals(first, { ok: true, organizationId: fx.organizationId })
    assertEquals(second, { ok: true, organizationId: fx.organizationId })
    assertEquals(await readInvitationStatus(fx.db, invitationId), 'accepted')
    assertEquals(await isTeammate(fx.db, fx.teamId, fx.inviteeId), true)
  })
})

test('concurrent accept by the same user is idempotent for both callers', async () => {
  if (!dbUrl) {
    skipWithoutDatabase('invitation accept atomicity')
    return
  }
  await withFixture(async (fx) => {
    const invitationId = await insertPendingInvitation(fx)

    const [first, second] = await Promise.all([
      acceptInvitationForUser(fx.db, invitationId, fx.inviteeId),
      acceptInvitationForUser(fx.db, invitationId, fx.inviteeId),
    ])
    assertEquals(first, { ok: true, organizationId: fx.organizationId })
    assertEquals(second, { ok: true, organizationId: fx.organizationId })
    assertEquals(await readInvitationStatus(fx.db, invitationId), 'accepted')
    assertEquals(await isTeammate(fx.db, fx.teamId, fx.inviteeId), true)
  })
})
