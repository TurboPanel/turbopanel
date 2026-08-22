import { eq } from 'drizzle-orm'
import { getDatabaseUrl } from '../../db-url.ts'
import { createDenoDb } from '../../db.ts'
import {
  grant,
  environment,
  managed,
  organization,
  project,
  variable,
  workspace,
  team,
  teammate,
  server,
  user,
} from '../../lib/db/schema.ts'
import { can, assertCan, ForbiddenError, getSubjects, listVisible } from './evaluator.ts'

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

  const email = `evaluator-test-${crypto.randomUUID()}@example.com`

  const insertedOrg = await db
    .insert(organization)
    .values({ name: 'Evaluator Test Org' })
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
    await db.delete(grant).where(eq(grant.entityId, organizationId))
    await db.delete(teammate).where(eq(teammate.userId, userId))
    await db.delete(workspace).where(eq(workspace.organizationId, organizationId))
    await db.delete(team).where(eq(team.organizationId, organizationId))
    await db.delete(user).where(eq(user.id, userId))
    await db.delete(organization).where(eq(organization.id, organizationId))
  }
}

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('ForbiddenError carries the permission key', () => {
  const error = new ForbiddenError('organization:own')
  if (error.name !== 'ForbiddenError') {
    throw new TypeError('ForbiddenError should set name')
  }
  if (error.permissionKey !== 'organization:own') {
    throw new TypeError('ForbiddenError should expose permissionKey')
  }
  if (!error.message.includes('organization:own')) {
    throw new TypeError('ForbiddenError message should include permission key')
  }
})

test('organization:own grant allows full org access', async () => {
  await withTestFixtures(async ({ db, userId, organizationId, workspaceId }) => {
    await db.insert(grant).values({
      entityType: 'organization',
      entityId: organizationId,
      actorType: 'user',
      actorId: userId,
      permission: 'organization:own',
    })

    const canWorkspace = await can(db, userId, 'organization:own', 'workspace', workspaceId)
    const canOrg = await can(db, userId, 'organization:own', 'organization', organizationId)

    if (!canWorkspace) throw new Error('organization:own should allow access to workspace in org')
    if (!canOrg) throw new Error('organization:own should allow access to organization')
  })
})

test('organization:manage grant allows full org access', async () => {
  await withTestFixtures(async ({ db, userId, organizationId, workspaceId }) => {
    await db.insert(grant).values({
      entityType: 'organization',
      entityId: organizationId,
      actorType: 'user',
      actorId: userId,
      permission: 'organization:manage',
    })

    const canWorkspace = await can(db, userId, 'organization:manage', 'workspace', workspaceId)
    const canOrg = await can(db, userId, 'organization:manage', 'organization', organizationId)

    if (!canWorkspace) throw new Error('organization:manage should allow access to workspace in org')
    if (!canOrg) throw new Error('organization:manage should allow access to organization')
  })
})

test('organization:manage grant does not satisfy an organization:own check', async () => {
  await withTestFixtures(async ({ db, userId, organizationId, workspaceId }) => {
    await db.insert(grant).values({
      entityType: 'organization',
      entityId: organizationId,
      actorType: 'user',
      actorId: userId,
      permission: 'organization:manage',
    })

    const ownsOrg = await can(db, userId, 'organization:own', 'organization', organizationId)
    const ownsWorkspace = await can(db, userId, 'organization:own', 'workspace', workspaceId)
    const managesOrg = await can(db, userId, 'organization:manage', 'organization', organizationId)

    if (ownsOrg) {
      throw new Error('organization:manage grant must not satisfy an organization:own check on the org')
    }
    if (ownsWorkspace) {
      throw new Error('organization:manage grant must not satisfy an organization:own check on org entities')
    }
    if (!managesOrg) {
      throw new Error('organization:manage grant should still satisfy an organization:manage check')
    }
  })
})

test('user without grants is denied', async () => {
  await withTestFixtures(async ({ db, userId, organizationId, workspaceId }) => {
    const canOrg = await can(db, userId, 'organization:own', 'organization', organizationId)
    const canWorkspace = await can(db, userId, 'organization:own', 'workspace', workspaceId)

    if (canOrg) throw new Error('user without grants should be denied org access')
    if (canWorkspace) throw new Error('user without grants should be denied workspace access')
  })
})

