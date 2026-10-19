/**
 * The orphan folder alert against a real Postgres: one alert per orphan, one
 * alert per server and organization, a second sweep that says nothing, a
 * folder that stops being an orphan and is left behind again, and the inbox
 * row a manager really receives. Skipped without TURBOPANEL_DATABASE_URL, the
 * way every Postgres suite is.
 */
import { skipWithoutDatabase } from '../../test-fixtures/require-service.test.support.ts'
import { assertEquals } from '@std/assert'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { createDenoDb, endDbConnection } from '../../db/connection.ts'
import { getDatabaseUrl } from '../../db/url.ts'
import { deriveEncryptionSecretsConfig, parseSecretsEnv } from '../../lib/secrets/secrets.ts'
import { TEST_ONLY_TURBOPANEL_SECRET } from '../../test-fixtures/secrets.ts'
import {
  folder,
  grant,
  notification,
  organization,
  principal,
  server,
  user,
} from '../../db/schema.ts'
import { alertNewOrphanFolders } from './folder-alerts.ts'
import type { emitNotification } from './emit.ts'

/** Sonar typescript:S2187 only recognizes `test()`; keep this alias. */
const test = Deno.test.bind(Deno)

const dbUrl = getDatabaseUrl()

type Db = ReturnType<typeof createDenoDb>
type EmitArgs = Parameters<typeof emitNotification>

type World = {
  db: Db
  organizationId: string
  managerId: string
  serverA: string
  serverB: string
  principalId: string
  otherOrganizationId: string
  otherServer: string
  otherPrincipalId: string
}

async function withWorld(fn: (world: World) => Promise<void>): Promise<void> {
  if (!dbUrl) {
    skipWithoutDatabase('orphan folder alert tests')
    return
  }
  const db = createDenoDb()
  const suffix = crypto.randomUUID().slice(0, 8).replaceAll('-', '')
  const [org] = await db
    .insert(organization)
    .values({ name: 'Orphan Alert Org' })
    .returning({ id: organization.id })
  const [other] = await db
    .insert(organization)
    .values({ name: 'Orphan Alert Other Org' })
    .returning({ id: organization.id })
  const [manager] = await db
    .insert(user)
    .values({
      email: `orphan-alert-${suffix}@example.com`,
      isEmailVerified: true,
      role: 'user',
    })
    .returning({ id: user.id })
  await db.insert(grant).values({
    entityType: 'organization',
    entityId: org!.id,
    actorType: 'user',
    actorId: manager!.id,
    permission: 'organization:manage',
  })
  const now = new Date().toISOString()
  const servers = await db
    .insert(server)
    .values([
      { organizationId: org!.id, name: 'Alpha', createdAt: now, updatedAt: now },
      { organizationId: org!.id, name: 'Beta', createdAt: now, updatedAt: now },
      { organizationId: other!.id, name: 'Gamma', createdAt: now, updatedAt: now },
    ])
    .returning({ id: server.id, name: server.name })
  const byName = (name: string) => servers.find((row) => row.name === name)!.id
  const [owner] = await db
    .insert(principal)
    .values({ organizationId: org!.id, username: `oa_${suffix}`, appliedUsername: `oa_${suffix}` })
    .returning({ id: principal.id })
  const [otherOwner] = await db
    .insert(principal)
    .values({
      organizationId: other!.id,
      username: `ob_${suffix}`,
      appliedUsername: `ob_${suffix}`,
    })
    .returning({ id: principal.id })
  const serverIds = servers.map((row) => row.id)
  try {
    await fn({
      db,
      organizationId: org!.id,
      managerId: manager!.id,
      serverA: byName('Alpha'),
      serverB: byName('Beta'),
      principalId: owner!.id,
      otherOrganizationId: other!.id,
      otherServer: byName('Gamma'),
      otherPrincipalId: otherOwner!.id,
    })
  } finally {
    await db.delete(folder).where(inArray(folder.serverId, serverIds))
    await db.delete(notification).where(eq(notification.organizationId, org!.id))
    await db.delete(notification).where(eq(notification.organizationId, other!.id))
    await db.delete(principal).where(inArray(principal.id, [owner!.id, otherOwner!.id]))
    await db.delete(server).where(inArray(server.id, serverIds))
    await db.delete(grant).where(and(eq(grant.actorId, manager!.id), eq(grant.entityId, org!.id)))
    await db.delete(user).where(eq(user.id, manager!.id))
    await db.delete(organization).where(inArray(organization.id, [org!.id, other!.id]))
    await endDbConnection(db)
  }
}

