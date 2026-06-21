import { and, eq } from 'drizzle-orm'
import { getDatabaseUrl } from '../db-url.ts'
import { createDenoDb } from '../db.ts'
import {
  accessGrant,
  member,
  organization,
  realm,
  user,
} from '../db/schema.ts'
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
    .select({ permission: accessGrant.permission })
    .from(accessGrant)
    .where(
      and(
        eq(accessGrant.subjectId, userId),
        eq(accessGrant.entityType, 'organization'),
        eq(accessGrant.entityId, organizationId),
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
    realmId: string
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

  const [insertedRealm] = await db
    .insert(realm)
    .values({ displayName: 'Test Realm', organizationId })
    .returning({ id: realm.id })

  const realmId = insertedRealm!.id

  try {
    await fn({
      db,
      userId,
      organizationId,
      realmId,
    })
  } finally {
    await db.delete(accessGrant).where(eq(accessGrant.subjectId, userId))
    await db.delete(member).where(and(
      eq(member.userId, userId),
      eq(member.organizationId, organizationId),
    ))
    await db.delete(realm).where(eq(realm.organizationId, organizationId))
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
  await withTestFixtures(async ({ db, userId, organizationId, realmId }) => {
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

      const allowedOnRealm = await can(db, userId, permissionKey, 'realm', realmId)
      if (allowedOnRealm) {
        throw new Error(`member must not have ${permissionKey} on realm`)
      }
    }
  })
})

Deno.test('elevated manager access profile grants realm write after explicit grant', async () => {
  await withTestFixtures(async ({ db, userId, realmId }) => {
    for (const permission of ACCESS_PROFILES['manager']) {
      await db
        .insert(accessGrant)
        .values({
          entityType: 'realm',
          entityId: realmId,
          subjectType: 'user',
          subjectId: userId,
          permission,
          allowed: true,
        })
        .onConflictDoNothing({
          target: [
            accessGrant.entityType,
            accessGrant.entityId,
            accessGrant.subjectType,
            accessGrant.subjectId,
            accessGrant.permission,
          ],
        })
    }

    const allowed = await can(db, userId, 'realm:rw', 'realm', realmId)
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

Deno.test('invitation grant rejects cross-organization entity target', async () => {
  await withTestFixtures(async ({ db, userId, realmId }) => {
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
              entityId: realmId,
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
