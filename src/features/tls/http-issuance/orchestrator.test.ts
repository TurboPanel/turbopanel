/**
 * Real-Postgres coverage for the server-placed certificate order: who is
 * chosen, what is sent, how the stored request moves on each daemon message and
 * on silence, and that another organization's server can never move a request.
 * Presence, daemon features and DNS are injected; nothing leaves the process.
 */
import { skipWithoutDatabase } from '../../../test-fixtures/require-service.test.support.ts'
import { assert, assertEquals } from '@std/assert'
import { eq } from 'drizzle-orm'
import { createDenoDb } from '../../../db/connection.ts'
import type { Db } from '../../../db/connection.ts'
import { getDatabaseUrl } from '../../../db/url.ts'
import {
  clientAddress,
  environment,
  hosting,
  organization,
  project,
  server,
  service,
  tls,
  workspace,
} from '../../../db/schema.ts'
import type { DaemonOutboundEnvelope } from '../../../contracts/cell-protocol.ts'
import { handleForwardReport, handleIssueEvent } from './events.ts'
import {
  advanceHttpIssuance,
  deliverIssuedPair,
  type HttpIssuanceDeps,
  replaceKey,
  sendPendingEnds,
  startHttpIssuance,
} from './orchestrator.ts'
import { newHttpIssuanceState, readHttpIssuanceState } from './state.ts'

const dbUrl = getDatabaseUrl()

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const HOST = 'shop.example.com'
const T0 = new Date('2026-11-01T12:00:00.000Z')
const at = (ms: number) => new Date(T0.getTime() + ms)

/** One connection pool for the whole file: a pool per fixture runs the server out of clients. */
let sharedDb: Db | undefined
function database(): Db {
  sharedDb ??= createDenoDb()
  return sharedDb
}

type Fixture = {
  db: Db
  organizationId: string
  tlsId: string
  /** Server ids in a fixed order: a < b < c by creation, sorted by id string later. */
  servers: Array<{ id: string; address: string }>
  sent: Array<{ serverId: string; envelope: DaemonOutboundEnvelope }>
  deps: (over?: Partial<HttpIssuanceDeps>) => HttpIssuanceDeps
  cleanup: () => Promise<void>
}

async function setup(
  options: { servers?: number; offline?: number[]; noFeature?: number[]; dnsFor?: number[] } = {}
): Promise<Fixture> {
  const db = database()
  const count = options.servers ?? 3
  const now = new Date().toISOString()
  const [org] = await db
    .insert(organization)
    .values({ name: 'Http Order Org', options: { acmeEnabled: true } })
    .returning({ id: organization.id })
  const organizationId = org!.id
  const [ws] = await db
    .insert(workspace)
    .values({ organizationId, name: 'WS', createdAt: now, updatedAt: now })
    .returning({ id: workspace.id })
  const [proj] = await db
    .insert(project)
    .values({ workspaceId: ws!.id, organizationId, name: 'P', createdAt: now, updatedAt: now })
    .returning({ id: project.id })
  const [row] = await db
    .insert(tls)
    .values({
      organizationId,
      name: 'Lets Encrypt for shop',
      source: 'lets_encrypt',
      status: 'automatic',
      metadata: {
        dnsNames: [HOST],
        hasWildcard: false,
        notBefore: '',
        subject: '',
        issuer: '',
        acme: { managedBy: 'caddy' },
      },
      options: { autoRenew: true },
    })
    .returning({ id: tls.id })
  const servers: Fixture['servers'] = []
  for (let i = 0; i < count; i += 1) {
    const [srv] = await db
      .insert(server)
      .values({ organizationId, name: `edge-${i}` })
      .returning({ id: server.id })
    const address = `93.184.216.${30 + i}`
    await db.insert(clientAddress).values({
      organizationId,
      serverId: srv!.id,
      scope: 'public',
      addressV4: address,
      isPrimary: true,
    })
    const [env] = await db
      .insert(environment)
      .values({
        projectId: proj!.id,
        name: `e${i}`,
        serverId: srv!.id,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: environment.id })
    const [svc] = await db
      .insert(service)
      .values({
        environmentId: env!.id,
        name: 's',
        composeServiceName: 's',
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: service.id })
    await db.insert(hosting).values({
      serviceId: svc!.id,
      name: 'Site',
      tlsId: row!.id,
      options: { hostnames: [HOST] },
      createdAt: now,
      updatedAt: now,
    })
    servers.push({ id: srv!.id, address })
  }
  const dnsIndexes = options.dnsFor ?? servers.map((_, i) => i)
  const sent: Fixture['sent'] = []
  const baseDeps = (over: Partial<HttpIssuanceDeps> = {}): HttpIssuanceDeps => ({
    db,
    send: (serverId, envelope) => {
      sent.push({ serverId, envelope })
      return Promise.resolve()
    },
    dnsLookup: (_name, type) =>
      Promise.resolve(type === 'A' ? dnsIndexes.map((i) => servers[i]!.address) : []),
    isOnline: (id) => Promise.resolve(!(options.offline ?? []).some((i) => servers[i]!.id === id)),
    daemonFeatures: (id) =>
      Promise.resolve(
        (options.noFeature ?? []).some((i) => servers[i]!.id === id) ? [] : ['acme-issue-v1']
      ),
    contact: () => Promise.resolve({ contactEmail: 'ops@example.com', staging: true }),
    newRequestId: () => 'req_test_1',
    now: () => T0,
    ...over,
  })
  return {
    db,
    organizationId,
    tlsId: row!.id,
    servers,
    sent,
    deps: baseDeps,
    async cleanup() {
      await db.delete(hosting).where(eq(hosting.tlsId, row!.id))
      await db.delete(tls).where(eq(tls.organizationId, organizationId))
      for (const envRow of await db
        .select({ id: environment.id })
        .from(environment)
        .where(eq(environment.projectId, proj!.id))) {
        await db.delete(service).where(eq(service.environmentId, envRow.id))
      }
      await db.delete(environment).where(eq(environment.projectId, proj!.id))
      await db.delete(project).where(eq(project.id, proj!.id))
      await db.delete(workspace).where(eq(workspace.id, ws!.id))
      await db.delete(clientAddress).where(eq(clientAddress.organizationId, organizationId))
      await db.delete(server).where(eq(server.organizationId, organizationId))
      await db.delete(organization).where(eq(organization.id, organizationId))
    },
  }
}

