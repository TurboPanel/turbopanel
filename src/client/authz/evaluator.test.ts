import { and, eq } from 'drizzle-orm'
import { getDatabaseUrl } from '../../db-url.ts'
import { createDenoDb } from '../../db.ts'
import {
  grant,
  environment,
  member,
  organization,
  realm,
  user,
} from '../../lib/db/schema.ts'
import { ACCESS_PROFILES } from './catalog.ts'
import { can, listVisible } from './evaluator.ts'

const dbUrl = getDatabaseUrl()

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
    await db.delete(grant).where(eq(grant.subjectId, userId))
    await db.delete(member).where(and(
      eq(member.userId, userId),
      eq(member.organizationId, organizationId),
    ))
    await db.delete(environment).where(eq(environment.organizationId, organizationId))
    await db.delete(realm).where(eq(realm.organizationId, organizationId))
    await db.delete(user).where(eq(user.id, userId))
    await db.delete(organization).where(eq(organization.id, organizationId))
  }
}

Deno.test('access profile grant allows inherited access', async () => {
  await withTestFixtures(async ({ db, userId, organizationId, realmId }) => {
    for (const permission of ACCESS_PROFILES['member']) {
      await db
        .insert(grant)
        .values({
          entityType: 'organization',
          entityId: organizationId,
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

    const canRead = await can(db, userId, 'realm:ro', 'workspace', realmId)
    const canWrite = await can(db, userId, 'realm:rw', 'workspace', realmId)

    if (!canRead) throw new Error('member profile on org should inherit realm:ro')
    if (canWrite) throw new Error('member profile must not grant realm:rw')
  })
})

Deno.test('direct permission grant allows access', async () => {
  await withTestFixtures(async ({ db, userId, realmId }) => {
    await db.insert(grant).values({
      entityType: 'realm',
      entityId: realmId,
      subjectType: 'user',
      subjectId: userId,
      permission: 'realm:rw',
      allowed: true,
    })

    const canWrite = await can(db, userId, 'realm:rw', 'workspace', realmId)
    const canRead = await can(db, userId, 'realm:ro', 'workspace', realmId)

    if (!canWrite) throw new Error('direct realm:rw grant should allow realm:rw')
    if (canRead) throw new Error('direct realm:rw grant must not imply realm:ro')
  })
})

Deno.test('lower nearer deny revokes inherited parent allow', async () => {
  await withTestFixtures(async ({
    db,
    userId,
    organizationId,
    realmId,
  }) => {
    const [insertedEnvironment] = await db
      .insert(environment)
      .values({ displayName: 'Test Environment', organizationId, realmId })
      .returning({ id: environment.id })

    const environmentId = insertedEnvironment!.id

    try {
      for (const permission of ACCESS_PROFILES['owner']) {
        await db
          .insert(grant)
          .values({
            entityType: 'organization',
            entityId: organizationId,
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

      for (const permission of ACCESS_PROFILES['owner']) {
        await db
          .insert(grant)
          .values({
            entityType: 'realm',
            entityId: realmId,
            subjectType: 'user',
            subjectId: userId,
            permission,
            allowed: false,
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

      const canRealmWrite = await can(db, userId, 'realm:rw', 'workspace', realmId)
      const canEnvironmentWrite = await can(
        db,
        userId,
        'environment:rw',
        'environment',
        environmentId,
      )
      const canOrgWrite = await can(
        db,
        userId,
        'organization:rw',
        'organization',
        organizationId,
      )

      if (canRealmWrite) {
        throw new Error('nearer deny on realm should revoke inherited realm:rw')
      }
      if (canEnvironmentWrite) {
        throw new Error('nearer deny on realm should revoke inherited environment:rw on descendant')
      }
      if (!canOrgWrite) {
        throw new Error('deny on realm should not affect organization:rw on org')
      }
    } finally {
      await db.delete(environment).where(eq(environment.id, environmentId))
    }
  })
})

Deno.test('cross-org subject grant works', async () => {
  await withTestFixtures(async ({ db, organizationId, realmId }) => {
    const emailB = `evaluator-cross-org-${crypto.randomUUID()}@example.com`

    const insertedOrgB = await db
      .insert(organization)
      .values({ displayName: 'Evaluator Cross Org B' })
      .returning({ id: organization.id })

    const organizationIdB = insertedOrgB[0]!.id

    const insertedUserB = await db
      .insert(user)
      .values({ email: emailB, isEmailVerified: true, role: 'user' })
      .returning({ id: user.id })

    const userBId = insertedUserB[0]!.id

    try {
      await db.insert(member).values({ organizationId: organizationIdB, userId: userBId })

      for (const permission of ACCESS_PROFILES['member']) {
        await db
          .insert(grant)
          .values({
            entityType: 'organization',
            entityId: organizationId,
            subjectType: 'user',
            subjectId: userBId,
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

      const canOrgRead = await can(
        db,
        userBId,
        'organization:ro',
        'organization',
        organizationId,
      )
      const canRealmRead = await can(db, userBId, 'realm:ro', 'workspace', realmId)

      if (!canOrgRead) {
        throw new Error('cross-org user grant should allow organization:ro on org A')
      }
      if (!canRealmRead) {
        throw new Error('cross-org user grant should inherit realm:ro from org A')
      }
    } finally {
      await db.delete(grant).where(eq(grant.subjectId, userBId))
      await db.delete(member).where(and(
        eq(member.userId, userBId),
        eq(member.organizationId, organizationIdB),
      ))
      await db.delete(realm).where(eq(realm.organizationId, organizationIdB))
      await db.delete(user).where(eq(user.id, userBId))
      await db.delete(organization).where(eq(organization.id, organizationIdB))
    }
  })
})

Deno.test('listVisible workspace kind matches legacy realm grants', async () => {
  await withTestFixtures(async ({ db, userId, organizationId, realmId }) => {
    await db.insert(grant).values({
      entityType: 'realm',
      entityId: realmId,
      subjectType: 'user',
      subjectId: userId,
      permission: 'realm:ro',
      allowed: true,
    })

    const visible = await listVisible(db, {
      kind: 'workspace',
      userId,
      organizationId,
    })

    if (!visible.includes(realmId)) {
      throw new Error('listVisible(workspace) should include workspace with legacy realm:ro grant')
    }
  })
})

Deno.test('can accepts workspace entity type against legacy realm grants', async () => {
  await withTestFixtures(async ({ db, userId, realmId }) => {
    await db.insert(grant).values({
      entityType: 'realm',
      entityId: realmId,
      subjectType: 'user',
      subjectId: userId,
      permission: 'realm:ro',
      allowed: true,
    })

    const allowedAsWorkspace = await can(db, userId, 'realm:ro', 'workspace', realmId)
    const allowedAsRealm = await can(db, userId, 'realm:ro', 'realm', realmId)

    if (!allowedAsWorkspace) {
      throw new Error('can(..., workspace, ...) should match legacy realm grant rows')
    }
    if (!allowedAsRealm) {
      throw new Error('can(..., realm, ...) should match legacy realm grant rows')
    }
  })
})

Deno.test('superadmin bypass', async () => {
  await withTestFixtures(async ({ db, organizationId, realmId }) => {
    const superadminEmail = `evaluator-superadmin-${crypto.randomUUID()}@example.com`

    const insertedSuperadmin = await db
      .insert(user)
      .values({ email: superadminEmail, isEmailVerified: true, role: 'superadmin' })
      .returning({ id: user.id })

    const superadminId = insertedSuperadmin[0]!.id

    try {
      const canRealmWrite = await can(db, superadminId, 'realm:rw', 'workspace', realmId)
      const canBilling = await can(
        db,
        superadminId,
        'organization:billing',
        'organization',
        organizationId,
      )

      if (!canRealmWrite) throw new Error('superadmin should bypass realm:rw check')
      if (!canBilling) throw new Error('superadmin should bypass organization:billing check')

      const visible = await listVisible(db, {
        kind: 'workspace',
        userId: superadminId,
        organizationId,
      })

      if (!visible.includes(realmId)) {
        throw new Error('superadmin listVisible should include all workspaces in org')
      }
    } finally {
      await db.delete(user).where(eq(user.id, superadminId))
    }
  })
})

Deno.test('admin bypass', async () => {
  await withTestFixtures(async ({ db, organizationId, realmId }) => {
    const adminEmail = `evaluator-admin-${crypto.randomUUID()}@example.com`

    const insertedAdmin = await db
      .insert(user)
      .values({ email: adminEmail, isEmailVerified: true, role: 'admin' })
      .returning({ id: user.id })

    const adminId = insertedAdmin[0]!.id

    try {
      const canWorkspaceWrite = await can(db, adminId, 'workspace:rw', 'workspace', realmId)
      const canBilling = await can(
        db,
        adminId,
        'organization:billing',
        'organization',
        organizationId,
      )

      if (!canWorkspaceWrite) throw new Error('admin should bypass workspace:rw check')
      if (!canBilling) throw new Error('admin should bypass organization:billing check')

      const visible = await listVisible(db, {
        kind: 'workspace',
        userId: adminId,
        organizationId,
      })

      if (!visible.includes(realmId)) {
        throw new Error('admin listVisible should include all workspaces in org')
      }
    } finally {
      await db.delete(user).where(eq(user.id, adminId))
    }
  })
})

Deno.test('regular user denied without grants', async () => {
  await withTestFixtures(async ({ db, organizationId, realmId }) => {
    const plainEmail = `evaluator-plain-${crypto.randomUUID()}@example.com`

    const insertedPlainUser = await db
      .insert(user)
      .values({ email: plainEmail, isEmailVerified: true, role: 'user' })
      .returning({ id: user.id })

    const plainUserId = insertedPlainUser[0]!.id

    try {
      const canOrgWrite = await can(
        db,
        plainUserId,
        'organization:rw',
        'organization',
        organizationId,
      )
      const canWorkspaceRead = await can(
        db,
        plainUserId,
        'workspace:ro',
        'workspace',
        realmId,
      )

      if (canOrgWrite) throw new Error('user without grants should be denied organization:rw')
      if (canWorkspaceRead) throw new Error('user without grants should be denied workspace:ro')
    } finally {
      await db.delete(user).where(eq(user.id, plainUserId))
    }
  })
})

Deno.test('direct user grant works', async () => {
  await withTestFixtures(async ({ db, userId, realmId }) => {
    await db.insert(grant).values({
      entityType: 'workspace',
      entityId: realmId,
      subjectType: 'user',
      subjectId: userId,
      permission: 'workspace:rw',
      allowed: true,
    })

    const canWrite = await can(db, userId, 'workspace:rw', 'workspace', realmId)
    const canRead = await can(db, userId, 'workspace:ro', 'workspace', realmId)

    if (!canWrite) throw new Error('direct workspace:rw grant should allow workspace:rw')
    if (canRead) throw new Error('direct workspace:rw grant must not imply workspace:ro')
  })
})

Deno.test('denied/allowed precedence — org allow does not bleed through workspace deny', async () => {
  await withTestFixtures(async ({ db, userId, organizationId, realmId }) => {
    for (const permission of ACCESS_PROFILES['owner']) {
      await db
        .insert(grant)
        .values({
          entityType: 'organization',
          entityId: organizationId,
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

    await db
      .insert(grant)
      .values({
        entityType: 'workspace',
        entityId: realmId,
        subjectType: 'user',
        subjectId: userId,
        permission: 'workspace:rw',
        allowed: false,
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

    const canWorkspaceWrite = await can(db, userId, 'workspace:rw', 'workspace', realmId)
    const canOrgWrite = await can(
      db,
      userId,
      'organization:rw',
      'organization',
      organizationId,
    )

    if (canWorkspaceWrite) {
      throw new Error('workspace deny should revoke inherited workspace:rw')
    }
    if (!canOrgWrite) {
      throw new Error('workspace deny should not affect organization:rw on org')
    }
  })
})
