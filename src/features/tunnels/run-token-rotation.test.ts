/**
 * Rotating a tunnel's run token against the database, with the provider and
 * the daemons faked: the order servers are moved in, which token each one is
 * given meanwhile, the stops, the resume, and the end. Skips without
 * TURBOPANEL_DATABASE_URL.
 */
import { skipWithoutDatabase } from '../../test-fixtures/require-service.test.support.ts'
import { assert, assertEquals, assertRejects } from '@std/assert'
import { eq, inArray } from 'drizzle-orm'
import { createDenoDb, endDbConnection } from '../../db/connection.ts'
import { getDatabaseUrl } from '../../db/url.ts'
import { command, key, organization, portal, secret, server, tunnel } from '../../db/schema.ts'
import { decryptSecret, encryptSecret } from '../../lib/secrets/data-encryption.ts'
import { deriveEncryptionSecretsConfig } from '../../lib/secrets/secrets.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import {
  TUNNEL_CONNECTOR_FEATURE,
  TUNNEL_CONNECTOR_TOKEN_CHANGE_FEATURE,
  TUNNEL_FORWARDING_FEATURE,
  TUNNEL_STATUS_FEATURE,
} from '../../lib/version-wire.ts'
import type { CommandEnvelope } from '../commands/envelope.ts'
import type { CredentialReport, TunnelAdapter } from './adapter.ts'
import { wantedConnectorsByServer } from './connector-sync.ts'
import { TunnelRefusal } from './lifecycle.ts'
import { insertBadge, insertCarrier, sealToken } from './records.ts'
import { readRotation } from './rotation-state.ts'
import { advanceRunTokenRotation, startRunTokenRotation } from './run-token-rotation.ts'
import { RUN_SECRET_PROVIDER } from './vocabulary.ts'

/** Sonar only recognises `test()`; see the note in the other suites. */
const test = Deno.test.bind(Deno)

const dbUrl = getDatabaseUrl()
const ACCOUNT = 'a'.repeat(32)
/** Made-up run tokens, built so no scanner mistakes them for real ones. */
const OLD_TOKEN = 'O'.repeat(48)
const NEW_TOKEN = 'N'.repeat(48)
const ALL_FEATURES = [
  TUNNEL_FORWARDING_FEATURE,
  TUNNEL_CONNECTOR_FEATURE,
  TUNNEL_STATUS_FEATURE,
  TUNNEL_CONNECTOR_TOKEN_CHANGE_FEATURE,
]

type Db = ReturnType<typeof createDenoDb>

type World = {
  db: Db
  organizationId: string
  tunnelId: string
  externalId: string
  oldSecretId: string
  servers: string[]
  queued: CommandEnvelope[]
  provider: { rotations: number; reads: number; drops: number }
  deps: Parameters<typeof startRunTokenRotation>[1]
  secrets: Awaited<ReturnType<typeof deriveEncryptionSecretsConfig>>
}

function report(): CredentialReport {
  return {
    accounts: [],
    zones: [],
    accountVisible: true,
    capabilities: { tunnels: true, dns: [], certificates: [] },
    missing: [],
    token: { kind: 'account', id: null, status: 'active', expiresAt: null },
  }
}

async function newServer(db: Db, organizationId: string, features: string[]): Promise<string> {
  const [row] = await db
    .insert(server)
    .values({
      organizationId,
      name: `Rotation ${crypto.randomUUID().slice(0, 8)}`,
      isConnected: true,
      daemon: { projection: { features } },
    })
    .returning({ id: server.id })
  await db.insert(key).values({
    serverId: row!.id,
    algorithm: 'Ed25519',
    publicJwk: { kty: 'OKP', crv: 'Ed25519', x: 'A'.repeat(43) },
    fingerprint: `fp-${crypto.randomUUID()}`,
  })
  return row!.id
}

