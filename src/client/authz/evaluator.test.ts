import { and, eq } from 'drizzle-orm'
import { getDatabaseUrl } from '../../db-url.ts'
import { createDenoDb } from '../../db.ts'
import {
  grant,
  environment,
  managed,
  member,
  organization,
  project,
  variable,
  workspace,
  team,
  user,
} from '../../lib/db/schema.ts'
import { can, listVisible } from './evaluator.ts'

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
    .values({ displayName: 'Evaluator Test Org' })
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

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('organization:own grant allows full org access', async () => {
  await withTestFixtures(async ({ db, userId, organizationId, workspaceId }) => {
    await db.insert(grant).values({
      entityType: 'organization',
      entityId: organizationId,
      actorType: 'user',
      actorId: userId,
      permission: 'organization:own',
      allow: true,
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
      allow: true,
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
      allow: true,
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
      allow: true,
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
      allow: true,
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
      allow: true,
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
      allow: true,
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
      .values({ displayName: 'Evaluator Variables Project', workspaceId })
      .returning({ id: project.id })

    const projectId = insertedProject!.id

    const [insertedEnvironment] = await db
      .insert(environment)
      .values({ displayName: 'Evaluator Variables Env', projectId })
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
        allow: true,
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
      .values({ displayName: 'Evaluator Test Project', workspaceId })
      .returning({ id: project.id })

    const projectId = insertedProject!.id

    const [insertedManaged] = await db
      .insert(managed)
      .values({ projectId })
      .returning({ id: managed.id })

    const managedId = insertedManaged!.id

    const [insertedEnvironment] = await db
      .insert(environment)
      .values({ displayName: 'Evaluator Test Env', projectId })
      .returning({ id: environment.id })

    const environmentId = insertedEnvironment!.id

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
        allow: true,
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
      await db.delete(environment).where(eq(environment.projectId, projectId))
      await db.delete(managed).where(eq(managed.projectId, projectId))
      await db.delete(project).where(eq(project.id, projectId))
    }
  })
})
