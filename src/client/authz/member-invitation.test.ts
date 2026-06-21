import { and, eq } from 'drizzle-orm'
import { getDatabaseUrl } from '../../db-url.ts'
import { createDenoDb } from '../../db.ts'
import {
  grant,
  member,
  organization,
  workspace,
  user,
} from '../../lib/db/schema.ts'
import {
  defaultInvitationGrants,
  InvitationGrantValidationError,
  materializeInvitationGrants,
} from '../authn/invitation-grants.ts'
import { ACCESS_PROFILES, type PermissionKey } from './catalog.ts'
import { can } from './evaluator.ts'

const dbUrl = getDatabaseUrl()

const WRITE_PERMISSIONS: PermissionKey[] = [
  'realm:rw',
  'environment:rw',
  'project:rw',
  'service:rw',
  'hosting:rw',
]

async function assertMemberOrganizationGrantPermissions(
  db: ReturnType<typeof createDenoDb>,
  userId: string,
  organizationId: string,
): Promise<void> {
  const rows = await db
    .select({ permission: grant.permission })
    .from(grant)
    .where(
      and(
        eq(grant.subjectId, userId),
        eq(grant.entityType, 'organization'),
        eq(grant.entityId, organizationId),
      ),
    )

  const actual = rows.map((row) => row.permission).sort()
  const expected = [...ACCESS_PROFILES['member']].sort()

  if (actual.length !== expected.length || actual.some((permission, index) => permission !== expected[index])) {
    throw new Error(
      `Expected member profile permissions on organization ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    )
  }
}

async function withTestFixtures(
  fn: (ctx: {
    db: ReturnType<typeof createDenoDb>
    userId: string
    organizationId: string
    workspaceId: string
  }) => Promise<void>,
): Promise<void> {
  if (!dbUrl) {
    console.warn('Skipping authz tests: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()

  const email = `member-test-${crypto.randomUUID()}@example.com`

  const insertedOrg = await db
    .insert(organization)
    .values({ displayName: 'Member Test Org' })
    .returning({ id: organization.id })

  const organizationId = insertedOrg[0]!.id

  const insertedUser = await db
    .insert(user)
    .values({ email, isEmailVerified: true })
    .returning({ id: user.id })

  const userId = insertedUser[0]!.id

  await db.insert(member).values({ organizationId, userId })

  const grants = defaultInvitationGrants(organizationId)
  await materializeInvitationGrants(db, userId, grants, organizationId)

  const [insertedWorkspace] = await db
    .insert(workspace)
    .values({ displayName: 'Test Workspace', organizationId })
    .returning({ id: workspace.id })

  const workspaceId = insertedWorkspace!.id

  try {
    await fn({
      db,
      userId,
      organizationId,
      workspaceId,
    })
  } finally {
    await db.delete(grant).where(eq(grant.subjectId, userId))
    await db.delete(member).where(and(
      eq(member.userId, userId),
      eq(member.organizationId, organizationId),
    ))
    await db.delete(workspace).where(eq(workspace.organizationId, organizationId))
    await db.delete(user).where(eq(user.id, userId))
    await db.delete(organization).where(eq(organization.id, organizationId))
  }
}

Deno.test('default invited member has read-only baseline on organization', async () => {
  await withTestFixtures(async ({ db, userId, organizationId }) => {
    await assertMemberOrganizationGrantPermissions(db, userId, organizationId)

    const canRead = await can(db, userId, 'organization:ro', 'organization', organizationId)
    const canWrite = await can(db, userId, 'organization:rw', 'organization', organizationId)
    const canManageMembers = await can(
      db,
      userId,
      'organization:members',
      'organization',
      organizationId,
    )

    if (!canRead) throw new Error('expected organization:ro')
    if (canWrite) throw new Error('member must not have organization:rw')
    if (canManageMembers) {
      throw new Error('member must not have organization:members')
    }
  })
})

Deno.test('default invited member cannot mutate realm-tree resources', async () => {
  await withTestFixtures(async ({ db, userId, organizationId, workspaceId }) => {
    for (const permissionKey of WRITE_PERMISSIONS) {
      const allowedOnOrg = await can(
        db,
        userId,
        permissionKey,
        'organization',
        organizationId,
      )
      if (allowedOnOrg) {
        throw new Error(`member must not have ${permissionKey} on organization`)
      }

      const allowedOnRealm = await can(db, userId, permissionKey, 'workspace', workspaceId)
      if (allowedOnRealm) {
        throw new Error(`member must not have ${permissionKey} on realm`)
      }
    }
  })
})

Deno.test('elevated manager access profile grants realm write after explicit grant', async () => {
  await withTestFixtures(async ({ db, userId, workspaceId }) => {
    for (const permission of ACCESS_PROFILES['manager']) {
      await db
        .insert(grant)
        .values({
          entityType: 'realm',
          entityId: workspaceId,
          subjectType: 'user',
          subjectId: userId,
          permission,
          allowed: true,
        })
        .onConflictDoNothing({
          target: [
            grant.entityType,
            grant.entityId,
            grant.subjectType,
            grant.subjectId,
            grant.permission,
          ],
        })
    }

    const allowed = await can(db, userId, 'realm:rw', 'workspace', workspaceId)
    if (!allowed) throw new Error('manager grant should allow realm:rw')
  })
})

Deno.test('profile expansion is idempotent', async () => {
  await withTestFixtures(async ({ db, userId, organizationId }) => {
    const grants = defaultInvitationGrants(organizationId)

    // Call materializeInvitationGrants a second time — should be a no-op
    await materializeInvitationGrants(db, userId, grants, organizationId)

    await assertMemberOrganizationGrantPermissions(db, userId, organizationId)
  })
})

Deno.test('invitation grant accepts workspace entity type and stores realm rows', async () => {
  await withTestFixtures(async ({ db, userId, organizationId, workspaceId }) => {
    await materializeInvitationGrants(
      db,
      userId,
      [
        {
          entityType: 'workspace',
          entityId: workspaceId,
          permissionKey: 'realm:ro',
          allowed: true,
        },
      ],
      organizationId,
    )

    const rows = await db
      .select({
        entityType: grant.entityType,
        permission: grant.permission,
      })
      .from(grant)
      .where(
        and(
          eq(grant.subjectId, userId),
          eq(grant.entityId, workspaceId),
        ),
      )

    if (rows.length !== 1) {
      throw new Error(`expected one grant row, got ${rows.length}`)
    }
    if (rows[0]!.entityType !== 'realm') {
      throw new Error(`expected stored entityType realm, got ${rows[0]!.entityType}`)
    }
    if (rows[0]!.permission !== 'realm:ro') {
      throw new Error(`expected realm:ro permission, got ${rows[0]!.permission}`)
    }

    const allowed = await can(db, userId, 'realm:ro', 'workspace', workspaceId)
    if (!allowed) {
      throw new Error('workspace-targeted invitation grant should authorize workspace reads')
    }
  })
})

Deno.test('invitation grant rejects nonexistent entity id', async () => {
  await withTestFixtures(async ({ db, userId, organizationId }) => {
    const missingEntityId = crypto.randomUUID()

    try {
      await materializeInvitationGrants(
        db,
        userId,
        [
          {
            entityType: 'realm',
            entityId: missingEntityId,
            accessProfileKey: 'member',
            allowed: true,
          },
        ],
        organizationId,
      )
      throw new Error('expected InvitationGrantValidationError')
    } catch (err) {
      if (!(err instanceof InvitationGrantValidationError)) {
        throw err
      }
      if (err.message !== 'Entity not found') {
        throw new Error(`expected Entity not found, got ${err.message}`)
      }
    }
  })
})

Deno.test('invitation grant rejects nonexistent workspace entity id', async () => {
  await withTestFixtures(async ({ db, userId, organizationId }) => {
    const missingEntityId = crypto.randomUUID()

    try {
      await materializeInvitationGrants(
        db,
        userId,
        [
          {
            entityType: 'workspace',
            entityId: missingEntityId,
            accessProfileKey: 'member',
            allowed: true,
          },
        ],
        organizationId,
      )
      throw new Error('expected InvitationGrantValidationError')
    } catch (err) {
      if (!(err instanceof InvitationGrantValidationError)) {
        throw err
      }
      if (err.message !== 'Entity not found') {
        throw new Error(`expected Entity not found, got ${err.message}`)
      }
    }
  })
})

Deno.test('invitation grant rejects cross-organization entity target', async () => {
  await withTestFixtures(async ({ db, userId, workspaceId }) => {
    const otherOrg = await db
      .insert(organization)
      .values({ displayName: 'Other Org' })
      .returning({ id: organization.id })

    const otherOrganizationId = otherOrg[0]!.id

    try {
      try {
        await materializeInvitationGrants(
          db,
          userId,
          [
            {
              entityType: 'realm',
              entityId: workspaceId,
              accessProfileKey: 'member',
              allowed: true,
            },
          ],
          otherOrganizationId,
        )
        throw new Error('expected InvitationGrantValidationError')
      } catch (err) {
        if (!(err instanceof InvitationGrantValidationError)) {
          throw err
        }
        if (err.message !== 'Entity must belong to the invitation organization') {
          throw new Error(`expected cross-org rejection, got ${err.message}`)
        }
      }
    } finally {
      await db.delete(organization).where(eq(organization.id, otherOrganizationId))
    }
  })
})
