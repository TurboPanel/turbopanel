/**
 * Preferences against a real Postgres: what a delete or a departure removes
 * (and what it leaves alone), copies that must never go out, reading in the
 * bell cancelling a held email, and one-click unsubscribe. Skipped without
 * TURBOPANEL_DATABASE_URL, the way every Postgres suite is.
 */
import { skipWithoutDatabase } from '../../test-fixtures/require-service.test.support.ts'
import { assertEquals } from '@std/assert'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { createDenoDb, endDbConnection } from '../../db/connection.ts'
import { getDatabaseUrl } from '../../db/url.ts'
import {
  environment,
  grant,
  notification,
  notificationChannel,
  notificationDelivery,
  notificationPreference,
  organization,
  project,
  team,
  teammate,
  user,
  workspace,
} from '../../db/schema.ts'
import { emitNotification, retryDueDeliveries } from './emit.ts'
import { forgetMember } from './cleanup.ts'
import { ensureNotificationCatalog } from './fanout-records.ts'
import {
  createNotificationChannel,
  markNotificationsRead,
  replaceRulesForChannel,
  setChannelHoldSettings,
} from './records.ts'
import { applyUnsubscribe, unsubscribeClaims } from './unsubscribe.ts'

const test = Deno.test.bind(Deno)

const dbUrl = getDatabaseUrl()

type Db = ReturnType<typeof createDenoDb>

type Org = { id: string; teamId: string; projectId: string; environmentId: string }

async function makeOrganization(db: Db, name: string): Promise<Org> {
  const [org] = await db.insert(organization).values({ name }).returning({ id: organization.id })
  const [t] = await db
    .insert(team)
    .values({ name: `${name} Team`, organizationId: org!.id })
    .returning({ id: team.id })
  const [ws] = await db
    .insert(workspace)
    .values({ name: `${name} Workspace`, organizationId: org!.id })
    .returning({ id: workspace.id })
  const [proj] = await db
    .insert(project)
    .values({
      name: `${name} Project ${crypto.randomUUID().slice(0, 8)}`,
      workspaceId: ws!.id,
      organizationId: org!.id,
    })
    .returning({ id: project.id })
  const [env] = await db
    .insert(environment)
    .values({ name: 'production', projectId: proj!.id })
    .returning({ id: environment.id })
  return { id: org!.id, teamId: t!.id, projectId: proj!.id, environmentId: env!.id }
}

async function withTwoOrganizations(
  fn: (ctx: { db: Db; a: Org; b: Org; userId: string; email: string }) => Promise<void>
): Promise<void> {
  if (!dbUrl) {
    skipWithoutDatabase('notification preference tests')
    return
  }
  const db = createDenoDb()
  await ensureNotificationCatalog(db)
  const email = `prefs-${crypto.randomUUID()}@example.com`
  const [u] = await db
    .insert(user)
    .values({ email, isEmailVerified: true, role: 'user' })
    .returning({ id: user.id })
  const a = await makeOrganization(db, 'Prefs A')
  const b = await makeOrganization(db, 'Prefs B')
  await db.insert(teammate).values([
    { teamId: a.teamId, userId: u!.id },
    { teamId: b.teamId, userId: u!.id },
  ])
  try {
    await fn({ db, a, b, userId: u!.id, email })
  } finally {
    // Environments and projects hold their parents with RESTRICT keys: children first.
    await db.delete(environment).where(inArray(environment.projectId, [a.projectId, b.projectId]))
    await db.delete(project).where(inArray(project.id, [a.projectId, b.projectId]))
    await db.delete(workspace).where(inArray(workspace.organizationId, [a.id, b.id]))
    await db.delete(organization).where(inArray(organization.id, [a.id, b.id]))
    await db.delete(user).where(eq(user.id, u!.id))
    await endDbConnection(db)
  }
}

async function preferenceIds(db: Db, userId: string): Promise<string[]> {
  const rows = await db
    .select({ id: notificationPreference.id })
    .from(notificationPreference)
    .where(eq(notificationPreference.userId, userId))
  return rows.map((r) => r.id).toSorted((x, y) => x.localeCompare(y))
}

async function addRow(db: Db, values: typeof notificationPreference.$inferInsert): Promise<string> {
  const [row] = await db
    .insert(notificationPreference)
    .values(values)
    .returning({ id: notificationPreference.id })
  return row!.id
}