test('superadmin bypass', async () => {
  await withTestFixtures(async ({ db, organizationId, workspaceId }) => {
    const superadminEmail = `evaluator-superadmin-${crypto.randomUUID()}@example.com`

    const insertedSuperadmin = await db
      .insert(user)
      .values({ email: superadminEmail, isEmailVerified: true, role: 'superadmin' })
      .returning({ id: user.id })

    const superadminId = insertedSuperadmin[0]!.id

    try {
      const allowed = await can(db, superadminId, 'organization:own', 'workspace', workspaceId)
      if (!allowed) throw new Error('superadmin should bypass access check')

      const visible = await listVisible(db, {
        kind: 'workspace',
        userId: superadminId,
        organizationId,
      })

      if (!visible.includes(workspaceId)) {
        throw new Error('superadmin listVisible should include all workspaces in org')
      }
    } finally {
      await db.delete(user).where(eq(user.id, superadminId))
    }
  })
})

test('admin bypass', async () => {
  await withTestFixtures(async ({ db, organizationId, workspaceId }) => {
    const adminEmail = `evaluator-admin-${crypto.randomUUID()}@example.com`

    const insertedAdmin = await db
      .insert(user)
      .values({ email: adminEmail, isEmailVerified: true, role: 'admin' })
      .returning({ id: user.id })

    const adminId = insertedAdmin[0]!.id

    try {
      const allowed = await can(db, adminId, 'organization:own', 'workspace', workspaceId)
      if (!allowed) throw new Error('admin should bypass access check')

      const visible = await listVisible(db, {
        kind: 'workspace',
        userId: adminId,
        organizationId,
      })

      if (!visible.includes(workspaceId)) {
        throw new Error('admin listVisible should include all workspaces in org')
      }
    } finally {
      await db.delete(user).where(eq(user.id, adminId))
    }
  })
})

test('listVisible returns all leaves for org owner', async () => {
  await withTestFixtures(async ({ db, userId, organizationId, workspaceId }) => {
    await db.insert(grant).values({
      entityType: 'organization',
      entityId: organizationId,
      actorType: 'user',
      actorId: userId,
      permission: 'organization:own',
    })

    const visible = await listVisible(db, {
      kind: 'workspace',
      userId,
      organizationId,
    })

    if (!visible.includes(workspaceId)) {
      throw new Error('org owner listVisible should include all workspaces in org')
    }
  })
})

test('team:own grant allows team ownership check via can()', async () => {
  await withTestFixtures(async ({ db, userId, teamId }) => {
    await db.insert(grant).values({
      entityType: 'team',
      entityId: teamId,
      actorType: 'user',
      actorId: userId,
      permission: 'team:own',
    })

    const canOwn = await can(db, userId, 'team:own', 'team', teamId)
    const canManage = await can(db, userId, 'team:manage', 'team', teamId)

    if (!canOwn) throw new Error('team:own grant should allow can(..., team:own)')
    if (!canManage) throw new Error('team:own grant should allow can(..., team:manage)')
  })
})

test('team:manage grant allows team management but not ownership via can()', async () => {
  await withTestFixtures(async ({ db, userId, teamId }) => {
    await db.insert(grant).values({
      entityType: 'team',
      entityId: teamId,
      actorType: 'user',
      actorId: userId,
      permission: 'team:manage',
    })

    const canOwn = await can(db, userId, 'team:own', 'team', teamId)
    const canManage = await can(db, userId, 'team:manage', 'team', teamId)

    if (canOwn) throw new Error('team:manage grant must not allow can(..., team:own)')
    if (!canManage) throw new Error('team:manage grant should allow can(..., team:manage)')
  })
})

test('team grant without org grant is denied for org-scoped workspace check', async () => {
  await withTestFixtures(async ({ db, userId, teamId, workspaceId }) => {
    await db.insert(grant).values({
      entityType: 'team',
      entityId: teamId,
      actorType: 'user',
      actorId: userId,
      permission: 'team:manage',
    })

    const canWorkspace = await can(db, userId, 'organization:own', 'workspace', workspaceId)
    if (canWorkspace) {
      throw new Error('team-only grant should not grant org-scoped workspace access')
    }
  })
})

