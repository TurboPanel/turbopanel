import { and, eq } from 'drizzle-orm'
import { createDenoDb } from '../db.ts'
import {
  access,
  member,
  organization,
  realm,
  resource,
  user,
} from '../db/schema.ts'
import { defaultInvitationGrants, materializeInvitationGrants } from '../auth/invitation-grants.ts'
import { registerResource } from './resource-registry.ts'
import { can } from './evaluator.ts'
import type { PermissionKey } from './catalog.ts'

const dbUrl = Deno.env.get('TURBOPANEL_DATABASE_URL')?.trim() ??
  Deno.env.get('DATABASE_URL')?.trim()

const WRITE_PERMISSIONS: PermissionKey[] = [
  'realm:rw',
  'environment:rw',
  'project:rw',
  'service:rw',
  'hosting:rw',
]

async function withTestFixtures(
  fn: (ctx: {
    db: ReturnType<typeof createDenoDb>
    userId: string
    organizationId: string
    orgResourceId: string
    realmResourceId: string
  }) => Promise<void>,
): Promise<void> {
  if (!dbUrl) {
    console.warn('Skipping authz tests: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()

  const email = `member-test-${crypto.randomUUID()}@example.com`
  const now = new Date().toISOString()

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

  const orgResourceId = await registerResource(db, {
    kind: 'organization',
    itemId: organizationId,
    organizationId,
  })

  const grants = defaultInvitationGrants(organizationId)
  await materializeInvitationGrants(db, userId, grants)

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
    })
  } finally {
    await db.delete(access).where(eq(access.subjectId, userId))
    await db.delete(member).where(and(
      eq(member.userId, userId),
      eq(member.organizationId, organizationId),
    ))
    await db.delete(resource).where(eq(resource.organizationId, organizationId))
    await db.delete(realm).where(eq(realm.organizationId, organizationId))
    await db.delete(user).where(eq(user.id, userId))
    await db.delete(organization).where(eq(organization.id, organizationId))
  }
}

Deno.test('default invited member has read-only baseline on organization', async () => {
  await withTestFixtures(async ({ db, userId, orgResourceId }) => {
    const canRead = await can(db, userId, 'organization:ro', orgResourceId)
    const canWrite = await can(db, userId, 'organization:rw', orgResourceId)
    const canManageMembers = await can(
      db,
      userId,
      'organization:members',
      orgResourceId,
    )

    if (!canRead) throw new Error('expected organization:ro')
    if (canWrite) throw new Error('member must not have organization:rw')
    if (canManageMembers) {
      throw new Error('member must not have organization:members')
    }
  })
})

Deno.test('default invited member cannot mutate realm-tree resources', async () => {
  await withTestFixtures(async ({ db, userId, orgResourceId, realmResourceId }) => {
    for (const permissionKey of WRITE_PERMISSIONS) {
      const allowedOnOrg = await can(db, userId, permissionKey, orgResourceId)
      if (allowedOnOrg) {
        throw new Error(`member must not have ${permissionKey} on organization`)
      }

      const allowedOnRealm = await can(db, userId, permissionKey, realmResourceId)
      if (allowedOnRealm) {
        throw new Error(`member must not have ${permissionKey} on realm`)
      }
    }
  })
})

Deno.test('elevated manager access profile grants realm write after explicit grant', async () => {
  await withTestFixtures(async ({ db, userId, realmResourceId }) => {
    await db.insert(access).values({
      subjectKind: 'user',
      subjectId: userId,
      resourceId: realmResourceId,
      effect: 'allow',
      accessProfileKey: 'manager',
      permissionKey: null,
    })

    const allowed = await can(db, userId, 'realm:rw', realmResourceId)
    if (!allowed) throw new Error('manager grant should allow realm:rw')
  })
})
