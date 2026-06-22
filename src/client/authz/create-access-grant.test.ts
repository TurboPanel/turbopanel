import { and, eq } from 'drizzle-orm'
import { getDatabaseUrl } from '../../db-url.ts'
import { createDenoDb } from '../../db.ts'
import {
  grant,
  member,
  organization,
  workspace,
  team,
  user,
} from '../../lib/db/schema.ts'
import {
  createAccessGrant,
  validatePermissionEntityCompatibility,
} from './create-access-grant.ts'

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
    console.warn('Skipping create-access-grant tests: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()

  const email = `create-grant-test-${crypto.randomUUID()}@example.com`

  const insertedOrg = await db
    .insert(organization)
    .values({ displayName: 'Create Grant Test Org' })
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
    await db.delete(grant).where(eq(grant.subjectId, userId))
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

Deno.test('validatePermissionEntityCompatibility rejects org permissions on non-org entities', () => {
  const orgOwn = validatePermissionEntityCompatibility('organization:own', 'workspace')
  if (orgOwn.ok) {
    throw new Error('organization:own on workspace should be rejected')
  }

  const orgManage = validatePermissionEntityCompatibility('organization:manage', 'team')
  if (orgManage.ok) {
    throw new Error('organization:manage on team should be rejected')
  }
})

Deno.test('validatePermissionEntityCompatibility rejects team permissions on non-team entities', () => {
  const teamOwn = validatePermissionEntityCompatibility('team:own', 'organization')
  if (teamOwn.ok) {
    throw new Error('team:own on organization should be rejected')
  }

  const teamManage = validatePermissionEntityCompatibility('team:manage', 'workspace')
  if (teamManage.ok) {
    throw new Error('team:manage on workspace should be rejected')
  }
})

Deno.test('createAccessGrant rejects invalid permission and entity combinations', async () => {
  await withTestFixtures(async ({ db, userId, organizationId, workspaceId, teamId }) => {
    const invalidOrgOnWorkspace = await createAccessGrant(db, {
      entityType: 'workspace',
      entityId: workspaceId,
      subjectType: 'user',
      subjectId: userId,
      permissionKey: 'organization:own',
    })
    if (invalidOrgOnWorkspace.ok || invalidOrgOnWorkspace.status !== 400) {
      throw new Error('organization:own on workspace should return 400')
    }

    const invalidTeamOnOrg = await createAccessGrant(db, {
      entityType: 'organization',
      entityId: organizationId,
      subjectType: 'user',
      subjectId: userId,
      permissionKey: 'team:own',
    })
    if (invalidTeamOnOrg.ok || invalidTeamOnOrg.status !== 400) {
      throw new Error('team:own on organization should return 400')
    }

    const validOrg = await createAccessGrant(db, {
      entityType: 'organization',
      entityId: organizationId,
      subjectType: 'user',
      subjectId: userId,
      permissionKey: 'organization:manage',
    })
    if (!validOrg.ok) {
      throw new Error(`valid organization grant should succeed: ${validOrg.error}`)
    }

    const validTeam = await createAccessGrant(db, {
      entityType: 'team',
      entityId: teamId,
      subjectType: 'user',
      subjectId: userId,
      permissionKey: 'team:manage',
    })
    if (!validTeam.ok) {
      throw new Error(`valid team grant should succeed: ${validTeam.error}`)
    }
  })
})