async function readRow(f: Fixture) {
  const [row] = await f.db.select().from(tls).where(eq(tls.id, f.tlsId))
  return row!
}

const always = () => true

test('the first server by id issues; the others get a forward first and the order waits for them', async () => {
  if (!dbUrl) return skipWithoutDatabase('http issuance tests')
  const f = await setup()
  try {
    assertEquals(await startHttpIssuance(f.deps(), f.tlsId, always), 'started')
    const state = readHttpIssuanceState((await readRow(f)).metadata)!
    const ids = f.servers.map((s) => s.id).sort()
    assertEquals(state.issuingServerId, ids[0])
    assertEquals(state.phase, 'forwarding')
    assertEquals(state.directory, 'staging')
    assertEquals(state.forwards.map((x) => x.serverId).sort(), ids.slice(1))
    assertEquals(
      f.sent.map((s) => s.envelope.kind),
      ['acme-proof-forward', 'acme-proof-forward']
    )
    assert(f.sent.every((s) => s.serverId !== state.issuingServerId))
    const forward = f.sent[0]!.envelope
    assertEquals(forward.kind === 'acme-proof-forward' ? forward.acmeRequestId : '', 'req_test_1')
    // A second tick while the request is open starts nothing.
    assertEquals(await startHttpIssuance(f.deps(), f.tlsId, always), 'not_due')
    assertEquals(f.sent.length, 2)
  } finally {
    await f.cleanup()
  }
})

