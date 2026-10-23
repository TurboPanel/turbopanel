/**
 * Host-free coverage for asking one host to try its peers: a host that cannot
 * be asked reads as "not tested" and nothing is sent to it.
 */

import { assertEquals } from '@std/assert'
import type { DaemonCell, DaemonCellRegistry } from '../../contracts/cell.ts'
import type { Db } from '../../db/connection.ts'
import { SERVER_NETWORK_CHECK_FEATURE } from '../../lib/version-wire.ts'
import { probeServerNetworkCheck } from './network-check-probe.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const SERVER = '00000000-0000-4000-8000-0000000000a1'
const PEER = '00000000-0000-4000-8000-0000000000a2'
const db = {} as unknown as Db
const targets = [{ peerServerId: PEER, address: '10.0.0.2', port: 22 }]

function fakeRegistry(reply: { status: string; result?: unknown } | Error) {
  const sent: string[] = []
  const cell = {
    createRequestAndWait: (outbound: { kind: string }) => {
      sent.push(outbound.kind)
      if (reply instanceof Error) return Promise.reject(reply)
      return Promise.resolve({ status: reply.status, result: reply.result ?? null })
    },
  } as unknown as DaemonCell
  const registry = { getCell: () => cell } as unknown as DaemonCellRegistry
  return { registry, sent }
}

const ready = {
  daemonFeatures: () => Promise.resolve([SERVER_NETWORK_CHECK_FEATURE]),
  isServerConnected: () => Promise.resolve(true),
}

const params = { serverId: SERVER, targets, timeoutMs: 50 }

test('a host without the feature is not asked', async () => {
  const { registry, sent } = fakeRegistry({ status: 'done' })
  const outcome = await probeServerNetworkCheck(db, registry, params, {
    ...ready,
    daemonFeatures: () => Promise.resolve([]),
  })
  assertEquals(outcome, { status: 'not_tested', reason: 'daemon_update_required' })
  assertEquals(sent, [])
})

test('an offline host is not asked', async () => {
  const { registry, sent } = fakeRegistry({ status: 'done' })
  const outcome = await probeServerNetworkCheck(db, registry, params, {
    ...ready,
    isServerConnected: () => Promise.resolve(false),
  })
  assertEquals(outcome, { status: 'not_tested', reason: 'offline' })
  assertEquals(sent, [])
})

test('no registry reads as not tested', async () => {
  assertEquals(await probeServerNetworkCheck(db, undefined, params, ready), {
    status: 'not_tested',
    reason: 'error',
  })
})

test('a host that answers in time returns its results', async () => {
  const results = [{ peerServerId: PEER, address: '10.0.0.2', reachable: true, latencyMs: 1 }]
  const { registry, sent } = fakeRegistry({ status: 'done', result: { ok: true, results } })
  assertEquals(await probeServerNetworkCheck(db, registry, params, ready), {
    status: 'checked',
    results,
  })
  assertEquals(sent, ['server-network-check-request'])
})

test('a host that does not answer in time reads as a timeout', async () => {
  const { registry } = fakeRegistry({ status: 'expired' })
  assertEquals(await probeServerNetworkCheck(db, registry, params, ready), {
    status: 'not_tested',
    reason: 'timeout',
  })
})

test('a malformed or failed answer reads as an error, never as reachable', async () => {
  for (const reply of [
    { status: 'failed' },
    { status: 'done', result: { ok: false } },
    { status: 'done', result: { ok: true, results: [{ peerServerId: PEER }] } },
    new Error('socket closed'),
  ]) {
    const { registry } = fakeRegistry(reply)
    assertEquals(await probeServerNetworkCheck(db, registry, params, ready), {
      status: 'not_tested',
      reason: 'error',
    })
  }
})
