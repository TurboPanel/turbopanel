import { and, eq } from 'drizzle-orm'
import { assertEquals } from 'jsr:@std/assert'
import { it } from '@std/testing/bdd'
import { getDatabaseUrl } from '../../db-url.ts'
import { createDenoDb } from '../../db.ts'
import {
  grant,
  organization,
  workspace,
  team,
  user,
} from '../../lib/db/schema.ts'
import {
  createAccessGrant,
  isAccessGrantEntityType,
  resolveEntityOrganizationId,
  validateGrantEntityTarget,
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
    .values({ name: 'Create Grant Test Org' })
    .returning({ id: organization.id })

  const organizationId = insertedOrg[0]!.id

  const insertedUser = await db
    .insert(user)
    .values({ email, isEmailVerified: true, role: 'user' })
    .returning({ id: user.id })

  const userId = insertedUser[0]!.id


  const [insertedWorkspace] = await db
    .insert(workspace)
    .values({ name: 'Test Workspace', organizationId })
    .returning({ id: workspace.id })

  const workspaceId = insertedWorkspace!.id

  const [insertedTeam] = await db
    .insert(team)
    .values({ name: 'Test Team', organizationId })
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
    await db.delete(workspace).where(eq(workspace.organizationId, organizationId))
    await db.delete(team).where(eq(team.organizationId, organizationId))
    await db.delete(user).where(eq(user.id, userId))
    await db.delete(organization).where(eq(organization.id, organizationId))
  }
}

it('validatePermissionEntityCompatibility rejects org permissions on non-org entities', () => {
  const orgOwn = validatePermissionEntityCompatibility('organization:own', 'workspace')
  if (orgOwn.ok) {
    throw new Error('organization:own on workspace should be rejected')
  }

  const orgManage = validatePermissionEntityCompatibility('organization:manage', 'team')
  if (orgManage.ok) {
    throw new Error('organization:manage on team should be rejected')
  }
})

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('isAccessGrantEntityType accepts organization and team only', () => {
  assertEquals(isAccessGrantEntityType('organization'), true)
  assertEquals(isAccessGrantEntityType('team'), true)
  assertEquals(isAccessGrantEntityType('workspace'), false)
  assertEquals(isAccessGrantEntityType('server'), false)
})

test('validatePermissionEntityCompatibility rejects system permissions on non-org entities', () => {
  const readOnTeam = validatePermissionEntityCompatibility('system:read', 'team')
  if (readOnTeam.ok) {
    throw new TypeError('system:read on team should be rejected')
  }

  const manageOnWorkspace = validatePermissionEntityCompatibility(
    'system:manage',
    'workspace',
  )
  if (manageOnWorkspace.ok) {
    throw new TypeError('system:manage on workspace should be rejected')
  }

  const readOnOrg = validatePermissionEntityCompatibility('system:read', 'organization')
  if (!readOnOrg.ok) {
    throw new TypeError('system:read on organization should be allowed')
  }
})

it('validatePermissionEntityCompatibility rejects team permissions on non-team entities', () => {
  const teamOwn = validatePermissionEntityCompatibility('team:own', 'organization')
  if (teamOwn.ok) {
    throw new Error('team:own on organization should be rejected')
  }

  const teamManage = validatePermissionEntityCompatibility('team:manage', 'workspace')
  if (teamManage.ok) {
    throw new Error('team:manage on workspace should be rejected')
  }
})

