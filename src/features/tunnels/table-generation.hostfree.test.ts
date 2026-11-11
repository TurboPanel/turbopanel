import { assertEquals } from '@std/assert'
import { buildNameLock } from './name-lock.ts'
import { toRoutesPayload } from './route-builder.ts'
import { staleTunnelTableWarning } from './stale-table-note.ts'
import {
  canonicalTunnelFacts,
  daemonTakesTunnelGeneration,
  generationForDaemon,
  decideTunnelGeneration,
  nextTunnelGeneration,
  readStoredTunnelGeneration,
} from './table-generation.ts'
import type { RoutingFacts } from './route-facts.ts'

/** Sonar only recognises `test()`; see backups-reconcile.hostfree.test.ts. */
const test = Deno.test.bind(Deno)

const NOW = 1_800_000_000_000

function facts(order: 'a' | 'b'): RoutingFacts {
  const doorways = [
    { hostname: 'a.example.com', siteServerIds: ['s2', 's1'], isLocalOnly: true },
    { hostname: 'b.example.com', siteServerIds: ['s1'], isLocalOnly: false },
  ]
  return {
    tunnels: [
      {
        carrying: order === 'a' ? ['s1', 's2'] : ['s2', 's1'],
        doorways: order === 'a' ? doorways : [...doorways].reverse(),
      },
    ],
    addresses: new Map(
      order === 'a'
        ? [
            ['s1', ['10.0.0.1']],
            ['s2', ['10.0.0.2']],
          ]
        : [
            ['s2', ['10.0.0.2']],
            ['s1', ['10.0.0.1']],
          ]
    ),
  }
}

test('uses the clock when nothing is stored and never goes below it', () => {
  assertEquals(nextTunnelGeneration(undefined, NOW), NOW)
  assertEquals(nextTunnelGeneration(5, NOW), NOW)
})

test('goes above the previous value when the clock is behind it', () => {
  assertEquals(nextTunnelGeneration(NOW + 10_000, NOW), NOW + 10_001)
})

test('keeps the generation for an unchanged table, however much later it is resent', () => {
  const first = decideTunnelGeneration(undefined, 'h1', NOW)
  assertEquals(first.changed, true)
  const again = decideTunnelGeneration(first, 'h1', NOW + 3_600_000)
  assertEquals(again, { contentHash: 'h1', generation: NOW, changed: false })
})

test('raises the generation when the content changes', () => {
  const first = decideTunnelGeneration(undefined, 'h1', NOW)
  const second = decideTunnelGeneration(first, 'h2', NOW)
  assertEquals(second.changed, true)
  assertEquals(second.generation, NOW + 1)
  assertEquals(decideTunnelGeneration(second, 'h3', NOW + 60_000).generation, NOW + 60_000)
})

test('gives the same content text whatever order the facts come in', () => {
  assertEquals(canonicalTunnelFacts(facts('a')), canonicalTunnelFacts(facts('b')))
})

test('reads only a well-formed stored value', () => {
  const stored = readStoredTunnelGeneration({ tunnelTable: { contentHash: 'h', generation: 3 } })
  assertEquals(stored, { contentHash: 'h', generation: 3 })
  const negative = readStoredTunnelGeneration({ tunnelTable: { contentHash: 'h', generation: -1 } })
  assertEquals(negative, undefined)
  assertEquals(readStoredTunnelGeneration(null), undefined)
})

test('is sent only to a daemon that lists the feature', () => {
  assertEquals(daemonTakesTunnelGeneration(['tunnel-forwarding-v1']), false)
  assertEquals(daemonTakesTunnelGeneration(undefined), false)
  assertEquals(daemonTakesTunnelGeneration(['tunnel-table-generation-v1']), true)
})

test('does not change the table hash, so an old daemon keeps its hash', async () => {
  const built = {
    routes: [],
    peerAddresses: [],
    listenAddresses: [],
    needsPeerMaterial: false,
    skipped: [],
    warnings: [],
  }
  const payload = await toRoutesPayload(built, undefined)
  assertEquals('generation' in payload, false)
  assertEquals(await toRoutesPayload({ ...built }, undefined), payload)
})

test('builds a deploy tunnel block with no generation of its own', () => {
  const lock = buildNameLock({
    siteHostnames: ['a.example.com'],
    doorways: [{ hostname: 'a.example.com', tunnelId: 't1', isLocalOnly: true }],
    carryingByTunnel: new Map([['t1', ['s1', 's2']]]),
    serverId: 's1',
    addresses: new Map([['s2', ['10.0.0.2']]]),
  })
  assertEquals(lock.tunnel && 'generation' in lock.tunnel, false)
})

test('notices the daemon refusing a table as older than its own', () => {
  const warning = 'tunnel table generation 5 is older than the one in place; left as it is'
  const result = { applied: false, warnings: [warning] }
  assertEquals(staleTunnelTableWarning('server.tunnel.routes', result), warning)
  const quiet = staleTunnelTableWarning('server.tunnel.routes', { applied: false, warnings: [] })
  assertEquals(quiet, undefined)
  assertEquals(staleTunnelTableWarning('server.tunnel.connectors', result), undefined)
})

test('an old daemon is resolved nothing, a daemon with the feature gets the table generation', async () => {
  let calls = 0
  const resolve = () => {
    calls += 1
    return Promise.resolve(NOW)
  }
  assertEquals(await generationForDaemon(['tunnel-forwarding-v1'], resolve), undefined)
  assertEquals(calls, 0)
  assertEquals(await generationForDaemon(['tunnel-table-generation-v1'], resolve), NOW)
  assertEquals(calls, 1)
})
