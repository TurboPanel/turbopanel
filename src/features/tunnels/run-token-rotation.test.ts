/**
 * Rotating a tunnel's run token against the database, with the provider and
 * the daemons faked: the order servers are moved in, which token each one is
 * given meanwhile, the stops, the resume, and the end. Skips without
 * TURBOPANEL_DATABASE_URL.
 */
import { skipWithoutDatabase } from '../../test-fixtures/require-service.test.support.ts'
import { assert, assertEquals, assertRejects } from '@std/assert'
import { and, eq, inArray } from 'drizzle-orm'
import { createDenoDb, endDbConnection } from '../../db/connection.ts'
import { getDatabaseUrl } from '../../db/url.ts'
import {
  badge,
  carrier,
  command,
  key,
  organization,
  portal,
  secret,
  server,
  tunnel,
} from '../../db/schema.ts'
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
import { TunnelProviderError } from './errors.ts'
import { TunnelRefusal } from './lifecycle.ts'
import { insertBadge, insertCarrier, sealToken } from './records.ts'
import { readRotation, runSecretFor, toApiRotation } from './rotation-state.ts'
import {
  advanceRunTokenRotation,
  rotationBlock,
  runRunTokenRotationSweepTick,
  startRunTokenRotation,
} from './run-token-rotation.ts'
import { createCommandRecord } from '../commands/command-records.ts'
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
  provider: {
    rotations: number
    reads: number
    drops: number
    secrets: string[]
    /** Set to make the next provider rotation call fail (after it was counted). */
    fail?: boolean
  }
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
    const provider: World['provider'] = { rotations: 0, reads: 0, drops: 0, secrets: [] }
    const adapter = {
      rotateRunToken: (_token: string, input: { tunnelSecret: string }) => {
        provider.rotations += 1
        provider.secrets.push(input.tunnelSecret)
        if (provider.fail) {
          provider.fail = false
          return Promise.reject(new TunnelProviderError('provider_error', 'try later', 503))
        }
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
        settleMs: 0,
      },
    })
  } finally {
    if (servers.length > 0) {
      await db.delete(command).where(inArray(command.serverId, servers))
      await db.delete(key).where(inArray(key.serverId, servers))
    }
    await db.delete(tunnel).where(eq(tunnel.organizationId, organizationId))
    // Tokens on the account point at their sealed secrets: they go first.
    const carriers = await db
      .select({ id: carrier.id })
      .from(carrier)
      .where(eq(carrier.organizationId, organizationId))
    if (carriers.length > 0) {
      await db.delete(badge).where(
        inArray(
          badge.carrierId,
          carriers.map((c) => c.id)
        )
      )
    }
    await db.delete(carrier).where(eq(carrier.organizationId, organizationId))
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

/** The daemon's answer to a connector list that moved this tunnel's connector to the token sent. */
function installed(w: World) {
  return { installed: [w.externalId], unchanged: [], removed: [] }
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
    await finish(w, sentTo(w, first, 'server.tunnel.connectors')[0]!, installed(w))
    await advanceRunTokenRotation(w.db, w.deps, w.tunnelId)
    assertEquals(sentTo(w, first, 'server.tunnel.status').length, 1)
    assertEquals(sentTo(w, second, 'server.tunnel.connectors').length, 0)

    // Connected: only now does the second server get the new token.
    await reportConnected(w, first)
    await advanceRunTokenRotation(w.db, w.deps, w.tunnelId)
    assertEquals(sentTo(w, second, 'server.tunnel.connectors').length, 1)
    assertEquals(w.provider.drops, 0)

    await finish(w, sentTo(w, second, 'server.tunnel.connectors')[0]!, installed(w))
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
    // The chosen secret did its job and is gone; the token row is now just the run token.
    assertEquals(state.tunnelSecretId, undefined)
    const [adopted] = await w.db.select().from(secret).where(eq(secret.id, state.newSecretId!))
    assertEquals(adopted!.name, 'Rotation run token')
    // Nothing anywhere holds the token or the secret in the clear: not the tunnel, not a command.
    assert(!JSON.stringify(row.metadata).includes(NEW_TOKEN))
    const commands = await w.db.select().from(command).where(inArray(command.serverId, w.servers))
    const sentText = JSON.stringify(commands)
    assert(!sentText.includes(NEW_TOKEN))
    assert(!sentText.includes(w.provider.secrets[0]!))
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
      // The screen sees the same reason before anything is pressed.
      assertEquals((await rotationBlock(w.db, row))?.code, 'tunnel_daemon_too_old')
      assertEquals(readRotation((await tunnelRow(w)).metadata), null)
    }
  )
})

