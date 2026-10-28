/**
 * Sending tunnel connectors against a real database: a carrying server is told
 * to run the tunnel with its token sealed for that server alone, an unchanged
 * list is not sent again, a tunnel that moved or was removed is taken off, a
 * list that failed is repeated, and offline, old-daemon or foreign servers are
 * left alone. Skips without TURBOPANEL_DATABASE_URL.
 */
import { skipWithoutDatabase } from '../../test-fixtures/require-service.test.support.ts'
import { assert, assertEquals, assertFalse } from '@std/assert'
import { eq, sql } from 'drizzle-orm'
import { createDenoDb, endDbConnection } from '../../db/connection.ts'
import { getDatabaseUrl } from '../../db/url.ts'
import { command, key, organization, portal, secret, server, tunnel } from '../../db/schema.ts'
import { parseTunnelConnectorsPayload } from '../../contracts/commands/tunnel-connectors.ts'
import { encryptSecret } from '../../lib/secrets/data-encryption.ts'
import { deriveEncryptionSecretsConfig } from '../../lib/secrets/secrets.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import { TUNNEL_CONNECTOR_FEATURE } from '../../lib/version-wire.ts'
import { getCommandDispatchPayload } from '../commands/command-records.ts'
import type { CommandEnvelope } from '../commands/envelope.ts'
import { RUN_SECRET_PROVIDER } from './vocabulary.ts'
import { runTunnelConnectorsSweepTick, syncServerTunnelConnectors } from './connector-sync.ts'

/** Sonar only recognises `test()`; see the note in the other suites. */
const test = Deno.test.bind(Deno)

const dbUrl = getDatabaseUrl()
type TestDb = ReturnType<typeof createDenoDb>

/** A made-up run token; built so no scanner mistakes it for a real one. */
const FIXTURE_TOKEN = 'T'.repeat(48)

async function ageLastSend(db: TestDb, serverId: string): Promise<void> {
  await db
    .update(server)
    .set({
      metadata: sql`jsonb_set(${server.metadata}, '{tunnelConnectors,sentAt}', to_jsonb(${new Date(Date.now() - 3_600_000).toISOString()}::text))`,
    })
    .where(eq(server.id, serverId))
}

type Ctx = {
  db: TestDb
  organizationId: string
  serverId: string
  queued: CommandEnvelope[]
  deps: Parameters<typeof syncServerTunnelConnectors>[1]
  /** A tunnel of this organization carried by the server. Returns its provider id. */
  addTunnel: (name: string, options?: { externalId?: string | null }) => Promise<string>
  /** Take a tunnel off the server (its portal row), as a placement change does. */
  moveAway: (providerId: string) => Promise<void>
  removeTunnel: (providerId: string) => Promise<void>
}