/** The one statement of the migration that stamps the orphans that already exist. */
async function backfillStatement(): Promise<string> {
  for await (const entry of Deno.readDir(new URL('../../../migrations/', import.meta.url))) {
    if (!entry.name.endsWith('_notification_orphan_and_certificate_events.sql')) continue
    const text = await Deno.readTextFile(
      new URL(`../../../migrations/${entry.name}`, import.meta.url)
    )
    const found = text
      .split('--> statement-breakpoint')
      .map((part) => part.trim())
      .find((part) => part.startsWith('UPDATE "folder" SET "orphan_alerted_at"'))
    if (found) return found
  }
  throw new Error('the migration does not stamp the orphans that already exist')
}

function recordingEmit() {
  const calls: EmitArgs[] = []
  const emit = ((...args: EmitArgs) => {
    calls.push(args)
    return Promise.resolve({} as Awaited<ReturnType<typeof emitNotification>>)
  }) as typeof emitNotification
  return { calls, emit }
}

async function addFolder(
  world: World,
  values: {
    serverId: string
    principalId?: string
    slug: string
    state?: string
    kind?: string
    scope?: string
  }
) {
  const [row] = await world.db
    .insert(folder)
    .values({
      serverId: values.serverId,
      principalId: values.principalId ?? world.principalId,
      scope: values.scope ?? 'production',
      kind: values.kind ?? 'service',
      slug: values.slug,
      state: values.state ?? 'orphan',
    })
    .returning({ id: folder.id })
  return row!.id
}

async function stamp(db: Db, id: string) {
  const [row] = await db
    .select({ alerted: folder.orphanAlertedAt, updatedAt: folder.updatedAt })
    .from(folder)
    .where(eq(folder.id, id))
  return row!
}

test('a new orphan sends one alert and a second sweep says nothing', async () => {
  await withWorld(async (world) => {
    const id = await addFolder(world, { serverId: world.serverA, slug: 'blog' })
    const before = await stamp(world.db, id)
    const { calls, emit } = recordingEmit()

    const first = await alertNewOrphanFolders(world.db, undefined, { emit })
    assertEquals({ alerts: first.alerts, folders: first.folders }, { alerts: 1, folders: 1 })
    assertEquals(calls.length, 1)
    const input = calls[0]![2]
    assertEquals(input.event, 'folder.orphans_found')
    assertEquals(input.organizationId, world.organizationId)
    assertEquals(input.targetId, world.serverA)
    assertEquals(input.context?.serverName, 'Alpha')
    assertEquals(input.context?.count, 1)
    assertEquals(input.context?.folders, 'Service blog (production)')

    const after = await stamp(world.db, id)
    assertEquals(after.alerted !== null, true)
    // Stamping the alert is not a change to the folder.
    assertEquals(after.updatedAt, before.updatedAt)

    const second = await alertNewOrphanFolders(world.db, undefined, { emit })
    assertEquals(second.alerts, 0)
    assertEquals(calls.length, 1)
  })
})