test('listVisible returns empty for user without grants', async () => {
  await withTestFixtures(async ({ db, userId, organizationId }) => {
    const visible = await listVisible(db, {
      kind: 'workspace',
      userId,
      organizationId,
    })

    if (visible.length > 0) {
      throw new Error('user without grants should see no workspaces')
    }
  })
})

test('listVisible returns variable ids for org owner', async () => {
  await withTestFixtures(async ({ db, userId, organizationId, workspaceId }) => {
    const [insertedProject] = await db
      .insert(project)
      .values({ name: 'Evaluator Variables Project', workspaceId })
      .returning({ id: project.id })

    const projectId = insertedProject!.id

    const [insertedEnvironment] = await db
      .insert(environment)
      .values({ name: 'Evaluator Variables Env', projectId })
      .returning({ id: environment.id })

    const environmentId = insertedEnvironment!.id

    const [insertedVariable] = await db
      .insert(variable)
      .values({ environmentId, key: 'LIST_VISIBLE_VAR', value: 'visible' })
      .returning({ id: variable.id })

    const variableId = insertedVariable!.id

    try {
      await db.insert(grant).values({
        entityType: 'organization',
        entityId: organizationId,
        actorType: 'user',
        actorId: userId,
        permission: 'organization:own',
      })

      const visible = await listVisible(db, {
        kind: 'variable',
        userId,
        organizationId,
      })

      if (!visible.includes(variableId)) {
        throw new Error('org owner listVisible should include variables in org')
      }
    } finally {
      await db.delete(variable).where(eq(variable.environmentId, environmentId))
      await db.delete(environment).where(eq(environment.projectId, projectId))
      await db.delete(project).where(eq(project.id, projectId))
    }
  })
})

test('organization grant allows can() on managed and variable entities', async () => {
  await withTestFixtures(async ({ db, userId, organizationId, workspaceId }) => {
    const [insertedProject] = await db
      .insert(project)
      .values({ name: 'Evaluator Test Project', workspaceId })
      .returning({ id: project.id })

    const projectId = insertedProject!.id

    const [insertedEnvironment] = await db
      .insert(environment)
      .values({ name: 'Evaluator Test Env', projectId })
      .returning({ id: environment.id })

    const environmentId = insertedEnvironment!.id

    const [insertedManaged] = await db
      .insert(managed)
      .values({ environmentId })
      .returning({ id: managed.id })

    const managedId = insertedManaged!.id

    const [insertedVariable] = await db
      .insert(variable)
      .values({ environmentId, key: 'TEST_VAR', value: '1' })
      .returning({ id: variable.id })

    const variableId = insertedVariable!.id

    try {
      await db.insert(grant).values({
        entityType: 'organization',
        entityId: organizationId,
        actorType: 'user',
        actorId: userId,
        permission: 'organization:manage',
      })

      const canManaged = await can(
        db,
        userId,
        'organization:manage',
        'managed',
        managedId,
      )
      const canVariable = await can(
        db,
        userId,
        'organization:manage',
        'variable',
        variableId,
      )

      if (!canManaged) {
        throw new Error('organization:manage should allow access to managed entity')
      }
      if (!canVariable) {
        throw new Error('organization:manage should allow access to variable entity')
      }
    } finally {
      await db.delete(variable).where(eq(variable.environmentId, environmentId))
      await db.delete(managed).where(eq(managed.environmentId, environmentId))
      await db.delete(environment).where(eq(environment.projectId, projectId))
      await db.delete(project).where(eq(project.id, projectId))
    }
  })
})