test('the order goes out only after every helper answered, and carries the helpers', async () => {
  if (!dbUrl) return skipWithoutDatabase('http issuance tests')
  const f = await setup()
  try {
    await startHttpIssuance(f.deps(), f.tlsId, always)
    const state = readHttpIssuanceState((await readRow(f)).metadata)!
    const [h1, h2] = state.forwards.map((x) => x.serverId)
    f.sent.length = 0
    const ready = (serverId: string, ms: number) =>
      handleForwardReport(f.db, { serverId, requestId: 'req_test_1', ok: true, now: at(ms) })
    assertEquals(await advanceHttpIssuance(f.deps({ now: () => at(10_000) }), f.tlsId), 'not_due')
    assertEquals(f.sent.length, 0)
    assert(await ready(h1!, 11_000))
    assertEquals(await advanceHttpIssuance(f.deps({ now: () => at(12_000) }), f.tlsId), 'not_due')
    assert(await ready(h2!, 13_000))
    assertEquals(await advanceHttpIssuance(f.deps({ now: () => at(14_000) }), f.tlsId), 'ordering')
    assertEquals(f.sent.length, 1)
    const order = f.sent[0]!.envelope
    assertEquals(f.sent[0]!.serverId, state.issuingServerId)
    assert(order.kind === 'acme-issue-request')
    assertEquals(order.helpers.map((h) => h.serverId).sort(), [h1, h2].sort())
    assertEquals(order.directory, 'staging')
    assertEquals(order.names, [HOST])
    const after = readHttpIssuanceState((await readRow(f)).metadata)!
    assertEquals(after.phase, 'ordering')
    assertEquals(
      after.forwards.map((x) => x.outcome),
      ['ready', 'ready']
    )
  } finally {
    await f.cleanup()
  }
})

test('a helper that cannot pass the proof path on stops the attempt, and nothing is ordered', async () => {
  if (!dbUrl) return skipWithoutDatabase('http issuance tests')
  const f = await setup()
  try {
    await startHttpIssuance(f.deps(), f.tlsId, always)
    const state = readHttpIssuanceState((await readRow(f)).metadata)!
    const [h1, h2] = state.forwards.map((x) => x.serverId)
    await handleForwardReport(f.db, {
      serverId: h1!,
      requestId: 'req_test_1',
      ok: true,
      now: at(1000),
    })
    await handleForwardReport(f.db, {
      serverId: h2!,
      requestId: 'req_test_1',
      ok: false,
      reason: 'Port 80 is held',
      now: at(2000),
    })
    f.sent.length = 0
    assertEquals(await advanceHttpIssuance(f.deps({ now: () => at(3000) }), f.tlsId), 'backoff')
    assert(f.sent.every((s) => s.envelope.kind === 'acme-proof-forward-end'))
    assertEquals(f.sent.length, 2)
    const row = await readRow(f)
    const failed = readHttpIssuanceState(row.metadata)!
    assertEquals(failed.phase, 'failed')
    assert(failed.lastError?.endsWith('could not pass the check along: Port 80 is held'))
    // The helper is not blamed as issuer: the same issuing server is kept for the retry.
    assertEquals(failed.avoidServerId, null)
    const acme = (row.metadata as { acme: { staging?: boolean } }).acme
    assertEquals(acme.staging, undefined)
  } finally {
    await f.cleanup()
  }
})

test('a forward that cannot be sent to a helper leaves that helper out and the order still goes', async () => {
  if (!dbUrl) return skipWithoutDatabase('http issuance tests')
  const f = await setup({ servers: 2 })
  try {
    const deps = f.deps({
      send: (serverId, envelope) =>
        envelope.kind === 'acme-proof-forward'
          ? Promise.reject(new Error('socket closed'))
          : (f.sent.push({ serverId, envelope }), Promise.resolve()),
    })
    assertEquals(await startHttpIssuance(deps, f.tlsId, always), 'started')
    const state = readHttpIssuanceState((await readRow(f)).metadata)!
    assertEquals(state.forwards[0]!.outcome, 'skipped')
    assertEquals(await advanceHttpIssuance(f.deps({ now: () => at(5000) }), f.tlsId), 'ordering')
  } finally {
    await f.cleanup()
  }
})

test('a row whose serving servers all run older daemons is left alone', async () => {
  if (!dbUrl) return skipWithoutDatabase('http issuance tests')
  const f = await setup({ servers: 2, noFeature: [0, 1] })
  try {
    const before = (await readRow(f)).metadata
    assertEquals(await startHttpIssuance(f.deps(), f.tlsId, always), 'not_eligible')
    assertEquals((await readRow(f)).metadata, before)
    assertEquals(f.sent.length, 0)
  } finally {
    await f.cleanup()
  }
})

test("nothing starts while the organization has Let's Encrypt turned off", async () => {
  if (!dbUrl) return skipWithoutDatabase('http issuance tests')
  const f = await setup({ servers: 1 })
  try {
    await f.db
      .update(organization)
      .set({ options: { acmeEnabled: false } })
      .where(eq(organization.id, f.organizationId))
    assertEquals(await startHttpIssuance(f.deps(), f.tlsId, always), 'not_eligible')
    assertEquals(f.sent.length, 0)
    assertEquals(readHttpIssuanceState((await readRow(f)).metadata), null)
  } finally {
    await f.cleanup()
  }
})

