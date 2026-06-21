import { and, eq } from 'drizzle-orm'
import { getDatabaseUrl } from '../../db-url.ts'
import { createDenoDb } from '../../db.ts'
import { grant, member, organization, realm, team, teammate, user } from '../../lib/db/schema.ts'
import { materializeInvitationGrants } from '../authn/invitation-grants.ts'
import {
  assertNotLastOrgOwner,
  can,
  canAssignGrant,
  canInviteToOrganization,
  canInviteToTeam,
  canManageOrganization,
  canManageTeam,
  canOwnOrganization,
  canOwnTeam,
} from './index.ts'

const dbUrl = getDatabaseUrl()

async function withTestFixtures(
  fn: (ctx: {
    db: ReturnType<typeof createDenoDb>
    userId: string
    organizationId: string
    realmId: string
    teamId: string
  }) => Promise<void>,
): Promise<void> {
  if (!dbUrl) {
    console.warn('Skipping authz tests: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()

  const email = `service-test-${crypto.randomUUID()}@example.com`

  const insertedOrg = await db
    .insert(organization)
    .values({ displayName: 'Service Test Org' })
    .returning({ id: organization.id })

  const organizationId = insertedOrg[0]!.id

  const insertedUser = await db
    .insert(user)
    .values({ email, isEmailVerified: true, role: 'user' })
    .returning({ id: user.id })

  const userId = insertedUser[0]!.id

  await db.insert(member).values({ organizationId, userId })

  const [insertedRealm] = await db
    .insert(realm)
    .values({ displayName: 'Test Realm', organizationId })
    .returning({ id: realm.id })

  const realmId = insertedRealm!.id

  const [insertedTeam] = await db
    .insert(team)
    .values({ displayName: 'Test Team', organizationId })
    .returning({ id: team.id })

  const teamId = insertedTeam!.id

  try {
    await fn({
      db,
      userId,
      organizationId,
      realmId,
      teamId,
    })
  } finally {
    await db.delete(grant).where(eq(grant.subjectId, userId))
    await db.delete(teammate).where(eq(teammate.userId, userId))
    await db.delete(member).where(and(
      eq(member.userId, userId),
      eq(member.organizationId, organizationId),
    ))
    await db.delete(realm).where(eq(realm.organizationId, organizationId))
    await db.delete(team).where(eq(team.organizationId, organizationId))
    await db.delete(user).where(eq(user.id, userId))
    await db.delete(organization).where(eq(organization.id, organizationId))
  }
}

Deno.test('org owner can manage org', async () => {
  await withTestFixtures(async ({ db, userId, organizationId }) => {
    await db.insert(grant).values({
      entityType: 'organization',
      entityId: organizationId,
      subjectType: 'user',
      subjectId: userId,
      permission: 'organization:owner',
      allowed: true,
    })

    const ownsOrg = await canOwnOrganization(db, userId, organizationId)
    const managesOrg = await canManageOrganization(db, userId, organizationId)

    if (!ownsOrg) throw new Error('organization:owner grant should allow canOwnOrganization')
    if (!managesOrg) throw new Error('organization:owner grant should allow canManageOrganization')
  })
})

Deno.test('org manager can invite and manage org members', async () => {
  await withTestFixtures(async ({ db, userId, organizationId }) => {
    await db.insert(grant).values({
      entityType: 'organization',
      entityId: organizationId,
      subjectType: 'user',
      subjectId: userId,
      permission: 'organization:manager',
      allowed: true,
    })

    const managesOrg = await canManageOrganization(db, userId, organizationId)
    const canInvite = await canInviteToOrganization(db, userId, organizationId)
    const ownsOrg = await canOwnOrganization(db, userId, organizationId)

    if (!managesOrg) throw new Error('organization:manager grant should allow canManageOrganization')
    if (!canInvite) throw new Error('organization:manager grant should allow canInviteToOrganization')
    if (ownsOrg) throw new Error('organization:manager grant must not allow canOwnOrganization')
  })
})

Deno.test('team owner can manage team', async () => {
  await withTestFixtures(async ({ db, userId, teamId }) => {
    await db.insert(grant).values({
      entityType: 'team',
      entityId: teamId,
      subjectType: 'user',
      subjectId: userId,
      permission: 'team:owner',
      allowed: true,
    })

    const ownsTeam = await canOwnTeam(db, userId, teamId)
    const managesTeam = await canManageTeam(db, userId, teamId)

    if (!ownsTeam) throw new Error('team:owner grant should allow canOwnTeam')
    if (!managesTeam) throw new Error('team:owner grant should allow canManageTeam')
  })
})

Deno.test('team manager can invite and manage team members', async () => {
  await withTestFixtures(async ({ db, userId, teamId }) => {
    await db.insert(grant).values({
      entityType: 'team',
      entityId: teamId,
      subjectType: 'user',
      subjectId: userId,
      permission: 'team:manager',
      allowed: true,
    })

    const managesTeam = await canManageTeam(db, userId, teamId)
    const canInvite = await canInviteToTeam(db, userId, teamId)
    const ownsTeam = await canOwnTeam(db, userId, teamId)

    if (!managesTeam) throw new Error('team:manager grant should allow canManageTeam')
    if (!canInvite) throw new Error('team:manager grant should allow canInviteToTeam')
    if (ownsTeam) throw new Error('team:manager grant must not allow canOwnTeam')
  })
})

Deno.test('team manager cannot assign grants outside their team', async () => {
  await withTestFixtures(async ({ db, userId, organizationId, teamId }) => {
    await db.insert(grant).values({
      entityType: 'team',
      entityId: teamId,
      subjectType: 'user',
      subjectId: userId,
      permission: 'team:manager',
      allowed: true,
    })

    const [insertedTeamB] = await db
      .insert(team)
      .values({ displayName: 'Team B', organizationId })
      .returning({ id: team.id })

    const teamBId = insertedTeamB!.id

    try {
      const canAssignTeamB = await canAssignGrant(db, userId, {
        entityType: 'team',
        entityId: teamBId,
        permission: 'team:manager',
      })
      const canAssignOrg = await canAssignGrant(db, userId, {
        entityType: 'organization',
        entityId: organizationId,
        permission: 'organization:manager',
      })

      if (canAssignTeamB) {
        throw new Error('team manager should not assign grants on another team')
      }
      if (canAssignOrg) {
        throw new Error('team manager should not assign organization-level grants')
      }
    } finally {
      await db.delete(team).where(eq(team.id, teamBId))
    }
  })
})

Deno.test('org manager can manage any team in their org', async () => {
  await withTestFixtures(async ({ db, userId, organizationId, teamId }) => {
    await db.insert(grant).values({
      entityType: 'organization',
      entityId: organizationId,
      subjectType: 'user',
      subjectId: userId,
      permission: 'organization:manager',
      allowed: true,
    })

    const managesTeam = await canManageTeam(db, userId, teamId)
    const canInvite = await canInviteToTeam(db, userId, teamId)

    if (!managesTeam) {
      throw new Error('org manager should manage any team in their org via canManageOrganization')
    }
    if (!canInvite) {
      throw new Error('org manager should invite to any team in their org')
    }
  })
})

Deno.test('invitation grant materialization creates grant rows and enables canOwnOrganization', async () => {
  await withTestFixtures(async ({ db, userId, organizationId }) => {
    await materializeInvitationGrants(
      db,
      userId,
      [{
        entityType: 'organization',
        entityId: organizationId,
        permissionKey: 'organization:owner',
        allowed: true,
      }],
      organizationId,
    )

    const rows = await db
      .select({ permission: grant.permission, entityId: grant.entityId, subjectId: grant.subjectId })
      .from(grant)
      .where(
        and(
          eq(grant.subjectId, userId),
          eq(grant.entityId, organizationId),
          eq(grant.permission, 'organization:owner'),
        ),
      )

    if (rows.length === 0) {
      throw new Error('materializeInvitationGrants should insert organization:owner grant row')
    }

    const ownsOrg = await canOwnOrganization(db, userId, organizationId)
    if (!ownsOrg) {
      throw new Error('materialized organization:owner grant should enable canOwnOrganization')
    }
  })
})

Deno.test('assertNotLastOrgOwner throws when removing the sole owner', async () => {
  await withTestFixtures(async ({ db, userId, organizationId }) => {
    await db.insert(grant).values({
      entityType: 'organization',
      entityId: organizationId,
      subjectType: 'user',
      subjectId: userId,
      permission: 'organization:owner',
      allowed: true,
    })

    let threw = false
    try {
      await assertNotLastOrgOwner(db, organizationId, userId)
    } catch (error) {
      threw = true
      if (!(error instanceof Error) || error.message !== 'Cannot remove the last owner of an organization') {
        throw error
      }
    }
    if (!threw) throw new Error('assertNotLastOrgOwner should throw for sole owner')

    const secondEmail = `service-second-owner-${crypto.randomUUID()}@example.com`
    const insertedSecondUser = await db
      .insert(user)
      .values({ email: secondEmail, isEmailVerified: true, role: 'user' })
      .returning({ id: user.id })

    const secondUserId = insertedSecondUser[0]!.id

    try {
      await db.insert(grant).values({
        entityType: 'organization',
        entityId: organizationId,
        subjectType: 'user',
        subjectId: secondUserId,
        permission: 'organization:owner',
        allowed: true,
      })

      await assertNotLastOrgOwner(db, organizationId, userId)
    } finally {
      await db.delete(grant).where(eq(grant.subjectId, secondUserId))
      await db.delete(user).where(eq(user.id, secondUserId))
    }
  })
})

Deno.test('team grants apply only to actual teammates', async () => {
  await withTestFixtures(async ({ db, organizationId, realmId, teamId }) => {
    await db.insert(grant).values({
      entityType: 'workspace',
      entityId: realmId,
      subjectType: 'team',
      subjectId: teamId,
      permission: 'workspace:ro',
      allowed: true,
    })

    const userBEmail = `service-teammate-b-${crypto.randomUUID()}@example.com`
    const userCEmail = `service-teammate-c-${crypto.randomUUID()}@example.com`

    const insertedUserB = await db
      .insert(user)
      .values({ email: userBEmail, isEmailVerified: true, role: 'user' })
      .returning({ id: user.id })

    const userBId = insertedUserB[0]!.id

    const insertedUserC = await db
      .insert(user)
      .values({ email: userCEmail, isEmailVerified: true, role: 'user' })
      .returning({ id: user.id })

    const userCId = insertedUserC[0]!.id

    try {
      await db.insert(member).values({ organizationId, userId: userBId })
      await db.insert(member).values({ organizationId, userId: userCId })
      await db.insert(teammate).values({ teamId, userId: userBId })

      const canUserB = await can(db, userBId, 'workspace:ro', 'workspace', realmId)
      const canUserC = await can(db, userCId, 'workspace:ro', 'workspace', realmId)

      if (!canUserB) throw new Error('teammate should inherit team-subject workspace:ro grant')
      if (canUserC) throw new Error('non-teammate should not match team-subject grant')
    } finally {
      await db.delete(teammate).where(eq(teammate.userId, userBId))
      await db.delete(member).where(and(
        eq(member.userId, userBId),
        eq(member.organizationId, organizationId),
      ))
      await db.delete(member).where(and(
        eq(member.userId, userCId),
        eq(member.organizationId, organizationId),
      ))
      await db.delete(user).where(eq(user.id, userBId))
      await db.delete(user).where(eq(user.id, userCId))
    }
  })
})

Deno.test('superadmin bypass (regression after admin bypass addition)', async () => {
  await withTestFixtures(async ({ db, organizationId, realmId }) => {
    const superadminEmail = `service-superadmin-${crypto.randomUUID()}@example.com`

    const insertedSuperadmin = await db
      .insert(user)
      .values({ email: superadminEmail, isEmailVerified: true, role: 'superadmin' })
      .returning({ id: user.id })

    const superadminId = insertedSuperadmin[0]!.id

    try {
      const canWorkspaceWrite = await can(db, superadminId, 'workspace:rw', 'workspace', realmId)
      const ownsOrg = await canOwnOrganization(db, superadminId, organizationId)

      if (!canWorkspaceWrite) throw new Error('superadmin should bypass workspace:rw check')
      if (!ownsOrg) throw new Error('superadmin should bypass canOwnOrganization check')
    } finally {
      await db.delete(user).where(eq(user.id, superadminId))
    }
  })
})