test('organization:manage grant does not satisfy system permissions; explicit and role bypasses do', async () => {
  await withTestFixtures(async ({ db, userId, organizationId }) => {
    await db.insert(grant).values({
      entityType: 'organization',
      entityId: organizationId,
      actorType: 'user',
      actorId: userId,
      permission: 'organization:manage',
    })

    const manageOperate = await can(
      db,
      userId,
      'system:operate',
      'organization',
      organizationId,
    )
    const manageRead = await can(
      db,
      userId,
      'system:read',
      'organization',
      organizationId,
    )
    if (manageOperate) {
      throw new TypeError('organization:manage must not satisfy system:operate')
    }
    if (manageRead) {
      throw new TypeError('organization:manage must not satisfy system:read')
    }

    await db.insert(grant).values({
      entityType: 'organization',
      entityId: organizationId,
      actorType: 'user',
      actorId: userId,
      permission: 'system:operate',
    })

    const explicitOperate = await can(
      db,
      userId,
      'system:operate',
      'organization',
      organizationId,
    )
    if (!explicitOperate) {
      throw new TypeError('explicit system:operate grant should satisfy')
    }

    const [adminUser] = await db
      .insert(user)
      .values({
        email: `evaluator-admin-${crypto.randomUUID()}@example.com`,
        isEmailVerified: true,
        role: 'admin',
      })
      .returning({ id: user.id })
    const adminId = adminUser!.id

    const [superUser] = await db
      .insert(user)
      .values({
        email: `evaluator-super-${crypto.randomUUID()}@example.com`,
        isEmailVerified: true,
        role: 'superadmin',
      })
      .returning({ id: user.id })
    const superId = superUser!.id

    try {
      const adminRead = await can(
        db,
        adminId,
        'system:read',
        'organization',
        organizationId,
      )
      const adminOperate = await can(
        db,
        adminId,
        'system:operate',
        'organization',
        organizationId,
      )
      const adminManage = await can(
        db,
        adminId,
        'system:manage',
        'organization',
        organizationId,
      )
      if (!adminRead) {
        throw new TypeError('admin should satisfy system:read')
      }
      if (!adminOperate) {
        throw new TypeError('admin should satisfy system:operate')
      }
      if (adminManage) {
        throw new TypeError('admin must not satisfy system:manage')
      }

      const superRead = await can(
        db,
        superId,
        'system:read',
        'organization',
        organizationId,
      )
      const superOperate = await can(
        db,
        superId,
        'system:operate',
        'organization',
        organizationId,
      )
      const superManage = await can(
        db,
        superId,
        'system:manage',
        'organization',
        organizationId,
      )
      if (!superRead || !superOperate || !superManage) {
        throw new TypeError('superadmin should satisfy all system permissions')
      }
    } finally {
      await db.delete(user).where(eq(user.id, adminId))
      await db.delete(user).where(eq(user.id, superId))
    }
  })
})

test('explicit system:manage grants do not satisfy can(); system:operate grants do', async () => {
  await withTestFixtures(async ({ db, userId, organizationId }) => {
    await db.insert(grant).values({
      entityType: 'organization',
      entityId: organizationId,
      actorType: 'user',
      actorId: userId,
      permission: 'system:manage',
    })

    const manageAllowed = await can(
      db,
      userId,
      'system:manage',
      'organization',
      organizationId,
    )
    if (manageAllowed) {
      throw new TypeError('regular user with explicit system:manage grant must still be denied')
    }

    await db.insert(grant).values({
      entityType: 'organization',
      entityId: organizationId,
      actorType: 'user',
      actorId: userId,
      permission: 'system:operate',
    })

    const operateAllowed = await can(
      db,
      userId,
      'system:operate',
      'organization',
      organizationId,
    )
    if (!operateAllowed) {
      throw new TypeError('explicit system:operate grant should still satisfy')
    }
  })
})

test('organization-wide subject grants apply to team members', async () => {
  await withTestFixtures(async ({ db, userId, organizationId, teamId, workspaceId }) => {
    await db.insert(teammate).values({ teamId, userId })
    await db.insert(grant).values({
      entityType: 'organization',
      entityId: organizationId,
      actorType: 'organization',
      actorId: organizationId,
      permission: 'organization:manage',
    })

    const memberAllowed = await can(
      db,
      userId,
      'organization:manage',
      'workspace',
      workspaceId,
    )
    if (!memberAllowed) {
      throw new TypeError('team members should inherit organization-subject grants')
    }

    const [outsider] = await db
      .insert(user)
      .values({
        email: `evaluator-outsider-${crypto.randomUUID()}@example.com`,
        isEmailVerified: true,
        role: 'user',
      })
      .returning({ id: user.id })
    const outsiderId = outsider!.id

    try {
      const outsiderAllowed = await can(
        db,
        outsiderId,
        'organization:manage',
        'workspace',
        workspaceId,
      )
      if (outsiderAllowed) {
        throw new TypeError(
          'users outside the organization must not inherit organization-subject grants',
        )
      }
    } finally {
      await db.delete(user).where(eq(user.id, outsiderId))
    }
  })
})