it('createAccessGrant rejects invalid permission and entity combinations', async () => {
  await withTestFixtures(async ({ db, userId, organizationId, workspaceId, teamId }) => {
    const invalidOrgOnWorkspace = await createAccessGrant(db, {
      entityType: 'workspace',
      entityId: workspaceId,
      actorType: 'user',
      actorId: userId,
      permissionKey: 'organization:own',
    })
    if (invalidOrgOnWorkspace.ok || invalidOrgOnWorkspace.status !== 400) {
      throw new Error('organization:own on workspace should return 400')
    }

    const invalidTeamOnOrg = await createAccessGrant(db, {
      entityType: 'organization',
      entityId: organizationId,
      actorType: 'user',
      actorId: userId,
      permissionKey: 'team:own',
    })
    if (invalidTeamOnOrg.ok || invalidTeamOnOrg.status !== 400) {
      throw new Error('team:own on organization should return 400')
    }

    const validOrg = await createAccessGrant(db, {
      entityType: 'organization',
      entityId: organizationId,
      actorType: 'user',
      actorId: userId,
      permissionKey: 'organization:manage',
    })
    if (!validOrg.ok) {
      throw new Error(`valid organization grant should succeed: ${validOrg.error}`)
    }

    const validTeam = await createAccessGrant(db, {
      entityType: 'team',
      entityId: teamId,
      actorType: 'user',
      actorId: userId,
      permissionKey: 'team:manage',
    })
    if (!validTeam.ok) {
      throw new Error(`valid team grant should succeed: ${validTeam.error}`)
    }
  })
})

it('createAccessGrant rejects workspace targets and invalid request fields', async () => {
  await withTestFixtures(async ({ db, userId, organizationId, workspaceId, teamId }) => {
    const workspaceTarget = await createAccessGrant(db, {
      entityType: 'workspace',
      entityId: workspaceId,
      actorType: 'user',
      actorId: userId,
      permissionKey: 'organization:manage',
    })
    if (workspaceTarget.ok || workspaceTarget.status !== 400) {
      throw new TypeError('workspace entity type should return 400')
    }

    const invalidUuid = await createAccessGrant(db, {
      entityType: 'organization',
      entityId: 'not-a-uuid',
      actorType: 'user',
      actorId: userId,
      permissionKey: 'organization:manage',
    })
    if (invalidUuid.ok || invalidUuid.status !== 400) {
      throw new TypeError('invalid entity uuid should return 400')
    }

    const invalidPermission = await createAccessGrant(db, {
      entityType: 'organization',
      entityId: organizationId,
      actorType: 'user',
      actorId: userId,
      permissionKey: 'organization:read',
    })
    if (invalidPermission.ok || invalidPermission.status !== 400) {
      throw new TypeError('unknown permission key should return 400')
    }

    const missingUser = await createAccessGrant(db, {
      entityType: 'team',
      entityId: teamId,
      actorType: 'user',
      actorId: crypto.randomUUID(),
      permissionKey: 'team:manage',
    })
    if (missingUser.ok || missingUser.status !== 404) {
      throw new TypeError('missing actor user should return 404')
    }
  })
})

it('createAccessGrant is idempotent for duplicate grants', async () => {
  await withTestFixtures(async ({ db, userId, organizationId }) => {
    const first = await createAccessGrant(db, {
      entityType: 'organization',
      entityId: organizationId,
      actorType: 'user',
      actorId: userId,
      permissionKey: 'organization:own',
    })
    if (!first.ok || !first.created) {
      throw new TypeError('first grant should be created')
    }

    const second = await createAccessGrant(db, {
      entityType: 'organization',
      entityId: organizationId,
      actorType: 'user',
      actorId: userId,
      permissionKey: 'organization:own',
    })
    if (!second.ok || second.created) {
      throw new TypeError('duplicate grant should return existing id without creating')
    }
    assertEquals(second.ids[0], first.ids[0])
  })
})

it('validateGrantEntityTarget rejects cross-organization workspace targets', async () => {
  await withTestFixtures(async ({ db, workspaceId }) => {
    const otherOrg = await db
      .insert(organization)
      .values({ name: 'Other Grant Org' })
      .returning({ id: organization.id })
    const otherOrganizationId = otherOrg[0]!.id

    try {
      const result = await validateGrantEntityTarget(
        db,
        'workspace',
        workspaceId,
        otherOrganizationId,
      )
      if (result.ok || result.status !== 400) {
        throw new TypeError('cross-org workspace should return 400')
      }
      assertEquals(result.error, 'Entity must belong to the invitation organization')
    } finally {
      await db.delete(organization).where(eq(organization.id, otherOrganizationId))
    }
  })
})

it('resolveEntityOrganizationId returns organization id for organization entities', async () => {
  await withTestFixtures(async ({ db, organizationId }) => {
    const resolved = await resolveEntityOrganizationId(db, 'organization', organizationId)
    assertEquals(resolved, organizationId)
  })
})
