/**
 * Switching a server out of TurboFabric against a real Postgres, through the
 * route's own lifecycle code: the switch is written first and undone when the
 * tunnel cannot be taken down or when something comes to depend on the server
 * in between. Skipped without TURBOPANEL_DATABASE_URL, the way every Postgres
 * suite is.
 */
import { skipWithoutDatabase } from '../../test-fixtures/require-service.test.support.ts'
import { assertEquals } from '@std/assert'
import { eq } from 'drizzle-orm'
import type { Context } from 'hono'
import { getDatabaseUrl } from '../../db/url.ts'
import { createDenoDb, type Db, endDbConnection } from '../../db/connection.ts'
import { fabric, network, organization, relay, server, subnet } from '../../db/schema.ts'
import type { CommandQueue } from '../../features/commands/queue.ts'
import { applyServerFabricPatch } from './fabric-lifecycle.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const dbUrl = getDatabaseUrl()

/** Only what the lifecycle code reads from a Hono context. */
const fakeContext = {
  json: (body: unknown, status?: number) => Response.json(body, { status: status ?? 200 }),
} as unknown as Context

type Rig = {
  db: ReturnType<typeof createDenoDb>
  organizationId: string
  serverId: string
}

async function withRig(fn: (rig: Rig) => Promise<void>): Promise<void> {
  if (!dbUrl) {
    skipWithoutDatabase('TurboFabric switch-off route tests')
    return
  }
  const db = createDenoDb()
  const [org] = await db
    .insert(organization)
    .values({ name: 'Fabric Lifecycle Org' })
    .returning({ id: organization.id })
  const organizationId = org!.id
  try {
    const [srv] = await db
      .insert(server)
      .values({
        organizationId,
        name: 'switch-me',
        isConnected: true,
        statusChangedAt: new Date().toISOString(),
      })
      .returning({ id: server.id })
    const serverId = srv!.id
    const [fab] = await db
      .insert(fabric)
      .values({ organizationId, cidr: '10.250.0.0/16', options: null })
      .returning({ id: fabric.id })
    await db
      .insert(relay)
      .values({ fabricId: fab!.id, serverId, address: '10.250.0.1', prefix: '10.192.0.0/16' })
    await fn({ db, organizationId, serverId })
  } finally {
    await db.delete(subnet).where(eq(subnet.cidr, '10.192.1.0/24'))
    await db.delete(network).where(eq(network.organizationId, organizationId))
    const rows = await db
      .select({ id: server.id })
      .from(server)
      .where(eq(server.organizationId, organizationId))
    for (const row of rows) await db.delete(relay).where(eq(relay.serverId, row.id))
    await db.delete(fabric).where(eq(fabric.organizationId, organizationId))
    await db.delete(server).where(eq(server.organizationId, organizationId))
    await db.delete(organization).where(eq(organization.id, organizationId))
    await endDbConnection(db)
  }
}

function queue(fails: boolean): CommandQueue {
  return {
    enqueue: () => (fails ? Promise.reject(new Error('queue down')) : Promise.resolve()),
  } as unknown as CommandQueue
}

function switchOff(db: Db, rig: Rig, commandQueue: CommandQueue): Promise<Response | null> {
  return applyServerFabricPatch(fakeContext, {
    db,
    commandQueue,
    organizationId: rig.organizationId,
    actorId: crypto.randomUUID(),
    secrets: {},
    serverId: rig.serverId,
    serverName: 'switch-me',
    currentlyEnabled: true,
    patch: { enabled: false },
  })
}

async function switchedOn(db: Db, serverId: string): Promise<boolean> {
  const [row] = await db
    .select({ on: server.isFabricEnabled })
    .from(server)
    .where(eq(server.id, serverId))
  return row!.on
}

async function relayKept(db: Db, serverId: string): Promise<boolean> {
  const rows = await db.select({ id: relay.id }).from(relay).where(eq(relay.serverId, serverId))
  return rows.length === 1
}

test('switching off writes the switch, keeps the relay and takes the tunnel down', async () => {
  await withRig(async (rig) => {
    const refused = await switchOff(rig.db, rig, queue(false))
    assertEquals(refused, null)
    assertEquals(await switchedOn(rig.db, rig.serverId), false)
    assertEquals(await relayKept(rig.db, rig.serverId), true)
  })
})

test('switching off is undone when the tunnel cannot be taken down', async () => {
  await withRig(async (rig) => {
    const refused = await switchOff(rig.db, rig, queue(true))
    assertEquals(refused?.status, 503)
    assertEquals(((await refused!.json()) as { error: string }).error, 'fabric_teardown_not_queued')
    assertEquals(await switchedOn(rig.db, rig.serverId), true)
    assertEquals(await relayKept(rig.db, rig.serverId), true)
  })
})

/**
 * A database handle that, right after the switch is written, lets a deploy
 * create a cross-server network piece on the server: the race the check after
 * the write is there for.
 */
function racingDb(db: ReturnType<typeof createDenoDb>, rig: Rig): Db {
  let raced = false
  const race = async () => {
    const [net] = await db
      .insert(network)
      .values({ organizationId: rig.organizationId, kind: 'compose', name: 'tpn_race' })
      .returning({ id: network.id })
    await db
      .insert(subnet)
      .values({ networkId: net!.id, serverId: rig.serverId, cidr: '10.192.1.0/24' })
  }
  return new Proxy(db, {
    get(target, key, receiver) {
      if (key !== 'update') return Reflect.get(target, key, receiver)
      return (table: unknown) => {
        const builder = target.update(table as typeof server)
        if (table !== server) return builder
        return {
          set: (values: { isFabricEnabled?: boolean }) => {
            const pending = builder.set(values)
            return {
              where: async (condition: Parameters<typeof pending.where>[0]) => {
                const result = await pending.where(condition)
                if (values.isFabricEnabled === false && !raced) {
                  raced = true
                  await race()
                }
                return result
              },
            }
          },
        }
      }
    },
  }) as unknown as Db
}

test('a network created on the server while switching off undoes the switch', async () => {
  await withRig(async (rig) => {
    const refused = await switchOff(racingDb(rig.db, rig), rig, queue(false))
    assertEquals(refused?.status, 409)
    const body = (await refused!.json()) as { error: string; message: string }
    assertEquals(body.error, 'fabric_server_in_use')
    assertEquals(body.message.includes('container network "tpn_race"'), true)
    assertEquals(await switchedOn(rig.db, rig.serverId), true)
  })
})