test('one server needs a confirmation that names the short outage, then rotates', async () => {
  await withWorld({ servers: [ALL_FEATURES] }, async (w) => {
    // A lone server is not a block: the screen offers the action with the extra warning.
    assertEquals(await rotationBlock(w.db, await tunnelRow(w)), null)
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
    // The waiting server would be stranded on the old token: the sweep retries on its own.
    assertEquals(stopped?.retryable, true)
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
    // The list is sent again even though it looks current: the server must answer for this token.
    assertEquals(sentTo(w, first, 'server.tunnel.connectors').length, 2)
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

test('a list answer that does not confirm the new token stops the rotation before the next server', async () => {
  await withWorld({ servers: [ALL_FEATURES, ALL_FEATURES] }, async (w) => {
    const [first, second] = w.servers.toSorted() as [string, string]
    await startRunTokenRotation(w.db, w.deps, await tunnelRow(w), { confirmSingleServer: false })
    // Succeeded, but the tunnel is in neither list: its connector was not moved.
    await finish(w, sentTo(w, first, 'server.tunnel.connectors')[0]!, {
      installed: [],
      unchanged: [],
      removed: [],
    })
    const stopped = await advanceRunTokenRotation(w.db, w.deps, w.tunnelId)
    assertEquals(stopped?.phase, 'stopped')
    assertEquals(stopped?.retryable, true)
    assertEquals(sentTo(w, second, 'server.tunnel.connectors').length, 0)
    assertEquals(sentTo(w, first, 'server.tunnel.status').length, 0)
    assertEquals(w.provider.drops, 0)
  })
})

test('an offline carrier refuses the rotation before the provider is asked', async () => {
  await withWorld({ servers: [ALL_FEATURES, ALL_FEATURES] }, async (w) => {
    await w.db.update(server).set({ isConnected: false }).where(eq(server.id, w.servers[1]!))
    const row = await tunnelRow(w)
    const err = await assertRejects(
      () => startRunTokenRotation(w.db, w.deps, row, { confirmSingleServer: false }),
      TunnelRefusal
    )
    assertEquals(err.code, 'server_not_ready')
    assertEquals(w.provider.rotations, 0)
    assertEquals((await rotationBlock(w.db, row))?.details?.serverIds, [w.servers[1]])
  })
})

test('the next server waits for traffic to settle on the last one before it is moved', async () => {
  await withWorld({ servers: [ALL_FEATURES, ALL_FEATURES] }, async (w) => {
    const [first, second] = w.servers.toSorted() as [string, string]
    const deps = { ...w.deps, settleMs: 10 * 60 * 1000 }
    await startRunTokenRotation(w.db, deps, await tunnelRow(w), { confirmSingleServer: false })
    await finish(w, sentTo(w, first, 'server.tunnel.connectors')[0]!, installed(w))
    await advanceRunTokenRotation(w.db, deps, w.tunnelId)
    await reportConnected(w, first)
    const waiting = await advanceRunTokenRotation(w.db, deps, w.tunnelId)
    assertEquals(waiting?.phase, 'rolling')
    assert(waiting?.lastConnectedAt)
    assertEquals(sentTo(w, second, 'server.tunnel.connectors').length, 0)
  })
})

/** Put the tunnel at "secret chosen, provider not answered yet", as after a crash or a refusal. */
async function chosenSecretState(w: World, claimedAt?: string) {
  const [chosen] = await w.db
    .insert(secret)
    .values({
      organizationId: w.organizationId,
      provider: RUN_SECRET_PROVIDER,
      name: 'Rotation tunnel secret (rotation)',
      secretEnvelope: await encryptSecret(w.secrets, 'S'.repeat(44)),
    })
    .returning({ id: secret.id })
  await w.db
    .update(tunnel)
    .set({
      metadata: {
        runTokenRotation: {
          phase: 'starting',
          step: 5,
          startedAt: new Date().toISOString(),
          tunnelSecretId: chosen!.id,
          ...(claimedAt ? { claimedAt } : {}),
          pending: w.servers.toSorted(),
          moved: [],
        },
      },
    })
    .where(eq(tunnel.id, w.tunnelId))
}

test('two advancers at once on a chosen secret ask the provider once, with that secret', async () => {
  await withWorld({ servers: [ALL_FEATURES, ALL_FEATURES] }, async (w) => {
    await chosenSecretState(w)
    await Promise.all([
      advanceRunTokenRotation(w.db, w.deps, w.tunnelId),
      advanceRunTokenRotation(w.db, w.deps, w.tunnelId),
    ])
    assertEquals(w.provider.rotations, 1)
    assertEquals(w.provider.secrets, ['S'.repeat(44)])
    const state = readRotation((await tunnelRow(w)).metadata)!
    assertEquals(state.phase, 'rolling')
    assert(state.newSecretId)
  })
})

test('after a crash mid-call the same secret is sent again once the lease ran out, never a new one', async () => {
  await withWorld({ servers: [ALL_FEATURES, ALL_FEATURES] }, async (w) => {
    // A lease still running: nobody else asks.
    await chosenSecretState(w, new Date().toISOString())
    await advanceRunTokenRotation(w.db, w.deps, w.tunnelId)
    assertEquals(w.provider.rotations, 0)
    // The lease ran out (the attempt that held it is gone): the same secret goes out.
    await chosenSecretState(w, new Date(Date.now() - 10 * 60 * 1000).toISOString())
    await advanceRunTokenRotation(w.db, w.deps, w.tunnelId)
    assertEquals(w.provider.secrets, ['S'.repeat(44)])
    assertEquals(readRotation((await tunnelRow(w)).metadata)!.phase, 'rolling')
  })
})

test('a list still on its way to a server is waited for before the new token is sent', async () => {
  await withWorld({ servers: [ALL_FEATURES, ALL_FEATURES] }, async (w) => {
    const [first] = w.servers.toSorted() as [string, string]
    // An older list, not yet handled by the daemon.
    const older = await createCommandRecord(w.db, {
      serverId: first,
      actorType: 'system',
      actorId: first,
      type: 'server.tunnel.connectors',
      payload: { install: [], remove: [] },
    })
    await startRunTokenRotation(w.db, w.deps, await tunnelRow(w), { confirmSingleServer: false })
    assertEquals(sentTo(w, first, 'server.tunnel.connectors').length, 0)
    await w.db.update(command).set({ status: 'succeeded' }).where(eq(command.id, older.id))
    await advanceRunTokenRotation(w.db, w.deps, w.tunnelId)
    assertEquals(sentTo(w, first, 'server.tunnel.connectors').length, 1)
  })
})

test('an unreachable server waits behind the others; when none can be reached the sweep resumes it later', async () => {
  await withWorld({ servers: [ALL_FEATURES, ALL_FEATURES] }, async (w) => {
    const [first, second] = w.servers.toSorted() as [string, string]
    await startRunTokenRotation(w.db, w.deps, await tunnelRow(w), { confirmSingleServer: false })
    await finish(w, sentTo(w, first, 'server.tunnel.connectors')[0]!, installed(w))
    await advanceRunTokenRotation(w.db, w.deps, w.tunnelId)
    await reportConnected(w, first)
    // The second server drops off before its turn: the rotation stops and says it will retry.
    await w.db.update(server).set({ isConnected: false }).where(eq(server.id, second))
    const stopped = await advanceRunTokenRotation(w.db, w.deps, w.tunnelId)
    assertEquals(stopped?.phase, 'stopped')
    assertEquals(stopped?.retryable, true)
    assertEquals(toApiRotation(stopped!)?.oldTokenServerIds, [second])
    // Back, and the retry wait is over: the sweep picks it up and moves it.
    await w.db.update(server).set({ isConnected: true }).where(eq(server.id, second))
    const row = await tunnelRow(w)
    const state = readRotation(row.metadata)!
    await w.db
      .update(tunnel)
      .set({
        metadata: {
          runTokenRotation: {
            ...state,
            stoppedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
          },
        },
      })
      .where(eq(tunnel.id, w.tunnelId))
    await runRunTokenRotationSweepTick(w.db, w.deps)
    assertEquals(sentTo(w, second, 'server.tunnel.connectors').length, 1)
    assertEquals(w.provider.rotations, 1)
  })
})

/** Move the stored stop back in time, so the sweep's retry wait is over. */
async function retryWaitOver(w: World) {
  const state = readRotation((await tunnelRow(w)).metadata)!
  await w.db
    .update(tunnel)
    .set({
      metadata: {
        runTokenRotation: { ...state, stoppedAt: new Date(Date.now() - 5 * 60_000).toISOString() },
      },
    })
    .where(eq(tunnel.id, w.tunnelId))
}

async function setConnected(w: World, serverId: string, isConnected: boolean) {
  await w.db.update(server).set({ isConnected }).where(eq(server.id, serverId))
}

test('a server that drops mid-move keeps the new token, waits behind the others and is checked again at the end', async () => {
  await withWorld({ servers: [ALL_FEATURES, ALL_FEATURES] }, async (w) => {
    const [first, second] = w.servers.toSorted() as [string, string]
    await startRunTokenRotation(w.db, w.deps, await tunnelRow(w), { confirmSingleServer: false })
    assertEquals(sentTo(w, first, 'server.tunnel.connectors').length, 1)
    // The first server goes away before it answers: the second one is moved instead.
    await setConnected(w, first, false)
    const moving = await advanceRunTokenRotation(w.db, w.deps, w.tunnelId)
    assertEquals(moving?.phase, 'rolling')
    assertEquals(moving?.unconfirmed, [first])
    assertEquals(moving?.current?.serverId, second)
    // The first server is not waiting any more: a resend gives it the new token.
    assertEquals(runSecretFor(await tunnelRow(w), first), moving?.newSecretId)
    await finish(w, sentTo(w, second, 'server.tunnel.connectors')[0]!, installed(w))
    await advanceRunTokenRotation(w.db, w.deps, w.tunnelId)
    await reportConnected(w, second)
    // Every other server moved, the first is still away: stop, and retry on its own.
    const stopped = await advanceRunTokenRotation(w.db, w.deps, w.tunnelId)
    assertEquals(stopped?.phase, 'stopped')
    assertEquals(stopped?.retryable, true)
    assertEquals(w.provider.drops, 0)
    // A person may resume at once: an unreachable server no longer blocks a resume.
    assertEquals(await rotationBlock(w.db, await tunnelRow(w)), null)
    // Back (the list it never answered has timed out): the sweep checks it again
    // with the new token, then finishes.
    await w.db
      .update(command)
      .set({ status: 'timed_out' })
      .where(eq(command.id, sentTo(w, first, 'server.tunnel.connectors')[0]!.commandId))
    await setConnected(w, first, true)
    await retryWaitOver(w)
    await runRunTokenRotationSweepTick(w.db, w.deps)
    const resent = sentTo(w, first, 'server.tunnel.connectors')
    assertEquals(resent.length, 2)
    await finish(w, resent[1]!, installed(w))
    await advanceRunTokenRotation(w.db, w.deps, w.tunnelId)
    await reportConnected(w, first)
    const done = await advanceRunTokenRotation(w.db, w.deps, w.tunnelId)
    assertEquals(done?.phase, 'done')
    assertEquals(w.provider.drops, 1)
    assertEquals(w.provider.rotations, 1)
  })
})

test('a provider call that fails after the secret was chosen retries on its own and counts every server as on the old token', async () => {
  await withWorld({ servers: [ALL_FEATURES, ALL_FEATURES] }, async (w) => {
    w.provider.fail = true
    const started = await startRunTokenRotation(w.db, w.deps, await tunnelRow(w), {
      confirmSingleServer: false,
    })
    assertEquals(started.rotation.phase, 'stopped')
    assertEquals(started.rotation.resumesOnItsOwn, true)
    // The call may have landed: until the new token is known, every server may be on the old one.
    assertEquals(started.rotation.oldTokenServerIds, w.servers.toSorted())
    // A resume is not blocked by a server that went away meanwhile.
    await setConnected(w, w.servers[0]!, false)
    assertEquals(await rotationBlock(w.db, await tunnelRow(w)), null)
    await setConnected(w, w.servers[0]!, true)
    await retryWaitOver(w)
    await runRunTokenRotationSweepTick(w.db, w.deps)
    // The same secret went out again; the rotation goes on.
    assertEquals(w.provider.rotations, 2)
    assertEquals(w.provider.secrets[0], w.provider.secrets[1])
    const state = readRotation((await tunnelRow(w)).metadata)!
    assertEquals(state.phase, 'rolling')
    assert(state.newSecretId)
  })
})

test('a waiting server whose connector is down is moved early and keeps the new token', async () => {
  await withWorld({ servers: [ALL_FEATURES, ALL_FEATURES] }, async (w) => {
    const [first, second] = w.servers.toSorted() as [string, string]
    await startRunTokenRotation(w.db, w.deps, await tunnelRow(w), { confirmSingleServer: false })
    const state = readRotation((await tunnelRow(w)).metadata)!
    const before = await wantedConnectorsByServer(w.db, w.organizationId)
    assertEquals(before.get(second)?.[0]?.secretId, w.oldSecretId)
    // Its connector stopped: the old token could not open a connection again.
    const report = async (reported: string) => {
      await w.db
        .update(portal)
        .set({ reported })
        .where(and(eq(portal.tunnelId, w.tunnelId), eq(portal.serverId, second)))
    }
    await report('down')
    const moved = await advanceRunTokenRotation(w.db, w.deps, w.tunnelId)
    assertEquals(moved?.pending, [])
    assertEquals(moved?.unconfirmed, [second])
    const after = await wantedConnectorsByServer(w.db, w.organizationId)
    assertEquals(after.get(second)?.[0]?.secretId, state.newSecretId)
    assertEquals(after.get(first)?.[0]?.secretId, state.newSecretId)
    // Connected again on the new token: it stays on it, never back to the old one.
    await report('connected')
    await advanceRunTokenRotation(w.db, w.deps, w.tunnelId)
    const still = await wantedConnectorsByServer(w.db, w.organizationId)
    assertEquals(still.get(second)?.[0]?.secretId, state.newSecretId)
  })
})

test('two advancers at the end drop the old connections once', async () => {
  await withWorld({ servers: [ALL_FEATURES] }, async (w) => {
    const [only] = w.servers as [string]
    await startRunTokenRotation(w.db, w.deps, await tunnelRow(w), { confirmSingleServer: true })
    await finish(w, sentTo(w, only, 'server.tunnel.connectors')[0]!, installed(w))
    await advanceRunTokenRotation(w.db, w.deps, w.tunnelId)
    await reportConnected(w, only)
    // Both read "finishing" at once: only the one holding the lease drops connections.
    const state = readRotation((await tunnelRow(w)).metadata)!
    await w.db
      .update(tunnel)
      .set({
        metadata: {
          runTokenRotation: { ...state, phase: 'finishing', current: undefined, pending: [] },
        },
      })
      .where(eq(tunnel.id, w.tunnelId))
    await Promise.all([
      advanceRunTokenRotation(w.db, w.deps, w.tunnelId),
      advanceRunTokenRotation(w.db, w.deps, w.tunnelId),
    ])
    assertEquals(w.provider.drops, 1)
    assertEquals(readRotation((await tunnelRow(w)).metadata)?.phase, 'done')
  })
})

test('a list that timed out counts as finished: the rotation stops to retry instead of waiting out the clock', async () => {
  await withWorld({ servers: [ALL_FEATURES, ALL_FEATURES] }, async (w) => {
    const [first, second] = w.servers.toSorted() as [string, string]
    await startRunTokenRotation(w.db, w.deps, await tunnelRow(w), { confirmSingleServer: false })
    await w.db
      .update(command)
      .set({ status: 'timed_out' })
      .where(eq(command.id, sentTo(w, first, 'server.tunnel.connectors')[0]!.commandId))
    const stopped = await advanceRunTokenRotation(w.db, w.deps, w.tunnelId)
    assertEquals(stopped?.phase, 'stopped')
    assert(stopped?.stoppedReason?.includes('did not take the new token'))
    assertEquals(stopped?.retryable, true)
    assertEquals(sentTo(w, second, 'server.tunnel.connectors').length, 0)
  })
})