async function withServer(
  options: { connected: boolean; features: string[] },
  fn: (ctx: Ctx) => Promise<void>
): Promise<void> {
  if (!dbUrl) {
    skipWithoutDatabase('tunnel connector tests')
    return
  }
  const db = createDenoDb()
  const secretsConfig = parseTestSecretsConfig('deno')
  const dataEncryptionSecrets = await deriveEncryptionSecretsConfig(
    secretsConfig,
    'data-encryption'
  )
  const queued: CommandEnvelope[] = []
  const [org] = await db.insert(organization).values({ name: 'Tunnel Connector Org' }).returning()
  const organizationId = org!.id
  const [row] = await db
    .insert(server)
    .values({
      organizationId,
      name: 'Connector Server',
      isConnected: options.connected,
      daemon: { projection: { features: options.features } },
    })
    .returning({ id: server.id })
  const serverId = row!.id
  await db.insert(key).values({
    serverId,
    algorithm: 'Ed25519',
    publicJwk: { kty: 'OKP', crv: 'Ed25519', x: 'A'.repeat(43) },
    fingerprint: `fp-${crypto.randomUUID()}`,
  })
  const tunnelIds = new Map<string, string>()
  const secretIds: string[] = []
  const ctx: Ctx = {
    db,
    organizationId,
    serverId,
    queued,
    deps: {
      commandQueue: {
        enqueue: (envelope) => {
          queued.push(envelope)
          return Promise.resolve()
        },
      },
      secretsConfig,
      dataEncryptionSecrets,
    },
    addTunnel: async (name, opts = {}) => {
      const providerId = opts.externalId === undefined ? crypto.randomUUID() : opts.externalId
      const [sealed] = await db
        .insert(secret)
        .values({
          organizationId,
          provider: RUN_SECRET_PROVIDER,
          name: `${name} run token`,
          secretEnvelope: await encryptSecret(dataEncryptionSecrets, FIXTURE_TOKEN),
        })
        .returning({ id: secret.id })
      secretIds.push(sealed!.id)
      const [t] = await db
        .insert(tunnel)
        .values({
          organizationId,
          routingOrganizationId: organizationId,
          provider: 'cloudflare',
          name,
          externalId: providerId,
          placement: 'chosen',
          secretId: sealed!.id,
        })
        .returning({ id: tunnel.id })
      await db.insert(portal).values({ tunnelId: t!.id, serverId, wanted: 'run' })
      tunnelIds.set(providerId ?? name, t!.id)
      return providerId ?? name
    },
    moveAway: async (providerId) => {
      await db.delete(portal).where(eq(portal.tunnelId, tunnelIds.get(providerId)!))
    },
    removeTunnel: async (providerId) => {
      const id = tunnelIds.get(providerId)!
      await db.delete(portal).where(eq(portal.tunnelId, id))
      await db.delete(tunnel).where(eq(tunnel.id, id))
    },
  }
  try {
    await fn(ctx)
  } finally {
    await db.delete(command).where(eq(command.serverId, serverId))
    for (const id of tunnelIds.values()) {
      await db.delete(portal).where(eq(portal.tunnelId, id))
      await db.delete(tunnel).where(eq(tunnel.id, id))
    }
    for (const id of secretIds) await db.delete(secret).where(eq(secret.id, id))
    await db.delete(key).where(eq(key.serverId, serverId))
    await db.delete(server).where(eq(server.id, serverId))
    await db.delete(organization).where(eq(organization.id, organizationId))
    await endDbConnection(db)
  }
}

async function sentPayload(c: Ctx, index = c.queued.length - 1) {
  return parseTunnelConnectorsPayload(
    await getCommandDispatchPayload(c.db, c.queued[index]!.commandId)
  )
}

test('an offline server and an old daemon are skipped', async () => {
  await withServer({ connected: false, features: [TUNNEL_CONNECTOR_FEATURE] }, async (c) => {
    await c.addTunnel('Offline')
    assertEquals(await syncServerTunnelConnectors(c.db, c.deps, c), {
      status: 'skipped',
      reason: 'server offline',
    })
  })
  await withServer({ connected: true, features: ['tunnel-forwarding-v1'] }, async (c) => {
    await c.addTunnel('Old')
    assertEquals(await syncServerTunnelConnectors(c.db, c.deps, c), {
      status: 'skipped',
      reason: 'daemon too old',
    })
    assertEquals(c.queued.length, 0)
  })
})

test('a server that should run nothing and never ran anything is left alone', async () => {
  await withServer({ connected: true, features: [TUNNEL_CONNECTOR_FEATURE] }, async (c) => {
    assertEquals(await syncServerTunnelConnectors(c.db, c.deps, c), { status: 'unchanged' })
    assertEquals(c.queued.length, 0)
  })
})