test('a helper that never answers is left out after two minutes', async () => {
  if (!dbUrl) return skipWithoutDatabase('http issuance tests')
  const f = await setup({ servers: 2 })
  try {
    await startHttpIssuance(f.deps(), f.tlsId, always)
    f.sent.length = 0
    assertEquals(await advanceHttpIssuance(f.deps({ now: () => at(60_000) }), f.tlsId), 'not_due')
    assertEquals(await advanceHttpIssuance(f.deps({ now: () => at(121_000) }), f.tlsId), 'ordering')
    const order = f.sent[0]!.envelope
    assert(order.kind === 'acme-issue-request')
    assertEquals(order.helpers, [])
    const state = readHttpIssuanceState((await readRow(f)).metadata)!
    assertEquals(state.forwards[0]!.outcome, 'skipped')
  } finally {
    await f.cleanup()
  }
})

test('offline, not-in-DNS and old-daemon servers are skipped and named in the status lines', async () => {
  if (!dbUrl) return skipWithoutDatabase('http issuance tests')
  const f = await setup({ servers: 4, offline: [1], noFeature: [2], dnsFor: [0, 1, 2] })
  try {
    assertEquals(await startHttpIssuance(f.deps(), f.tlsId, always), 'ordering')
    assertEquals(f.sent.length, 1)
    assertEquals(f.sent[0]!.envelope.kind, 'acme-issue-request')
    const row = await readRow(f)
    const state = readHttpIssuanceState(row.metadata)!
    assertEquals(
      state.roster
        .filter((r) => r.role === 'skipped')
        .map((r) => r.skip)
        .sort(),
      ['not_in_dns', 'offline', 'old_daemon']
    )
    const acme = (
      row.metadata as { acme: { serverStatus: Array<{ text: string }>; stage: string } }
    ).acme
    assertEquals(acme.stage, 'ordering')
    assertEquals(acme.serverStatus.length, 4)
  } finally {
    await f.cleanup()
  }
})

test('with no online server that DNS points at, nothing is sent and the row says it is waiting', async () => {
  if (!dbUrl) return skipWithoutDatabase('http issuance tests')
  const f = await setup({ servers: 2, offline: [0], dnsFor: [0] })
  try {
    assertEquals(await startHttpIssuance(f.deps(), f.tlsId, always), 'waiting')
    assertEquals(f.sent.length, 0)
    const row = await readRow(f)
    assertEquals(readHttpIssuanceState(row.metadata), null)
    const acme = (row.metadata as { acme: { stage: string; warning: string } }).acme
    assertEquals(acme.stage, 'waiting')
    assertEquals(acme.warning, 'Waiting for a server that DNS points at to come online.')
  } finally {
    await f.cleanup()
  }
})

test('events move the request: issued before the pair waits, issued after the pair closes it', async () => {
  if (!dbUrl) return skipWithoutDatabase('http issuance tests')
  const f = await setup({ servers: 1 })
  try {
    await startHttpIssuance(f.deps(), f.tlsId, always)
    const issuer = f.servers[0]!.id
    const event = (stage: 'started' | 'issued' | 'failed', ms: number, reason?: string) =>
      handleIssueEvent(f.db, {
        serverId: issuer,
        requestId: 'req_test_1',
        stage,
        now: at(ms),
        ...(reason ? { reason } : {}),
      })
    assert(await event('started', 1000))
    assert(await event('issued', 2000))
    let state = readHttpIssuanceState((await readRow(f)).metadata)!
    assertEquals(state.endedAt, null)
    assertEquals(state.issuedEventAt, at(2000).toISOString())
    // Same request, now the pair has been stored (what the capture call records).
    await f.db
      .update(tls)
      .set({
        metadata: {
          ...((await readRow(f)).metadata as object),
          httpCert: { ...state, capturedAt: at(1500).toISOString(), coveredNames: [HOST] },
        },
      })
      .where(eq(tls.id, f.tlsId))
    assert(await event('issued', 3000))
    state = readHttpIssuanceState((await readRow(f)).metadata)!
    assertEquals(state.phase, 'issued')
    assertEquals(state.endedAt, at(3000).toISOString())
    // Closed: further events change nothing.
    assertEquals(await event('failed', 4000, 'late'), false)
  } finally {
    await f.cleanup()
  }
})