test('nothing is on by default: a member with no rows gets no bell row', async () => {
  await withTwoOrganizations(async ({ db, a, userId }) => {
    const result = await emitNotification(db, undefined, {
      event: 'server.offline',
      organizationId: a.id,
      context: { serverName: 'db-1' },
    })
    assertEquals(result.inbox, 0)
    const rows = await db.select().from(notification).where(eq(notification.userId, userId))
    assertEquals(rows.length, 0)
  })
})

test('one organization set to none is silent while the other still arrives', async () => {
  await withTwoOrganizations(async ({ db, a, b, userId }) => {
    await addRow(db, { userId, kind: 'inbox', level: 'warning' })
    await addRow(db, { userId, organizationId: b.id, level: 'none' })
    const fromA = await emitNotification(db, undefined, {
      event: 'server.offline',
      organizationId: a.id,
      context: { serverName: 'a-1' },
    })
    const fromB = await emitNotification(db, undefined, {
      event: 'server.offline',
      organizationId: b.id,
      context: { serverName: 'b-1' },
    })
    assertEquals(fromA.inbox, 1)
    assertEquals(fromB.inbox, 0)
  })
})

test('deleting a project removes only the rows that name it', async () => {
  await withTwoOrganizations(async ({ db, a, b, userId }) => {
    const keepGlobal = await addRow(db, { userId, kind: 'inbox', level: 'all' })
    const keepOrg = await addRow(db, { userId, organizationId: a.id, level: 'critical' })
    const keepOther = await addRow(db, {
      userId,
      organizationId: b.id,
      projectId: b.projectId,
      level: 'all',
    })
    await addRow(db, { userId, organizationId: a.id, projectId: a.projectId, level: 'all' })
    await addRow(db, {
      userId,
      organizationId: a.id,
      projectId: a.projectId,
      environmentId: a.environmentId,
      kind: 'email',
      level: 'none',
    })
    await db.delete(environment).where(eq(environment.projectId, a.projectId))
    await db.delete(project).where(eq(project.id, a.projectId))
    assertEquals(
      await preferenceIds(db, userId),
      [keepGlobal, keepOrg, keepOther].toSorted((x, y) => x.localeCompare(y))
    )
  })
})

test('a project row must name a project of its own organization', async () => {
  await withTwoOrganizations(async ({ db, a, b, userId }) => {
    let refused = false
    try {
      await addRow(db, { userId, organizationId: a.id, projectId: b.projectId, level: 'all' })
    } catch {
      refused = true
    }
    assertEquals(refused, true)
  })
})

test('leaving one organization forgets only that organization, and its email channel naming them', async () => {
  await withTwoOrganizations(async ({ db, a, b, userId, email }) => {
    const keepGlobal = await addRow(db, { userId, kind: 'inbox', level: 'all' })
    await addRow(db, { userId, organizationId: a.id, level: 'all' })
    const keepB = await addRow(db, { userId, organizationId: b.id, level: 'all' })
    const channelA = await createNotificationChannel(db, undefined, {
      scope: 'organization',
      organizationId: a.id,
      kind: 'email',
      label: 'Ops',
      address: email.toUpperCase(),
      verifiedAt: new Date().toISOString(),
    })
    const channelB = await createNotificationChannel(db, undefined, {
      scope: 'organization',
      organizationId: b.id,
      kind: 'email',
      label: 'Ops',
      address: email,
      verifiedAt: new Date().toISOString(),
    })
    await db.delete(teammate).where(eq(teammate.teamId, a.teamId))
    await forgetMember(db, a.id, userId, email)
    assertEquals(
      await preferenceIds(db, userId),
      [keepGlobal, keepB].toSorted((x, y) => x.localeCompare(y))
    )
    const channels = await db
      .select({ id: notificationChannel.id })
      .from(notificationChannel)
      .where(inArray(notificationChannel.id, [channelA.id, channelB.id]))
    assertEquals(
      channels.map((c) => c.id),
      [channelB.id]
    )
    // They no longer belong to A: nothing from A reaches them, B still does.
    const fromA = await emitNotification(db, undefined, {
      event: 'server.offline',
      organizationId: a.id,
    })
    const fromB = await emitNotification(db, undefined, {
      event: 'server.offline',
      organizationId: b.id,
    })
    assertEquals(fromA.inbox, 0)
    assertEquals(fromB.inbox, 1)
  })
})