async function withWorld(
  options: { servers: string[][] },
  fn: (w: World) => Promise<void>
): Promise<void> {
  if (!dbUrl) {
    skipWithoutDatabase('run token rotation tests')
    return
  }
  const db = createDenoDb()
  const secretsConfig = parseTestSecretsConfig('deno')
  const secrets = await deriveEncryptionSecretsConfig(secretsConfig, 'data-encryption')
  const [org] = await db
    .insert(organization)
    .values({ name: `Rotation Org ${crypto.randomUUID()}` })
    .returning({ id: organization.id })
  const organizationId = org!.id
  const servers: string[] = []
  try {
    const carrier = await insertCarrier(db, {
      organizationId,
      provider: 'cloudflare',
      name: 'Main',
      externalAccountId: ACCOUNT,
    })
    await insertBadge(db, {
      organizationId,
      carrier,
      label: 'tunnels',
      sealed: await sealToken(secrets, 'api-token-for-tests'),
      lastFour: 'ests',
      report: report(),
    })
    const [run] = await db
      .insert(secret)
      .values({
        organizationId,
        provider: RUN_SECRET_PROVIDER,
        name: 'Rotation run token',
        secretEnvelope: await encryptSecret(secrets, OLD_TOKEN),
      })
      .returning({ id: secret.id })
    for (const features of options.servers)
      servers.push(await newServer(db, organizationId, features))
    const externalId = crypto.randomUUID()
    const [t] = await db
      .insert(tunnel)
      .values({
        organizationId,
        routingOrganizationId: organizationId,
        carrierId: carrier.id,
        provider: 'cloudflare',
        name: 'Rotation',
        externalId,
        secretId: run!.id,
        placement: 'chosen',
        status: 'active',
      })
      .returning({ id: tunnel.id })
    if (servers.length > 0) {
      await db
        .insert(portal)
        .values(servers.map((serverId) => ({ tunnelId: t!.id, serverId, wanted: 'run' })))
    }
    const queued: CommandEnvelope[] = []
    const provider = { rotations: 0, reads: 0, drops: 0 }
    const adapter = {
      rotateRunToken: () => {
        provider.rotations += 1
        return Promise.resolve(NEW_TOKEN)
      },
      fetchRunToken: () => {
        provider.reads += 1
        return Promise.resolve(NEW_TOKEN)
      },
      dropConnections: () => {
        provider.drops += 1
        return Promise.resolve()
      },
    } as unknown as TunnelAdapter
    await fn({
      db,
      organizationId,
      tunnelId: t!.id,
      externalId,
      oldSecretId: run!.id,
      servers,
      queued,
      provider,
      secrets,
      deps: {
        commandQueue: {
          enqueue: (envelope) => {
            queued.push(envelope)
            return Promise.resolve()
          },
        },
        secretsConfig,
        dataEncryptionSecrets: secrets,
        adapter,
      },
    })
  } finally {
    if (servers.length > 0) {
      await db.delete(command).where(inArray(command.serverId, servers))
      await db.delete(key).where(inArray(key.serverId, servers))
    }
    await db.delete(tunnel).where(eq(tunnel.organizationId, organizationId))
    await db.delete(secret).where(eq(secret.organizationId, organizationId))
    if (servers.length > 0) await db.delete(server).where(inArray(server.id, servers))
    await db.delete(organization).where(eq(organization.id, organizationId))
    await endDbConnection(db)
  }
}

async function tunnelRow(w: World) {
  const [row] = await w.db.select().from(tunnel).where(eq(tunnel.id, w.tunnelId))
  return row!
}

function sentTo(w: World, serverId: string, type: string): CommandEnvelope[] {
  return w.queued.filter((e) => e.serverId === serverId && e.type === type)
}

async function finish(w: World, envelope: CommandEnvelope, resultSummary?: unknown) {
  await w.db
    .update(command)
    .set({ status: 'succeeded', ...(resultSummary ? { resultSummary } : {}) })
    .where(eq(command.id, envelope.commandId))
}

/** Answer the last status question of a server: its connector for this tunnel is connected. */
async function reportConnected(w: World, serverId: string) {
  const asked = sentTo(w, serverId, 'server.tunnel.status').at(-1)!
  await finish(w, asked, {
    pinnedVersion: '2026.10.7',
    connectors: [{ tunnelId: w.externalId, status: 'connected', version: '2026.10.7', slot: 'a' }],
  })
}

test('servers are moved one at a time, each waits for the one before to connect, then old connections are dropped', async () => {
  await withWorld({ servers: [ALL_FEATURES, ALL_FEATURES] }, async (w) => {
    const [first, second] = w.servers.toSorted() as [string, string]
    const started = await startRunTokenRotation(w.db, w.deps, await tunnelRow(w), {
      confirmSingleServer: false,
    })
    assert(started.warnings[0]!.includes('briefly reconnect'))
    assertEquals(started.rotation.phase, 'rolling')
    assertEquals(started.rotation.currentServerId, first)
    assertEquals(w.provider.rotations, 1)
    // The first server is given the new token; the second keeps the old one for now.
    const state = readRotation((await tunnelRow(w)).metadata)!
    const wanted = await wantedConnectorsByServer(w.db, w.organizationId)
    assertEquals(wanted.get(first)![0]!.secretId, state.newSecretId)
    assertEquals(wanted.get(second)![0]!.secretId, w.oldSecretId)
    const [stored] = await w.db.select().from(secret).where(eq(secret.id, state.newSecretId!))
    assertEquals(await decryptSecret(w.secrets, stored!.secretEnvelope), NEW_TOKEN)
    assertEquals(sentTo(w, first, 'server.tunnel.connectors').length, 1)
    assertEquals(sentTo(w, second, 'server.tunnel.connectors').length, 0)

    // The list landed: the server is asked whether its connector is connected.
    await finish(w, sentTo(w, first, 'server.tunnel.connectors')[0]!)
    await advanceRunTokenRotation(w.db, w.deps, w.tunnelId)
    assertEquals(sentTo(w, first, 'server.tunnel.status').length, 1)
    assertEquals(sentTo(w, second, 'server.tunnel.connectors').length, 0)

    // Connected: only now does the second server get the new token.
    await reportConnected(w, first)
    await advanceRunTokenRotation(w.db, w.deps, w.tunnelId)
    assertEquals(sentTo(w, second, 'server.tunnel.connectors').length, 1)
    assertEquals(w.provider.drops, 0)

    await finish(w, sentTo(w, second, 'server.tunnel.connectors')[0]!)
    await advanceRunTokenRotation(w.db, w.deps, w.tunnelId)
    await reportConnected(w, second)
    const done = await advanceRunTokenRotation(w.db, w.deps, w.tunnelId)
    assertEquals(done?.phase, 'done')
    assertEquals(w.provider.drops, 1)
    assertEquals(w.provider.rotations, 1)
    // The tunnel took the new token; the old one is gone.
    const row = await tunnelRow(w)
    assertEquals(row.secretId, state.newSecretId)
    assertEquals((await w.db.select().from(secret).where(eq(secret.id, w.oldSecretId))).length, 0)
    // Nothing anywhere holds the token in the clear.
    assert(!JSON.stringify(row.metadata).includes(NEW_TOKEN))
  })
})