test('a failed event closes the request with a plain reason and waits before the next try', async () => {
  if (!dbUrl) return skipWithoutDatabase('http issuance tests')
  const f = await setup({ servers: 1 })
  try {
    await startHttpIssuance(f.deps(), f.tlsId, always)
    assert(
      await handleIssueEvent(f.db, {
        serverId: f.servers[0]!.id,
        requestId: 'req_test_1',
        stage: 'failed',
        reason: 'Port 80 is held by another program.',
        now: at(5000),
      })
    )
    const row = await readRow(f)
    const state = readHttpIssuanceState(row.metadata)!
    assertEquals(state.phase, 'failed')
    assertEquals(state.nextAttemptAt, at(5000 + 600_000).toISOString())
    const acme = (
      row.metadata as { acme: { lastError: string; stage: string; nextAttemptAt: string } }
    ).acme
    assertEquals(acme.stage, 'backoff')
    assertEquals(acme.lastError, 'Port 80 is held by another program.')
    // Too early: held back. After the wait: a new request starts.
    assertEquals(
      await startHttpIssuance(
        f.deps({ now: () => at(60_000), newRequestId: () => 'req_test_2' }),
        f.tlsId,
        always
      ),
      'backoff'
    )
    assertEquals(
      await startHttpIssuance(
        f.deps({ now: () => at(700_000), newRequestId: () => 'req_test_2' }),
        f.tlsId,
        always
      ),
      'ordering'
    )
    assertEquals(readHttpIssuanceState((await readRow(f)).metadata)!.requestId, 'req_test_2')
  } finally {
    await f.cleanup()
  }
})

test('a server that stays silent fails the attempt and the next one avoids it', async () => {
  if (!dbUrl) return skipWithoutDatabase('http issuance tests')
  const f = await setup({ servers: 2 })
  try {
    await startHttpIssuance(f.deps(), f.tlsId, always)
    const first = readHttpIssuanceState((await readRow(f)).metadata)!
    for (const helper of first.forwards) {
      await handleForwardReport(f.db, {
        serverId: helper.serverId,
        requestId: 'req_test_1',
        ok: true,
        now: at(1000),
      })
    }
    assertEquals(await advanceHttpIssuance(f.deps({ now: () => at(2000) }), f.tlsId), 'ordering')
    f.sent.length = 0
    assertEquals(
      await advanceHttpIssuance(f.deps({ now: () => at(4 * 60_000) }), f.tlsId),
      'backoff'
    )
    const failed = readHttpIssuanceState((await readRow(f)).metadata)!
    assertEquals(failed.phase, 'failed')
    assertEquals(failed.avoidServerId, first.issuingServerId)
    // The helper is told to stop passing the proof path on.
    assertEquals(
      f.sent.map((s) => s.envelope.kind),
      ['acme-proof-forward-end']
    )
    f.sent.length = 0
    assertEquals(
      await startHttpIssuance(
        f.deps({ now: () => at(20 * 60_000), newRequestId: () => 'req_test_2' }),
        f.tlsId,
        always
      ),
      'started'
    )
    assert(
      readHttpIssuanceState((await readRow(f)).metadata)!.issuingServerId !== first.issuingServerId
    )
  } finally {
    await f.cleanup()
  }
})

test('three attempts in an hour stop the fourth, even with no wait stored', async () => {
  if (!dbUrl) return skipWithoutDatabase('http issuance tests')
  const f = await setup({ servers: 1 })
  try {
    const row = await readRow(f)
    const minutes = (n: number) => at(n * 60_000).toISOString()
    await f.db
      .update(tls)
      .set({
        metadata: {
          ...(row.metadata as object),
          httpCert: newHttpIssuanceState({
            issuingServerId: f.servers[0]!.id,
            requestId: 'req_old',
            startedAt: minutes(30),
            startByAt: minutes(60),
            endedAt: minutes(31),
            phase: 'failed',
            attemptTimes: [minutes(10), minutes(20), minutes(30)],
          }),
        },
      })
      .where(eq(tls.id, f.tlsId))
    assertEquals(
      await startHttpIssuance(f.deps({ now: () => at(40 * 60_000) }), f.tlsId, always),
      'backoff'
    )
    // Once the oldest of the three is an hour old, the next attempt may start.
    assertEquals(
      await startHttpIssuance(
        f.deps({ now: () => at(71 * 60_000), newRequestId: () => 'req_new' }),
        f.tlsId,
        always
      ),
      'ordering'
    )
  } finally {
    await f.cleanup()
  }
})