test('assertCan throws ForbiddenError when access is denied', async () => {
  await withTestFixtures(async ({ db, userId, workspaceId }) => {
    let threw = false
    try {
      await assertCan(db, userId, 'organization:own', 'workspace', workspaceId)
    } catch (error) {
      threw = true
      if (!(error instanceof ForbiddenError)) {
        throw error
      }
      if (error.permissionKey !== 'organization:own') {
        throw new TypeError('assertCan should throw ForbiddenError with permission key')
      }
    }
    if (!threw) {
      throw new TypeError('assertCan should throw when user lacks grants')
    }
  })
})

test('getSubjects includes team and organization memberships', async () => {
  await withTestFixtures(async ({ db, userId, teamId }) => {
    await db.insert(teammate).values({ teamId, userId })

    const subjects = await getSubjects(db, userId)
    const kinds = subjects.map((subject) => subject.subjectKind)

    if (!kinds.includes('user')) {
      throw new TypeError('getSubjects should always include the user subject')
    }
    if (!kinds.includes('team')) {
      throw new TypeError('getSubjects should include team memberships')
    }
    if (!kinds.includes('organization')) {
      throw new TypeError('getSubjects should include organization memberships')
    }
  })
})

test('can honors pre-fetched subjects without re-querying teammate', async () => {
  await withTestFixtures(async ({ db, userId, organizationId, workspaceId }) => {
    await db.insert(grant).values({
      entityType: 'organization',
      entityId: organizationId,
      actorType: 'user',
      actorId: userId,
      permission: 'organization:manage',
    })

    const allowed = await can(
      db,
      userId,
      'organization:manage',
      'workspace',
      workspaceId,
      {
        subjects: [{ subjectKind: 'user', subjectId: userId }],
      },
    )
    if (!allowed) {
      throw new TypeError('can should honor pre-fetched subjects for grant lookup')
    }
  })
})

test('listVisible returns server ids for org owner', async () => {
  await withTestFixtures(async ({ db, userId, organizationId }) => {
    const now = new Date().toISOString()
    const [insertedServer] = await db
      .insert(server)
      .values({
        organizationId,
        name: 'Evaluator Visible Server',
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: server.id })
    const serverId = insertedServer!.id

    try {
      await db.insert(grant).values({
        entityType: 'organization',
        entityId: organizationId,
        actorType: 'user',
        actorId: userId,
        permission: 'organization:own',
      })

      const visible = await listVisible(db, {
        kind: 'server',
        userId,
        organizationId,
      })
      if (!visible.includes(serverId)) {
        throw new TypeError('org owner listVisible should include servers in org')
      }
    } finally {
      await db.delete(server).where(eq(server.id, serverId))
    }
  })
})

test('can rejects unknown entity types', async () => {
  await withTestFixtures(async ({ db, userId }) => {
    let threw = false
    try {
      await can(db, userId, 'organization:own', 'license', crypto.randomUUID())
    } catch (error) {
      threw = true
      if (!(error instanceof Error) || !error.message.includes('Unknown entity type')) {
        throw error
      }
    }
    if (!threw) {
      throw new TypeError('unknown entity type should throw from ancestry builder')
    }
  })
})

test('listVisible rejects unknown entity kinds', async () => {
  await withTestFixtures(async ({ db, userId, organizationId }) => {
    let threw = false
    try {
      await listVisible(db, {
        kind: 'license',
        userId,
        organizationId,
      })
    } catch (error) {
      threw = true
      if (!(error instanceof Error) || !error.message.includes('Unknown entity kind')) {
        throw error
      }
    }
    if (!threw) {
      throw new TypeError('unknown listVisible kind should throw')
    }
  })
})
