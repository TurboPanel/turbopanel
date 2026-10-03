import { assertEquals } from '@std/assert'
import type { Db } from '../../db/connection.ts'
import type { DaemonCellRegistry } from '../../contracts/cell.ts'
import type { DaemonOutboundEnvelope } from '../../contracts/cell-protocol.ts'
import type { ManagedReplicationHealth } from '../../contracts/commands/schemas.ts'
import { MANAGED_HEALTH_FEATURE } from '../../lib/version-wire.ts'
import {
  createFreshStandbyProbe,
  type ManagedHealthProbeDeps,
  type ManagedHealthProbeParams,
  MANAGED_HEALTH_PROBE_PROMOTE_TIMEOUT_MS,
  probeManagedMemberHealth,
} from './health-probe.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const MEMBER_ID = '99999999-9999-4999-8999-999999999999'
const OTHER_MEMBER_ID = '99999999-9999-4999-8999-999999999998'
const NOW = '2026-09-29T12:00:00.000Z'

const PARAMS: ManagedHealthProbeParams = {
  serverId: 'server-1',
  managedId: 'managed-1',
  memberId: MEMBER_ID,
  role: 'replica',
  engine: 'postgres',
  timeoutMs: 1234,
}

const FRESH: ManagedReplicationHealth = {
  state: 'streaming',
  lagBytes: 16,
  lagSeconds: 1,
  observedAt: NOW,
}

type Reply = { status: string; result?: unknown; error?: string }

/** Registry whose cell answers `reply` and records every envelope and timeout. */
function fakeRegistry(reply: Reply | (() => Promise<Reply>)) {
  const sent: { envelope: DaemonOutboundEnvelope; timeoutMs: number }[] = []
  const registry = {
    getCell: () => ({
      createRequestAndWait: async (envelope: DaemonOutboundEnvelope, timeoutMs: number) => {
        sent.push({ envelope, timeoutMs })
        const r = typeof reply === 'function' ? await reply() : reply
        return { serverId: 'server-1', requestId: envelope.requestId, ...r }
      },
    }),
  } as unknown as DaemonCellRegistry
  return { registry, sent }
}

function deps(overrides: Partial<ManagedHealthProbeDeps> = {}) {
  const persisted: { memberId: string; replication: ManagedReplicationHealth }[] = []
  const merged: ManagedHealthProbeDeps = {
    daemonFeatures: () => Promise.resolve([MANAGED_HEALTH_FEATURE]),
    isServerConnected: () => Promise.resolve(true),
    persist: (memberId, replication) => {
      persisted.push({ memberId, replication })
      return Promise.resolve()
    },
    ...overrides,
  }
  return { merged, persisted }
}

const DB = {} as Db

function ok(member: unknown): Reply {
  return { status: 'done', result: { ok: true, member } }
}

test('sends nothing to a daemon that does not advertise managed-health-v1', async () => {
  const { registry, sent } = fakeRegistry(ok({}))
  const { merged, persisted } = deps({
    daemonFeatures: () => Promise.resolve(['update-progress-v1']),
  })
  const outcome = await probeManagedMemberHealth(DB, registry, PARAMS, merged)
  assertEquals(outcome, { status: 'unsupported' })
  assertEquals(sent.length, 0)
  assertEquals(persisted.length, 0)
})

test('a daemon with no recorded features is unsupported', async () => {
  const { registry, sent } = fakeRegistry(ok({}))
  const { merged } = deps({ daemonFeatures: () => Promise.resolve([]) })
  assertEquals(await probeManagedMemberHealth(DB, registry, PARAMS, merged), {
    status: 'unsupported',
  })
  assertEquals(sent.length, 0)
})

test('is unavailable, sending nothing, without a registry or an online server', async () => {
  const { merged } = deps()
  assertEquals(await probeManagedMemberHealth(DB, undefined, PARAMS, merged), {
    status: 'unavailable',
    reason: 'no_registry',
  })
  const { registry, sent } = fakeRegistry(ok({}))
  const offline = deps({ isServerConnected: () => Promise.resolve(false) })
  assertEquals(await probeManagedMemberHealth(DB, registry, PARAMS, offline.merged), {
    status: 'unavailable',
    reason: 'offline',
  })
  assertEquals(sent.length, 0)
})

test('sends the member role, engine and timeout, then persists the observation', async () => {
  const { registry, sent } = fakeRegistry(
    ok({
      memberId: MEMBER_ID,
      role: 'replica',
      status: 'ready',
      replication: FRESH,
    })
  )
  const { merged, persisted } = deps()
  const outcome = await probeManagedMemberHealth(DB, registry, PARAMS, merged)
  assertEquals(outcome, { status: 'observed', replication: FRESH })
  assertEquals(persisted, [{ memberId: MEMBER_ID, replication: FRESH }])
  assertEquals(sent.length, 1)
  assertEquals(sent[0]!.timeoutMs, 1234)
  const envelope = sent[0]!.envelope
  assertEquals(envelope.kind, 'managed-health-request')
  if (envelope.kind !== 'managed-health-request') return
  assertEquals(envelope.role, 'replica')
  assertEquals(envelope.engine, 'postgres')
  assertEquals(envelope.managedId, 'managed-1')
  assertEquals(envelope.memberId, MEMBER_ID)
})

test('a timeout keeps the stored observation: nothing is persisted', async () => {
  const { registry } = fakeRegistry({ status: 'expired' })
  const { merged, persisted } = deps()
  assertEquals(await probeManagedMemberHealth(DB, registry, PARAMS, merged), {
    status: 'unavailable',
    reason: 'timeout',
  })
  assertEquals(persisted.length, 0)
})