test('a daemon of another organization cannot move or read a request', async () => {
  if (!dbUrl) return skipWithoutDatabase('http issuance tests')
  const f = await setup({ servers: 2 })
  const other = await setup({ servers: 1 })
  try {
    await startHttpIssuance(f.deps(), f.tlsId, always)
    const intruder = other.servers[0]!.id
    assertEquals(
      await handleIssueEvent(f.db, {
        serverId: intruder,
        requestId: 'req_test_1',
        stage: 'failed',
        reason: 'x',
        now: at(1000),
      }),
      false
    )
    assertEquals(
      await handleForwardReport(f.db, {
        serverId: intruder,
        requestId: 'req_test_1',
        ok: true,
        now: at(1000),
      }),
      false
    )
    const state = readHttpIssuanceState((await readRow(f)).metadata)!
    assertEquals(state.phase, 'forwarding')
    assert(state.forwards.every((x) => x.outcome === 'pending'))
    // A helper may not speak for the issuing server, nor the issuing server answer a forward.
    const helper = state.forwards[0]!.serverId
    assertEquals(
      await handleIssueEvent(f.db, {
        serverId: helper,
        requestId: 'req_test_1',
        stage: 'issued',
        now: at(1000),
      }),
      false
    )
    assertEquals(
      await handleForwardReport(f.db, {
        serverId: state.issuingServerId,
        requestId: 'req_test_1',
        ok: true,
        now: at(1000),
      }),
      false
    )
  } finally {
    await other.cleanup()
    await f.cleanup()
  }
})

test('a wildcard name is never ordered over the HTTP proof', async () => {
  if (!dbUrl) return skipWithoutDatabase('http issuance tests')
  const f = await setup({ servers: 1 })
  try {
    const row = await readRow(f)
    await f.db
      .update(tls)
      .set({ metadata: { ...(row.metadata as object), dnsNames: ['*.example.com'] } })
      .where(eq(tls.id, f.tlsId))
    assertEquals(await startHttpIssuance(f.deps(), f.tlsId, always), 'not_eligible')
    assertEquals(f.sent.length, 0)
  } finally {
    await f.cleanup()
  }
})

test('a send that fails to the issuing server closes the attempt as failed', async () => {
  if (!dbUrl) return skipWithoutDatabase('http issuance tests')
  const f = await setup({ servers: 1 })
  try {
    const deps = f.deps({ send: () => Promise.reject(new Error('socket closed')) })
    assertEquals(await startHttpIssuance(deps, f.tlsId, always), 'ordering')
    const state = readHttpIssuanceState((await readRow(f)).metadata)!
    assertEquals(state.phase, 'failed')
    assertEquals(state.lastError, 'The server could not be reached.')
  } finally {
    await f.cleanup()
  }
})

/** Put a stored pair and a finished flow request on the row, as the capture call leaves them. */
async function giveFlowPair(
  f: Fixture,
  over: Partial<ReturnType<typeof newHttpIssuanceState>> = {},
  withKey = true
) {
  const row = await readRow(f)
  const issuedAt = at(-3_600_000).toISOString()
  await f.db
    .update(tls)
    .set({
      ...(withKey ? { certificatePem: 'chain', privateKeyPem: 'tpsecret.x' } : {}),
      metadata: {
        ...(row.metadata as object),
        httpCert: newHttpIssuanceState({
          issuingServerId: f.servers[0]!.id,
          requestId: 'req_done',
          startedAt: at(-7_200_000).toISOString(),
          startByAt: at(-5_400_000).toISOString(),
          endedAt: issuedAt,
          phase: 'issued',
          centralPair: true,
          issueTimes: [issuedAt],
          capturedAt: issuedAt,
          issuedEventAt: issuedAt,
          roster: [{ serverId: f.servers[0]!.id, label: 'edge-0', role: 'issuer' }],
          ...over,
        }),
      },
    })
    .where(eq(tls.id, f.tlsId))
}

