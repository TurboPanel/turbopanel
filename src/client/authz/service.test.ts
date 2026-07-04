import { and, eq } from 'drizzle-orm'
import { getDatabaseUrl } from '../../db-url.ts'
import { createDenoDb } from '../../db.ts'
import { grant, member, organization, workspace, team, teammate, user } from '../../lib/db/schema.ts'
import { materializeInvitationGrants } from '../authn/invitation-grants.ts'
import {
  assertNotLastOrgOwner,
  assertNotLastTeamOwner,
  can,
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
    workspaceId: string
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

  const [insertedWorkspace] = await db
    .insert(workspace)
    .values({ displayName: 'Test Workspace', organizationId })
    .returning({ id: workspace.id })

  const workspaceId = insertedWorkspace!.id

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
      workspaceId,
      teamId,
    })
  } finally {
    await db.delete(grant).where(eq(grant.actorId, userId))
    await db.delete(teammate).where(eq(teammate.userId, userId))
    await db.delete(member).where(and(
      eq(member.userId, userId),
      eq(member.organizationId, organizationId),
    ))
    await db.delete(workspace).where(eq(workspace.organizationId, organizationId))
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
      actorType: 'user',
      actorId: userId,
      permission: 'organization:own',
      allow: true,
    })

    const ownsOrg = await canOwnOrganization(db, userId, organizationId)
    const managesOrg = await canManageOrganization(db, userId, organizationId)

    if (!ownsOrg) throw new Error('organization:own grant should allow canOwnOrganization')
    if (!managesOrg) throw new Error('organization:own grant should allow canManageOrganization')
  })
})

Deno.test('org manager can invite and manage org members', async () => {
  await withTestFixtures(async ({ db, userId, organizationId }) => {
    await db.insert(grant).values({
      entityType: 'organization',
      entityId: organizationId,
      actorType: 'user',
      actorId: userId,
      permission: 'organization:manage',
      allow: true,
    })

    const managesOrg = await canManageOrganization(db, userId, organizationId)
    const canInvite = await canInviteToOrganization(db, userId, organizationId)
    const ownsOrg = await canOwnOrganization(db, userId, organizationId)

    if (!managesOrg) throw new Error('organization:manage grant should allow canManageOrganization')
    if (!canInvite) throw new Error('organization:manage grant should allow canInviteToOrganization')
    if (ownsOrg) throw new Error('organization:manage grant must not allow canOwnOrganization')
  })
})

Deno.test('team owner can manage team', async () => {
  await withTestFixtures(async ({ db, userId, teamId }) => {
    await db.insert(grant).values({
      entityType: 'team',
      entityId: teamId,
      actorType: 'user',
      actorId: userId,
      permission: 'team:own',
      allow: true,
    })

    const ownsTeam = await canOwnTeam(db, userId, teamId)
    const managesTeam = await canManageTeam(db, userId, teamId)

    if (!ownsTeam) throw new Error('team:own grant should allow canOwnTeam')
    if (!managesTeam) throw new Error('team:own grant should allow canManageTeam')
  })
})

Deno.test('team manager can invite and manage team members', async () => {
  await withTestFixtures(async ({ db, userId, teamId }) => {
    await db.insert(grant).values({
      entityType: 'team',
      entityId: teamId,
      actorType: 'user',
      actorId: userId,
      permission: 'team:manage',
      allow: true,
    })

    const managesTeam = await canManageTeam(db, userId, teamId)
    const canInvite = await canInviteToTeam(db, userId, teamId)
    const ownsTeam = await canOwnTeam(db, userId, teamId)

    if (!managesTeam) throw new Error('team:manage grant should allow canManageTeam')
    if (!canInvite) throw new Error('team:manage grant should allow canInviteToTeam')
    if (ownsTeam) throw new Error('team:manage grant must not allow canOwnTeam')
  })
})

Deno.test('org manager can manage any team in their org', async () => {
  await withTestFixtures(async ({ db, userId, organizationId, teamId }) => {
    await db.insert(grant).values({
      entityType: 'organization',
      entityId: organizationId,
      actorType: 'user',
      actorId: userId,
      permission: 'organization:manage',
      allow: true,
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
        permissionKey: 'organization:own',
        allow: true,
      }],
      organizationId,
    )

    const rows = await db
      .select({ permission: grant.permission, entityId: grant.entityId, actorId: grant.actorId })
      .from(grant)
      .where(
        and(
          eq(grant.actorId, userId),
          eq(grant.entityId, organizationId),
          eq(grant.permission, 'organization:own'),
        ),
      )

    if (rows.length === 0) {
      throw new Error('materializeInvitationGrants should insert organization:own grant row')
    }

    const ownsOrg = await canOwnOrganization(db, userId, organizationId)
    if (!ownsOrg) {
      throw new Error('materialized organization:own grant should enable canOwnOrganization')
    }
  })
})