test('a carrying server is sent the tunnel with its token sealed for the daemon', async () => {
  await withServer({ connected: true, features: [TUNNEL_CONNECTOR_FEATURE] }, async (c) => {
    const providerId = await c.addTunnel('Front')
    const outcome = await syncServerTunnelConnectors(c.db, c.deps, c)
    assertEquals(outcome.status, 'sent')
    const payload = await sentPayload(c)
    assertEquals(payload.remove, [])
    assertEquals(payload.install.length, 1)
    assertEquals(payload.install[0]!.tunnelId, providerId)
    assert(payload.install[0]!.tokenEnvelope.startsWith('tpdaemon.'))
    // The stored command never holds the token in the clear.
    const raw = JSON.stringify(await getCommandDispatchPayload(c.db, c.queued[0]!.commandId))
    assertFalse(raw.includes(FIXTURE_TOKEN))
    // An unchanged list that is still moving is not sent again.
    assertEquals(await syncServerTunnelConnectors(c.db, c.deps, c), { status: 'unchanged' })
    assertEquals(c.queued.length, 1)
  })
})

test('a tunnel without a usable provider id is not sent', async () => {
  await withServer({ connected: true, features: [TUNNEL_CONNECTOR_FEATURE] }, async (c) => {
    await c.addTunnel('Not Made Yet', { externalId: null })
    await c.addTunnel('Odd Id', { externalId: 'instance' })
    assertEquals(await syncServerTunnelConnectors(c.db, c.deps, c), { status: 'unchanged' })
    assertEquals(c.queued.length, 0)
  })
})

test('a tunnel that moved away, or was removed, is taken off the server', async () => {
  await withServer({ connected: true, features: [TUNNEL_CONNECTOR_FEATURE] }, async (c) => {
    const keep = await c.addTunnel('Keep')
    const moved = await c.addTunnel('Moved')
    const gone = await c.addTunnel('Gone')
    assertEquals((await syncServerTunnelConnectors(c.db, c.deps, c)).status, 'sent')
    assertEquals((await sentPayload(c)).install.length, 3)
    await ageLastSend(c.db, c.serverId)
    await c.db.update(command).set({ status: 'succeeded' }).where(eq(command.serverId, c.serverId))
    await c.moveAway(moved)
    await c.removeTunnel(gone)
    assertEquals((await syncServerTunnelConnectors(c.db, c.deps, c)).status, 'sent')
    const second = await sentPayload(c)
    assertEquals(
      second.install.map((entry) => entry.tunnelId),
      [keep]
    )
    assertEquals(second.remove, [moved, gone].toSorted())
  })
})

test('a list that failed is sent again after the gap, and one that finished is not', async () => {
  await withServer({ connected: true, features: [TUNNEL_CONNECTOR_FEATURE] }, async (c) => {
    await c.addTunnel('Retry')
    assertEquals((await syncServerTunnelConnectors(c.db, c.deps, c)).status, 'sent')
    await c.db.update(command).set({ status: 'failed' }).where(eq(command.serverId, c.serverId))
    // Failed, but sent a moment ago: wait out the gap.
    assertEquals(await syncServerTunnelConnectors(c.db, c.deps, c), { status: 'unchanged' })
    await ageLastSend(c.db, c.serverId)
    assertEquals((await syncServerTunnelConnectors(c.db, c.deps, c)).status, 'sent')
    assertEquals(c.queued.length, 2)
    await c.db.update(command).set({ status: 'succeeded' }).where(eq(command.serverId, c.serverId))
    await ageLastSend(c.db, c.serverId)
    assertEquals(await syncServerTunnelConnectors(c.db, c.deps, c), { status: 'unchanged' })
  })
})

test('the sweep sends a server that should run a tunnel and one that must drop it', async () => {
  await withServer({ connected: true, features: [TUNNEL_CONNECTOR_FEATURE] }, async (c) => {
    const providerId = await c.addTunnel('Swept')
    const first = await runTunnelConnectorsSweepTick(c.db, c.deps)
    assert(first.sent >= 1)
    assertEquals((await sentPayload(c)).install[0]!.tunnelId, providerId)
    await ageLastSend(c.db, c.serverId)
    await c.db.update(command).set({ status: 'succeeded' }).where(eq(command.serverId, c.serverId))
    await c.removeTunnel(providerId)
    const second = await runTunnelConnectorsSweepTick(c.db, c.deps)
    assert(second.sent >= 1)
    assertEquals((await sentPayload(c)).remove, [providerId])
  })
})