test('an organization email channel naming someone who left is never sent to', async () => {
  await withTwoOrganizations(async ({ db, a, email }) => {
    const channel = await createNotificationChannel(db, undefined, {
      scope: 'organization',
      organizationId: a.id,
      kind: 'email',
      label: 'Ops',
      address: email,
      verifiedAt: new Date().toISOString(),
    })
    await replaceRulesForChannel(db, channel.id, [{ event: '*', minSeverity: 'info' }])
    // Removed by a team edit, not the member-removal route.
    await db.delete(teammate).where(eq(teammate.teamId, a.teamId))
    const jobs: unknown[] = []
    await emitNotification(
      db,
      undefined,
      { event: 'server.offline', organizationId: a.id },
      {
        email: {
          queue: { enqueue: (job) => Promise.resolve(void jobs.push(job)) },
          from: 'n@example.com',
        },
      }
    )
    assertEquals(jobs.length, 0)
    const [row] = await db
      .select({ status: notificationDelivery.status, reason: notificationDelivery.reason })
      .from(notificationDelivery)
      .where(eq(notificationDelivery.channelId, channel.id))
    assertEquals(row, { status: 'abandoned', reason: 'no_access' })
  })
})

test('a held copy whose project was deleted is dropped, and reading in the bell cancels a held email', async () => {
  await withTwoOrganizations(async ({ db, a, userId }) => {
    await addRow(db, { userId, level: 'all' })
    // A manager, so the routine (not urgent) deletion notice is theirs.
    await db.insert(grant).values({
      entityType: 'organization',
      entityId: a.id,
      actorType: 'user',
      actorId: userId,
      permission: 'organization:manage',
    })
    const [primary] = await db
      .insert(notificationChannel)
      .values({
        scope: 'user',
        userId,
        kind: 'email',
        label: 'Account email',
        address: 'x@example.com',
        isPrimary: true,
        verifiedAt: new Date().toISOString(),
      })
      .returning()
    await setChannelHoldSettings(db, primary!.id, { digestCadence: 'daily', quiet: null })
    // A routine event about the project is held for the digest.
    const held = await emitNotification(db, undefined, {
      event: 'server.deleted',
      organizationId: a.id,
      scope: { projectId: a.projectId },
    })
    assertEquals(held.held, 1)
    await db.delete(environment).where(eq(environment.projectId, a.projectId))
    await db.delete(project).where(eq(project.id, a.projectId))
    await retryDueDeliveries(db, undefined)
    const statuses = await db
      .select({ status: notificationDelivery.status, reason: notificationDelivery.reason })
      .from(notificationDelivery)
      .where(eq(notificationDelivery.channelId, primary!.id))
    assertEquals(statuses, [{ status: 'abandoned', reason: 'scope_deleted' }])

    // Another held one, read in the bell: its email is cancelled.
    const second = await emitNotification(db, undefined, {
      event: 'server.deleted',
      organizationId: a.id,
    })
    assertEquals(second.held, 1)
    const [row] = await db
      .select({ id: notification.id })
      .from(notification)
      .where(and(eq(notification.userId, userId), eq(notification.organizationId, a.id)))
      .orderBy(desc(notification.createdAt))
      .limit(1)
    await markNotificationsRead(db, userId, [row!.id])
    const after = await db
      .select({ reason: notificationDelivery.reason })
      .from(notificationDelivery)
      .where(
        and(
          eq(notificationDelivery.channelId, primary!.id),
          eq(notificationDelivery.status, 'abandoned')
        )
      )
    assertEquals(after.map((r) => r.reason).toSorted(), ['read_in_app', 'scope_deleted'])
  })
})

test('one-click unsubscribe writes one none row for email, and only for members', async () => {
  await withTwoOrganizations(async ({ db, a, userId }) => {
    const claims = unsubscribeClaims({
      userId,
      organizationId: a.id,
      projectId: a.projectId,
      categoryCode: 'servers',
    })
    assertEquals(await applyUnsubscribe(db, claims), true)
    assertEquals(await applyUnsubscribe(db, claims), true)
    const rows = await db
      .select({ kind: notificationPreference.kind, level: notificationPreference.level })
      .from(notificationPreference)
      .where(eq(notificationPreference.userId, userId))
    assertEquals(rows, [{ kind: 'email', level: 'none' }])
    await db.delete(teammate).where(eq(teammate.teamId, a.teamId))
    assertEquals(await applyUnsubscribe(db, { ...claims, categoryCode: 'access' }), false)
  })
})