test('a daemon error (ok:false) is unavailable and persists nothing', async () => {
  const { registry } = fakeRegistry({ status: 'failed', error: 'engine not running' })
  const { merged, persisted } = deps()
  assertEquals(await probeManagedMemberHealth(DB, registry, PARAMS, merged), {
    status: 'unavailable',
    reason: 'daemon_error',
    error: 'engine not running',
  })
  assertEquals(persisted.length, 0)
})

test('a reply naming a different member is dropped, never written', async () => {
  const { registry } = fakeRegistry(
    ok({
      memberId: OTHER_MEMBER_ID,
      role: 'replica',
      status: 'ready',
      replication: FRESH,
    })
  )
  const { merged, persisted } = deps()
  assertEquals(await probeManagedMemberHealth(DB, registry, PARAMS, merged), {
    status: 'unavailable',
    reason: 'member_mismatch',
  })
  assertEquals(persisted.length, 0)
})

test('a malformed result is unavailable', async () => {
  const cases: unknown[] = [
    null,
    { ok: true },
    { ok: true, member: { memberId: MEMBER_ID } },
    { ok: true, member: { memberId: MEMBER_ID, replication: { state: 'streaming' } } },
    {
      ok: true,
      member: {
        memberId: MEMBER_ID,
        replication: { state: 'streaming', observedAt: 'not-a-date' },
      },
    },
  ]
  for (const result of cases) {
    const { registry } = fakeRegistry({ status: 'done', result })
    const { merged, persisted } = deps()
    assertEquals(await probeManagedMemberHealth(DB, registry, PARAMS, merged), {
      status: 'unavailable',
      reason: 'invalid_result',
    })
    assertEquals(persisted.length, 0)
  }
})

test('a throwing transport or persist is contained as unavailable', async () => {
  const { registry } = fakeRegistry(() => Promise.reject(new TypeError('cell down')))
  const { merged } = deps()
  assertEquals(await probeManagedMemberHealth(DB, registry, PARAMS, merged), {
    status: 'unavailable',
    reason: 'error',
    error: 'cell down',
  })

  const good = fakeRegistry(
    ok({
      memberId: MEMBER_ID,
      role: 'replica',
      status: 'ready',
      replication: FRESH,
    })
  )
  const failing = deps({ persist: () => Promise.reject(new TypeError('db down')) })
  assertEquals(await probeManagedMemberHealth(DB, good.registry, PARAMS, failing.merged), {
    status: 'unavailable',
    reason: 'error',
    error: 'db down',
  })
})

const COLD: ManagedReplicationHealth = {
  state: 'stopped',
  observedAt: NOW,
  receivedLsn: '0/3000148',
  replayLsn: '0/3000148',
  receiveLagBytes: 0,
  lastStreaming: { at: NOW, ageMs: 4000, lagBytes: 0, lagSeconds: 0.5, receiveLagBytes: 128 },
}

test('keeps the standby WAL positions and last streaming read, dropping a malformed one', async () => {
  const { registry } = fakeRegistry(
    ok({ memberId: MEMBER_ID, role: 'replica', status: 'ready', replication: COLD })
  )
  const { merged, persisted } = deps()
  const outcome = await probeManagedMemberHealth(DB, registry, PARAMS, merged)
  assertEquals(outcome, { status: 'observed', replication: COLD })
  // The age is only meaningful at probe time: never stored.
  const { lastStreaming: _age, ...stored } = COLD
  assertEquals(persisted, [{ memberId: MEMBER_ID, replication: stored }])

  const { registry: bad } = fakeRegistry(
    ok({
      memberId: MEMBER_ID,
      role: 'replica',
      status: 'ready',
      replication: { state: 'stopped', observedAt: NOW, lastStreaming: { at: NOW } },
    })
  )
  const dropped = await probeManagedMemberHealth(DB, bad, PARAMS, deps().merged)
  assertEquals(dropped, { status: 'observed', replication: { state: 'stopped', observedAt: NOW } })
})

test('the fresh-standby probe asks for a replica with the promote timeout', async () => {
  const { registry, sent } = fakeRegistry(
    ok({ memberId: MEMBER_ID, role: 'replica', status: 'ready', replication: COLD })
  )
  const probe = createFreshStandbyProbe(DB, registry, { deps: deps().merged })
  const target = {
    memberId: MEMBER_ID,
    managedId: 'managed-1',
    serverId: 'server-1',
    engine: 'postgres',
  }
  assertEquals(await probe(target), COLD)
  assertEquals(sent[0]!.timeoutMs, MANAGED_HEALTH_PROBE_PROMOTE_TIMEOUT_MS)
  const envelope = sent[0]!.envelope
  if (envelope.kind !== 'managed-health-request') throw new TypeError('wrong envelope')
  assertEquals(envelope.role, 'replica')
})

test('the fresh-standby probe answers null for its own cell or any non-observed outcome', async () => {
  const { registry, sent } = fakeRegistry({ status: 'expired' })
  const target = {
    memberId: MEMBER_ID,
    managedId: 'managed-1',
    serverId: 'server-1',
    engine: 'postgres',
  }
  const own = createFreshStandbyProbe(DB, registry, {
    skipServerId: 'server-1',
    deps: deps().merged,
  })
  assertEquals(await own(target), null)
  assertEquals(sent.length, 0)
  const other = createFreshStandbyProbe(DB, registry, { deps: deps().merged })
  assertEquals(await other(target), null)
  assertEquals(sent.length, 1)
})