test('a finished pair is handed to the sites once, and the helpers are told to stop', async () => {
  if (!dbUrl) return skipWithoutDatabase('http issuance tests')
  const f = await setup()
  try {
    const helpers = f.servers.slice(1).map((s) => s.id)
    await giveFlowPair(f, {
      forwards: helpers.map((serverId) => ({
        serverId,
        outcome: 'ready' as const,
        reason: null,
        at: null,
      })),
    })
    const pushed: string[] = []
    const push = (tlsId: string) => {
      pushed.push(tlsId)
      return Promise.resolve()
    }
    assertEquals(await deliverIssuedPair(f.deps(), f.tlsId, null), 'waiting')
    assertEquals(await deliverIssuedPair(f.deps(), f.tlsId, push), 'delivered')
    assertEquals(pushed, [f.tlsId])
    assertEquals(
      f.sent.map((x) => x.envelope.kind),
      ['acme-proof-forward-end', 'acme-proof-forward-end']
    )
    assertEquals(typeof readHttpIssuanceState((await readRow(f)).metadata)!.deliveredAt, 'string')
    assertEquals(await deliverIssuedPair(f.deps(), f.tlsId, push), 'not_due')
    assertEquals(pushed.length, 1)
  } finally {
    await f.cleanup()
  }
})

test('a pair the flow ordered is renewed when due, preferring the same issuing server', async () => {
  if (!dbUrl) return skipWithoutDatabase('http issuance tests')
  const f = await setup({ servers: 2 })
  try {
    const issuer = f.servers.map((s) => s.id).sort()[1]!
    await giveFlowPair(f, { issuingServerId: issuer, renewAt: at(-1000).toISOString() })
    const due = () => true
    assertEquals(await startHttpIssuance(f.deps(), f.tlsId, due), 'started')
    const state = readHttpIssuanceState((await readRow(f)).metadata)!
    assertEquals(state.issuingServerId, issuer)
    assertEquals(state.centralPair, true)
    assertEquals(state.issueTimes.length, 1)
    // The old pair keeps serving while the new one is ordered.
    assertEquals((await readRow(f)).privateKeyPem, 'tpsecret.x')
    // Not due: nothing starts.
    const f2 = await setup({ servers: 1 })
    try {
      await giveFlowPair(f2, { renewAt: at(86_400_000).toISOString() })
      assertEquals(await startHttpIssuance(f2.deps(), f2.tlsId, () => false), 'not_due')
    } finally {
      await f2.cleanup()
    }
  } finally {
    await f.cleanup()
  }
})

test('Replace Key starts a new order for the same names, once a day', async () => {
  if (!dbUrl) return skipWithoutDatabase('http issuance tests')
  const f = await setup({ servers: 1 })
  try {
    await giveFlowPair(f, { issueTimes: [at(-2 * 86_400_000).toISOString()] })
    const first = await replaceKey(f.deps(), f.tlsId)
    assertEquals(first, { ok: true, started: 'ordering', leftThisWeek: 4 })
    assertEquals(
      f.sent.map((x) => x.envelope.kind),
      ['acme-issue-request']
    )
    // A request is open now.
    const again = await replaceKey(f.deps({ now: () => at(60_000) }), f.tlsId)
    assertEquals(again.ok, false)
    assertEquals(!again.ok && again.reason, 'in_progress')
  } finally {
    await f.cleanup()
  }
})

test('Replace Key is refused within a day of the last issue and with no certificate to replace', async () => {
  if (!dbUrl) return skipWithoutDatabase('http issuance tests')
  const f = await setup({ servers: 1 })
  try {
    const none = await replaceKey(f.deps(), f.tlsId)
    assertEquals(!none.ok && none.reason, 'no_certificate')
    await giveFlowPair(f, { issueTimes: [at(-3_600_000).toISOString()] })
    const soon = await replaceKey(f.deps(), f.tlsId)
    assertEquals(!soon.ok && soon.reason, 'too_soon')
    assertEquals(f.sent.length, 0)
  } finally {
    await f.cleanup()
  }
})

test('two sweeps at once start only one order', async () => {
  if (!dbUrl) return skipWithoutDatabase('http issuance tests')
  const f = await setup({ servers: 2 })
  try {
    const outcomes = await Promise.all([
      startHttpIssuance(f.deps(), f.tlsId, always),
      startHttpIssuance(f.deps(), f.tlsId, always),
    ])
    assertEquals(outcomes.filter((o) => o === 'started').length, 1)
    assertEquals(outcomes.filter((o) => o === 'started' || o === 'ordering').length, 1)
    assertEquals(f.sent.filter((s) => s.envelope.kind === 'acme-proof-forward').length, 1)
  } finally {
    await f.cleanup()
  }
})