test('orphans on one server are one alert; another server is another alert', async () => {
  await withWorld(async (world) => {
    await addFolder(world, { serverId: world.serverA, slug: 'blog' })
    await addFolder(world, { serverId: world.serverA, slug: 'uploads', kind: 'volume' })
    await addFolder(world, { serverId: world.serverB, slug: 'shop' })
    const { calls, emit } = recordingEmit()

    const result = await alertNewOrphanFolders(world.db, undefined, { emit })
    assertEquals({ alerts: result.alerts, folders: result.folders }, { alerts: 2, folders: 3 })
    const byServer = new Map(calls.map((call) => [call[2].targetId, call[2].context]))
    assertEquals(byServer.get(world.serverA)?.count, 2)
    assertEquals(
      byServer.get(world.serverA)?.folders,
      'Service blog (production), volume uploads (production)'
    )
    assertEquals(byServer.get(world.serverB)?.count, 1)
  })
})

test('an organization is told only about its own orphans', async () => {
  await withWorld(async (world) => {
    await addFolder(world, {
      serverId: world.otherServer,
      principalId: world.otherPrincipalId,
      slug: 'x',
    })
    const { calls, emit } = recordingEmit()

    await alertNewOrphanFolders(world.db, undefined, { emit })
    assertEquals(calls.length, 1)
    assertEquals(calls[0]![2].organizationId, world.otherOrganizationId)
    assertEquals(calls[0]![2].context?.serverName, 'Gamma')
  })
})

test('only orphans count: a folder being removed or gone from the host says nothing', async () => {
  await withWorld(async (world) => {
    // The shared scope has no environment, so these rows need no asset or environment.
    for (const state of ['removing', 'missing']) {
      await addFolder(world, {
        serverId: world.serverA,
        slug: `s-${state}`,
        state,
        scope: 'common',
      })
    }
    const { calls, emit } = recordingEmit()

    const result = await alertNewOrphanFolders(world.db, undefined, { emit })
    assertEquals(result.alerts, 0)
    assertEquals(calls.length, 0)
  })
})

test('a folder that stops being an orphan is forgotten and alerts again when left behind again', async () => {
  await withWorld(async (world) => {
    const id = await addFolder(world, { serverId: world.serverA, slug: 'blog', scope: 'common' })
    const { calls, emit } = recordingEmit()
    await alertNewOrphanFolders(world.db, undefined, { emit })
    assertEquals(calls.length, 1)

    await world.db.update(folder).set({ state: 'removing' }).where(eq(folder.id, id))
    const cleared = await alertNewOrphanFolders(world.db, undefined, { emit })
    assertEquals(cleared.cleared, 1)
    assertEquals((await stamp(world.db, id)).alerted, null)
    assertEquals(calls.length, 1)

    await world.db.update(folder).set({ state: 'orphan' }).where(eq(folder.id, id))
    await alertNewOrphanFolders(world.db, undefined, { emit })
    assertEquals(calls.length, 2)
  })
})

/** What the real emitter does when it fails: logs, reports to the trace, returns the zero result. */
function failingEmit() {
  return ((_db, _secrets, _input, deps) => {
    deps?.trace?.('notification-emit-failed', { event: 'folder.orphans_found' })
    return Promise.resolve({ inbox: 0, deliveries: 0, sent: 0, failed: 0, held: 0 })
  }) as typeof emitNotification
}

test('a send that fails is logged, never thrown, and the next sweep tries again', async () => {
  await withWorld(async (world) => {
    const id = await addFolder(world, { serverId: world.serverA, slug: 'blog' })
    const failed = await alertNewOrphanFolders(world.db, undefined, { emit: failingEmit() })
    assertEquals(failed.alerts, 0)
    assertEquals((await stamp(world.db, id)).alerted, null)

    const { calls, emit } = recordingEmit()
    const retried = await alertNewOrphanFolders(world.db, undefined, { emit })
    assertEquals(retried.alerts, 1)
    assertEquals(calls.length, 1)
  })
})