Deno.test('assertNotLastOrgOwner throws when removing the sole owner', async () => {
  await withTestFixtures(async ({ db, userId, organizationId }) => {
    await db.insert(grant).values({
      entityType: 'organization',
      entityId: organizationId,
      actorType: 'user',
      actorId: userId,
      permission: 'organization:own',
      allow: true,
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
        actorType: 'user',
        actorId: secondUserId,
        permission: 'organization:own',
        allow: true,
      })

      await assertNotLastOrgOwner(db, organizationId, userId)
    } finally {
      await db.delete(grant).where(eq(grant.actorId, secondUserId))
      await db.delete(user).where(eq(user.id, secondUserId))
    }
  })
})

Deno.test('assertNotLastTeamOwner throws when removing the sole owner', async () => {
  await withTestFixtures(async ({ db, userId, teamId }) => {
    await db.insert(grant).values({
      entityType: 'team',
      entityId: teamId,
      actorType: 'user',
      actorId: userId,
      permission: 'team:own',
      allow: true,
    })

    let threw = false
    try {
      await assertNotLastTeamOwner(db, teamId, userId)
    } catch (error) {
      threw = true
      if (!(error instanceof Error) || error.message !== 'Cannot remove the last owner of a team') {
        throw error
      }
    }
    if (!threw) throw new Error('assertNotLastTeamOwner should throw for sole owner')

    const secondEmail = `service-second-team-owner-${crypto.randomUUID()}@example.com`
    const insertedSecondUser = await db
      .insert(user)
      .values({ email: secondEmail, isEmailVerified: true, role: 'user' })
      .returning({ id: user.id })

    const secondUserId = insertedSecondUser[0]!.id

    try {
      await db.insert(grant).values({
        entityType: 'team',
        entityId: teamId,
        actorType: 'user',
        actorId: secondUserId,
        permission: 'team:own',
        allow: true,
      })

      await assertNotLastTeamOwner(db, teamId, userId)
    } finally {
      await db.delete(grant).where(eq(grant.actorId, secondUserId))
      await db.delete(user).where(eq(user.id, secondUserId))
    }
  })
})

Deno.test('superadmin bypass (regression after admin bypass addition)', async () => {
  await withTestFixtures(async ({ db, organizationId, workspaceId }) => {
    const superadminEmail = `service-superadmin-${crypto.randomUUID()}@example.com`

    const insertedSuperadmin = await db
      .insert(user)
      .values({ email: superadminEmail, isEmailVerified: true, role: 'superadmin' })
      .returning({ id: user.id })

    const superadminId = insertedSuperadmin[0]!.id

    try {
      const canWorkspace = await can(db, superadminId, 'organization:own', 'workspace', workspaceId)
      const ownsOrg = await canOwnOrganization(db, superadminId, organizationId)

      if (!canWorkspace) throw new Error('superadmin should bypass access check')
      if (!ownsOrg) throw new Error('superadmin should bypass canOwnOrganization check')
    } finally {
      await db.delete(user).where(eq(user.id, superadminId))
    }
  })
})

Deno.test('admin bypass for service-level ownership helpers', async () => {
  await withTestFixtures(async ({ db, organizationId, teamId }) => {
    const adminEmail = `service-admin-${crypto.randomUUID()}@example.com`

    const insertedAdmin = await db
      .insert(user)
      .values({ email: adminEmail, isEmailVerified: true, role: 'admin' })
      .returning({ id: user.id })

    const adminId = insertedAdmin[0]!.id

    try {
      const ownsOrg = await canOwnOrganization(db, adminId, organizationId)
      const managesOrg = await canManageOrganization(db, adminId, organizationId)
      const ownsTeam = await canOwnTeam(db, adminId, teamId)
      const managesTeam = await canManageTeam(db, adminId, teamId)

      if (!ownsOrg) throw new Error('admin should bypass canOwnOrganization')
      if (!managesOrg) throw new Error('admin should bypass canManageOrganization')
      if (!ownsTeam) throw new Error('admin should bypass canOwnTeam')
      if (!managesTeam) throw new Error('admin should bypass canManageTeam')
    } finally {
      await db.delete(user).where(eq(user.id, adminId))
    }
  })
})

Deno.test('org manager is not treated as team owner without direct team:own grant', async () => {
  await withTestFixtures(async ({ db, userId, organizationId, teamId }) => {
    await db.insert(grant).values({
      entityType: 'organization',
      entityId: organizationId,
      actorType: 'user',
      actorId: userId,
      permission: 'organization:manage',
      allow: true,
    })

    const ownsTeam = await canOwnTeam(db, userId, teamId)
    const managesTeam = await canManageTeam(db, userId, teamId)

    if (ownsTeam) {
      throw new Error('org manager must not pass canOwnTeam without a direct team:own grant')
    }
    if (!managesTeam) {
      throw new Error('org manager should still pass canManageTeam via org delegation')
    }
  })
})