test('two deliveries at once push the pair once and tell the helpers once', async () => {
  if (!dbUrl) return skipWithoutDatabase('http issuance tests')
  const f = await setup()
  try {
    const helpers = f.servers.slice(1).map((s) => s.id)
    await giveFlowPair(f, {
      forwards: helpers.map((serverId) => ({
        serverId,
        outcome: 'ready' as const,
        reason: null,
        at: null,
      })),
    })
    let pushes = 0
    const push = () => {
      pushes += 1
      return Promise.resolve()
    }
    const results = await Promise.all([
      deliverIssuedPair(f.deps(), f.tlsId, push),
      deliverIssuedPair(f.deps(), f.tlsId, push),
    ])
    assertEquals(results.filter((r) => r === 'delivered').length, 1)
    assertEquals(pushes, 1)
    assertEquals(f.sent.filter((s) => s.envelope.kind === 'acme-proof-forward-end').length, 2)
  } finally {
    await f.cleanup()
  }
})

test('a push that throws releases the delivery so the next sweep tries again', async () => {
  if (!dbUrl) return skipWithoutDatabase('http issuance tests')
  const f = await setup({ servers: 1 })
  try {
    await giveFlowPair(f)
    let threw = false
    try {
      await deliverIssuedPair(f.deps(), f.tlsId, () => Promise.reject(new Error('queue down')))
    } catch {
      threw = true
    }
    assertEquals(threw, true)
    assertEquals(readHttpIssuanceState((await readRow(f)).metadata)!.deliveredAt, null)
    assertEquals(await deliverIssuedPair(f.deps(), f.tlsId, () => Promise.resolve()), 'delivered')
  } finally {
    await f.cleanup()
  }
})

test('after the issuing server reports a failure the helpers are told to stop, once', async () => {
  if (!dbUrl) return skipWithoutDatabase('http issuance tests')
  const f = await setup()
  try {
    await startHttpIssuance(f.deps(), f.tlsId, always)
    const state = readHttpIssuanceState((await readRow(f)).metadata)!
    await handleIssueEvent(f.db, {
      serverId: state.issuingServerId,
      requestId: 'req_test_1',
      stage: 'failed',
      reason: 'no',
      now: at(2000),
    })
    f.sent.length = 0
    assertEquals(await sendPendingEnds(f.deps(), f.tlsId), true)
    assertEquals(
      f.sent.map((s) => s.envelope.kind),
      ['acme-proof-forward-end', 'acme-proof-forward-end']
    )
    assertEquals(await sendPendingEnds(f.deps(), f.tlsId), false)
    assertEquals(f.sent.length, 2)
  } finally {
    await f.cleanup()
  }
})

test('with no contact address nothing is looked up, sent or written', async () => {
  if (!dbUrl) return skipWithoutDatabase('http issuance tests')
  const f = await setup({ servers: 2 })
  try {
    let lookups = 0
    const before = (await readRow(f)).metadata
    const deps = f.deps({
      contact: () => Promise.resolve({ contactEmail: ' ', staging: false }),
      dnsLookup: () => {
        lookups += 1
        return Promise.resolve([])
      },
    })
    assertEquals(await startHttpIssuance(deps, f.tlsId, always), 'waiting')
    assertEquals(lookups, 0)
    assertEquals(f.sent.length, 0)
    assertEquals((await readRow(f)).metadata, before)
  } finally {
    await f.cleanup()
  }
})

test('a row that is not due or is waiting out a back-off costs no lookups', async () => {
  if (!dbUrl) return skipWithoutDatabase('http issuance tests')
  const f = await setup({ servers: 1 })
  try {
    let lookups = 0
    const deps = f.deps({
      dnsLookup: () => {
        lookups += 1
        return Promise.resolve([])
      },
    })
    assertEquals(await startHttpIssuance(deps, f.tlsId, () => false), 'not_due')
    await giveFlowPair(f, { phase: 'failed', nextAttemptAt: at(600_000).toISOString() }, false)
    assertEquals(await startHttpIssuance(deps, f.tlsId, always), 'backoff')
    assertEquals(lookups, 0)
  } finally {
    await f.cleanup()
  }
})