test('a server whose daemon cannot follow refuses the rotation before anything changes', async () => {
  await withWorld(
    { servers: [ALL_FEATURES, [TUNNEL_FORWARDING_FEATURE, TUNNEL_CONNECTOR_FEATURE]] },
    async (w) => {
      const row = await tunnelRow(w)
      const err = await assertRejects(
        () => startRunTokenRotation(w.db, w.deps, row, { confirmSingleServer: false }),
        TunnelRefusal
      )
      assertEquals(err.code, 'tunnel_daemon_too_old')
      assertEquals(w.provider.rotations, 0)
      assertEquals(readRotation((await tunnelRow(w)).metadata), null)
    }
  )
})

test('one server needs a confirmation that names the short outage, then rotates', async () => {
  await withWorld({ servers: [ALL_FEATURES] }, async (w) => {
    const err = await assertRejects(
      async () =>
        startRunTokenRotation(w.db, w.deps, await tunnelRow(w), { confirmSingleServer: false }),
      TunnelRefusal
    )
    assertEquals(err.code, 'rotation_single_server')
    assert(err.message.includes('Only one server'))
    assertEquals(w.provider.rotations, 0)
    const started = await startRunTokenRotation(w.db, w.deps, await tunnelRow(w), {
      confirmSingleServer: true,
    })
    assertEquals(started.rotation.phase, 'rolling')
    assertEquals(w.provider.rotations, 1)
  })
})

test('a server that refuses the list stops the rotation; starting again resumes and never rotates twice', async () => {
  await withWorld({ servers: [ALL_FEATURES, ALL_FEATURES] }, async (w) => {
    const [first, second] = w.servers.toSorted() as [string, string]
    await startRunTokenRotation(w.db, w.deps, await tunnelRow(w), { confirmSingleServer: false })
    await w.db
      .update(command)
      .set({ status: 'failed' })
      .where(eq(command.id, sentTo(w, first, 'server.tunnel.connectors')[0]!.commandId))
    const stopped = await advanceRunTokenRotation(w.db, w.deps, w.tunnelId)
    assertEquals(stopped?.phase, 'stopped')
    assert(stopped?.stoppedReason?.includes('did not take the new token'))
    // Stopped: nothing more moves and no connection is dropped.
    await advanceRunTokenRotation(w.db, w.deps, w.tunnelId)
    assertEquals(sentTo(w, second, 'server.tunnel.connectors').length, 0)
    assertEquals(w.provider.drops, 0)
    // Started again: the same server is tried again with the token already issued.
    const resumed = await startRunTokenRotation(w.db, w.deps, await tunnelRow(w), {
      confirmSingleServer: false,
    })
    assertEquals(resumed.rotation.phase, 'rolling')
    assertEquals(resumed.rotation.currentServerId, first)
    assertEquals(w.provider.rotations, 1)
  })
})

test('a rotation already under way refuses a second start', async () => {
  await withWorld({ servers: [ALL_FEATURES, ALL_FEATURES] }, async (w) => {
    await startRunTokenRotation(w.db, w.deps, await tunnelRow(w), { confirmSingleServer: false })
    const err = await assertRejects(
      async () =>
        startRunTokenRotation(w.db, w.deps, await tunnelRow(w), { confirmSingleServer: false }),
      TunnelRefusal
    )
    assertEquals(err.code, 'rotation_in_progress')
    assertEquals(w.provider.rotations, 1)
  })
})