test('a claim that cannot be given back does not stop the groups after it', async () => {
  await withWorld(async (world) => {
    await addFolder(world, { serverId: world.serverA, slug: 'blog' })
    await addFolder(world, { serverId: world.serverB, slug: 'shop' })
    let broken = false
    const flaky = new Proxy(world.db, {
      get(target, prop, receiver) {
        if (prop === 'update' && broken) {
          return () => {
            throw new Error('database went away')
          }
        }
        return Reflect.get(target, prop, receiver)
      },
    })
    const seen: string[] = []
    const emit = ((...args: EmitArgs) => {
      seen.push(args[2].targetId as string)
      // The first group fails to send; from then on giving a claim back fails too.
      if (seen.length === 1) {
        broken = true
        args[3]?.trace?.('notification-emit-failed', {})
      }
      return Promise.resolve({} as Awaited<ReturnType<typeof emitNotification>>)
    }) as typeof emitNotification

    const result = await alertNewOrphanFolders(flaky, undefined, { emit })
    assertEquals(seen.length, 2)
    assertEquals(result.alerts, 1)
  })
})

test('an emitter that throws is treated the same way', async () => {
  await withWorld(async (world) => {
    const id = await addFolder(world, { serverId: world.serverA, slug: 'blog' })
    const throwing = (() => Promise.reject(new Error('boom'))) as unknown as typeof emitNotification
    const failed = await alertNewOrphanFolders(world.db, undefined, { emit: throwing })
    assertEquals(failed.alerts, 0)
    assertEquals((await stamp(world.db, id)).alerted, null)
  })
})

test('an organization nobody manages is told nothing and is not retried for ever', async () => {
  await withWorld(async (world) => {
    // The other organization has no member at all: the real emitter finds no
    // one to tell, returns the zero result without a failure, and the stamp stays.
    const id = await addFolder(world, {
      serverId: world.otherServer,
      principalId: world.otherPrincipalId,
      slug: 'x',
    })
    const secrets = await deriveEncryptionSecretsConfig(
      parseSecretsEnv(`1:${TEST_ONLY_TURBOPANEL_SECRET}`, 'deno'),
      'data-encryption'
    )

    const first = await alertNewOrphanFolders(world.db, secrets)
    assertEquals(first.alerts, 1)
    assertEquals((await stamp(world.db, id)).alerted !== null, true)
    const second = await alertNewOrphanFolders(world.db, secrets)
    assertEquals(second.alerts, 0)
  })
})

test('an orphan stamped by the migration sends nothing', async () => {
  await withWorld(async (world) => {
    // The migration adds the column empty and then stamps every existing orphan,
    // so the first sweep after an upgrade does not announce folders that were
    // already known. Run that statement from the migration file itself.
    const id = await addFolder(world, { serverId: world.serverA, slug: 'old' })
    assertEquals((await stamp(world.db, id)).alerted, null)
    await world.db.execute(sql.raw(await backfillStatement()))
    assertEquals((await stamp(world.db, id)).alerted !== null, true)

    const { calls, emit } = recordingEmit()
    const result = await alertNewOrphanFolders(world.db, undefined, { emit })
    assertEquals(result.alerts, 0)
    assertEquals(calls.length, 0)
  })
})

test('a manager really receives the bell row with the plain sentence', async () => {
  await withWorld(async (world) => {
    await addFolder(world, { serverId: world.serverA, slug: 'blog' })
    const secrets = await deriveEncryptionSecretsConfig(
      parseSecretsEnv(`1:${TEST_ONLY_TURBOPANEL_SECRET}`, 'deno'),
      'data-encryption'
    )

    await alertNewOrphanFolders(world.db, secrets)

    const rows = await world.db
      .select({ title: notification.title, body: notification.body, userId: notification.userId })
      .from(notification)
      .where(
        and(
          eq(notification.organizationId, world.organizationId),
          eq(notification.event, 'folder.orphans_found')
        )
      )
    assertEquals(rows.length, 1)
    assertEquals(rows[0]!.userId, world.managerId)
    assertEquals(rows[0]!.title, 'A folder was left behind on Alpha')
    assertEquals(
      /Service blog \(production\) no longer belongs to a service or volume/.test(
        rows[0]!.body ?? ''
      ),
      true
    )
  })
})
