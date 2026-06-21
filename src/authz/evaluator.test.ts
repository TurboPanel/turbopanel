import { and, eq } from 'drizzle-orm'
import { getDatabaseUrl } from '../db-url.ts'
import { createDenoDb } from '../db.ts'
import {
  access,
  environment,
  member,
  organization,
  realm,
  resource,
  user,
} from '../db/schema.ts'
import { registerResource } from './resource-registry.ts'
import { can, listVisible } from './evaluator.ts'

const dbUrl = getDatabaseUrl()

async function withTestFixtures(
  fn: (ctx: {
    db: ReturnType<typeof createDenoDb>
    userId: string
    organizationId: string
    orgResourceId: string
    realmResourceId: string
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

  const orgResourceId = await registerResource(db, {
    kind: 'organization',
    itemId: organizationId,
    organizationId,
  })

  const [insertedRealm] = await db
    .insert(realm)
    .values({ displayName: 'Test Realm', organizationId })
    .returning({ id: realm.id })

  const realmId = insertedRealm!.id

  const realmResourceId = await registerResource(db, {
    kind: 'realm',
    itemId: realmId,
    organizationId,
    parentId: orgResourceId,
  })

  try {
    await fn({
      db,
      userId,
      organizationId,
      orgResourceId,
      realmResourceId,
      realmId,
    })
  } finally {
    await db.delete(access).where(eq(access.subjectId, userId))
    await db.delete(member).where(and(
      eq(member.userId, userId),
      eq(member.organizationId, organizationId),
    ))
    await db.delete(resource).where(eq(resource.organizationId, organizationId))
    await db.delete(environment).where(eq(environment.organizationId, organizationId))
    await db.delete(realm).where(eq(realm.organizationId, organizationId))
    await db.delete(user).where(eq(user.id, userId))
    await db.delete(organization).where(eq(organization.id, organizationId))
  }
}

Deno.test('access profile grant allows inherited access', async () => {
  await withTestFixtures(async ({ db, userId, orgResourceId, realmResourceId }) => {
    await db.insert(access).values({
      subjectKind: 'user',
      subjectId: userId,
      resourceId: orgResourceId,
      effect: 'allow',
      accessProfileKey: 'member',
      permissionKey: null,
    })

    const canRead = await can(db, userId, 'realm:ro', realmResourceId)
    const canWrite = await can(db, userId, 'realm:rw', realmResourceId)

    if (!canRead) throw new Error('member profile on org should inherit realm:ro')
    if (canWrite) throw new Error('member profile must not grant realm:rw')
  })
})

Deno.test('direct permission grant allows access', async () => {
  await withTestFixtures(async ({ db, userId, realmResourceId }) => {
    await db.insert(access).values({
      subjectKind: 'user',
      subjectId: userId,
      resourceId: realmResourceId,
      effect: 'allow',
      accessProfileKey: null,
      permissionKey: 'realm:rw',
    })

    const canWrite = await can(db, userId, 'realm:rw', realmResourceId)
    const canRead = await can(db, userId, 'realm:ro', realmResourceId)

    if (!canWrite) throw new Error('direct realm:rw grant should allow realm:rw')
    if (canRead) throw new Error('direct realm:rw grant must not imply realm:ro')
  })
})

Deno.test('lower nearer deny revokes inherited parent allow', async () => {
  await withTestFixtures(async ({
    db,
    userId,
    organizationId,
    orgResourceId,
    realmResourceId,
    realmId,
  }) => {
    const [insertedEnvironment] = await db
      .insert(environment)
      .values({ displayName: 'Test Environment', organizationId, realmId })
      .returning({ id: environment.id })

    const environmentResourceId = await registerResource(db, {
      kind: 'environment',
      itemId: insertedEnvironment!.id,
      organizationId,
      parentId: realmResourceId,
    })

    await db.insert(access).values({
      subjectKind: 'user',
      subjectId: userId,
      resourceId: orgResourceId,
      effect: 'allow',
      accessProfileKey: 'owner',
      permissionKey: null,
    })

    await db.insert(access).values({
      subjectKind: 'user',
      subjectId: userId,
      resourceId: realmResourceId,
      effect: 'deny',
      accessProfileKey: 'owner',
      permissionKey: null,
    })

    const canRealmWrite = await can(db, userId, 'realm:rw', realmResourceId)
    const canEnvironmentWrite = await can(db, userId, 'environment:rw', environmentResourceId)
    const canOrgWrite = await can(db, userId, 'organization:rw', orgResourceId)

    if (canRealmWrite) {
      throw new Error('nearer deny on realm should revoke inherited realm:rw')
    }
    if (canEnvironmentWrite) {
      throw new Error('nearer deny on realm should revoke inherited environment:rw on descendant')
    }
    if (!canOrgWrite) {
      throw new Error('deny on realm should not affect organization:rw on org')
    }
  })
})

Deno.test('cross-org subject grant works', async () => {
  await withTestFixtures(async ({ db, orgResourceId, realmResourceId }) => {
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

      await db.insert(access).values({
        subjectKind: 'user',
        subjectId: userBId,
        resourceId: orgResourceId,
        effect: 'allow',
        accessProfileKey: 'member',
        permissionKey: null,
      })

      const canOrgRead = await can(db, userBId, 'organization:ro', orgResourceId)
      const canRealmRead = await can(db, userBId, 'realm:ro', realmResourceId)

      if (!canOrgRead) {
        throw new Error('cross-org user grant should allow organization:ro on org A')
      }
      if (!canRealmRead) {
        throw new Error('cross-org user grant should inherit realm:ro from org A')
      }
    } finally {
      await db.delete(access).where(eq(access.subjectId, userBId))
      await db.delete(member).where(and(
        eq(member.userId, userBId),
        eq(member.organizationId, organizationIdB),
      ))
      await db.delete(resource).where(eq(resource.organizationId, organizationIdB))
      await db.delete(realm).where(eq(realm.organizationId, organizationIdB))
      await db.delete(user).where(eq(user.id, userBId))
      await db.delete(organization).where(eq(organization.id, organizationIdB))
    }
  })
})

Deno.test('superadmin bypass', async () => {
  await withTestFixtures(async ({ db, organizationId, orgResourceId, realmResourceId, realmId }) => {
    const superadminEmail = `evaluator-superadmin-${crypto.randomUUID()}@example.com`

    const insertedSuperadmin = await db
      .insert(user)
      .values({ email: superadminEmail, isEmailVerified: true, role: 'superadmin' })
      .returning({ id: user.id })

    const superadminId = insertedSuperadmin[0]!.id

    try {
      const canRealmWrite = await can(db, superadminId, 'realm:rw', realmResourceId)
      const canBilling = await can(db, superadminId, 'organization:billing', orgResourceId)

      if (!canRealmWrite) throw new Error('superadmin should bypass realm:rw check')
      if (!canBilling) throw new Error('superadmin should bypass organization:billing check')

      const visible = await listVisible(db, {
        kind: 'realm',
        userId: superadminId,
        organizationId,
      })

      if (!visible.includes(realmId)) {
        throw new Error('superadmin listVisible should include all realms in org')
      }
    } finally {
      await db.delete(user).where(eq(user.id, superadminId))
    }
  })
})
