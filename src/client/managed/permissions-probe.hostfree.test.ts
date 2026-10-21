import { assertEquals } from '@std/assert'
import type { Db } from '../../db/connection.ts'
import type { DaemonCellRegistry } from '../../contracts/cell.ts'
import type { DaemonOutboundEnvelope } from '../../contracts/cell-protocol.ts'
import { MANAGED_PERMISSIONS_READ_FEATURE } from '../../lib/version-wire.ts'
import {
  type ManagedPermissionsProbeDeps,
  type ManagedPermissionsProbeParams,
  probeManagedPermissions,
} from './permissions-probe.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const NOW = '2026-10-16T12:00:00.000Z'
const DB = {} as Db

const PARAMS: ManagedPermissionsProbeParams = {
  serverId: 'server-1',
  managedId: 'managed-1',
  engine: 'postgres',
  logins: ['app'],
  databases: ['shop'],
  timeoutMs: 4321,
}

type Reply = { status: string; result?: unknown; error?: string }

function fakeRegistry(reply: Reply) {
  const sent: { envelope: DaemonOutboundEnvelope; timeoutMs: number }[] = []
  const registry = {
    getCell: () => ({
      createRequestAndWait: (envelope: DaemonOutboundEnvelope, timeoutMs: number) => {
        sent.push({ envelope, timeoutMs })
        return Promise.resolve({ serverId: 'server-1', requestId: envelope.requestId, ...reply })
      },
    }),
  } as unknown as DaemonCellRegistry
  return { registry, sent }
}

function deps(overrides: Partial<ManagedPermissionsProbeDeps> = {}): ManagedPermissionsProbeDeps {
  return {
    daemonFeatures: () => Promise.resolve([MANAGED_PERMISSIONS_READ_FEATURE]),
    isServerConnected: () => Promise.resolve(true),
    ...overrides,
  }
}

const REPORT = {
  engine: 'postgres',
  observedAt: NOW,
  logins: [{ username: 'app', exists: true, memberships: [], grants: [], defaults: [] }],
}

test('sends nothing to a daemon that does not advertise managed-permissions-read-v1', async () => {
  const { registry, sent } = fakeRegistry({ status: 'done', result: { ok: true } })
  const outcome = await probeManagedPermissions(
    DB,
    registry,
    PARAMS,
    deps({ daemonFeatures: () => Promise.resolve(['managed-health-v1']) })
  )
  assertEquals(outcome, { status: 'unsupported' })
  assertEquals(sent.length, 0)
})

test('is unavailable, sending nothing, without a registry or an online server', async () => {
  assertEquals(await probeManagedPermissions(DB, undefined, PARAMS, deps()), {
    status: 'unavailable',
    reason: 'no_registry',
  })
  const { registry, sent } = fakeRegistry({ status: 'done' })
  const outcome = await probeManagedPermissions(
    DB,
    registry,
    PARAMS,
    deps({ isServerConnected: () => Promise.resolve(false) })
  )
  assertEquals(outcome, { status: 'unavailable', reason: 'offline' })
  assertEquals(sent.length, 0)
})

test('sends the logins, databases and timeout and parses the report', async () => {
  const { registry, sent } = fakeRegistry({
    status: 'done',
    result: { ok: true, permissions: REPORT },
  })
  const outcome = await probeManagedPermissions(DB, registry, PARAMS, deps())
  assertEquals(outcome.status, 'observed')
  assertEquals(sent.length, 1)
  assertEquals(sent[0]!.timeoutMs, 4321)
  const envelope = sent[0]!.envelope
  assertEquals(envelope.kind, 'managed-permissions-request')
  if (envelope.kind !== 'managed-permissions-request') return
  assertEquals(envelope.logins, ['app'])
  assertEquals(envelope.databases, ['shop'])
  assertEquals(envelope.managedId, 'managed-1')
  assertEquals(envelope.engine, 'postgres')
})

test('maps timeouts, daemon errors and malformed answers to unavailable', async () => {
  const expired = fakeRegistry({ status: 'expired' })
  assertEquals(await probeManagedPermissions(DB, expired.registry, PARAMS, deps()), {
    status: 'unavailable',
    reason: 'timeout',
  })
  const failed = fakeRegistry({ status: 'failed', error: 'engine not running' })
  assertEquals(await probeManagedPermissions(DB, failed.registry, PARAMS, deps()), {
    status: 'unavailable',
    reason: 'daemon_error',
    error: 'engine not running',
  })
  const bad = fakeRegistry({ status: 'done', result: { ok: true, permissions: { engine: 1 } } })
  assertEquals(await probeManagedPermissions(DB, bad.registry, PARAMS, deps()), {
    status: 'unavailable',
    reason: 'invalid_result',
  })
  const notOk = fakeRegistry({ status: 'done', result: { ok: false, error: 'x' } })
  assertEquals(await probeManagedPermissions(DB, notOk.registry, PARAMS, deps()), {
    status: 'unavailable',
    reason: 'invalid_result',
  })
})
