import { assertEquals } from '@std/assert'
import { buildNameLock } from './name-lock.ts'
import { toRoutesPayload } from './route-builder.ts'
import { healStaleTunnelTable, staleTunnelTableWarning } from './stale-table-note.ts'
import {
  canonicalTunnelFacts,
  daemonTakesTunnelGeneration,
  generationForDaemon,
  decideTunnelGeneration,
  nextTunnelGeneration,
  planGenerationBump,
  TUNNEL_GENERATION_BUMP_GAP_MS,
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

test('a refusal raises the generation to the clock, and not again within the gap', () => {
  const stored = { contentHash: 'h', generation: 5 }
  const first = planGenerationBump(stored, NOW)
  assertEquals(first, { contentHash: 'h', generation: NOW, bumpedAt: NOW })
  assertEquals(planGenerationBump(first, NOW + TUNNEL_GENERATION_BUMP_GAP_MS - 1), undefined)
  const later = planGenerationBump(first, NOW + TUNNEL_GENERATION_BUMP_GAP_MS)
  assertEquals(later?.generation, NOW + TUNNEL_GENERATION_BUMP_GAP_MS)
  assertEquals(planGenerationBump(undefined, NOW)?.generation, NOW)
})

test('a stored raise time survives a read', () => {
  const stored = { contentHash: 'h', generation: 3, bumpedAt: NOW }
  assertEquals(readStoredTunnelGeneration({ tunnelTable: stored }), stored)
})

const STALE = {
  applied: false,
  warnings: ['tunnel table generation 5 is older than the one in place; left as it is'],
}
const RECORD = { id: 'c1', type: 'server.tunnel.routes', serverId: 's1' }

function ports(bumped: number | undefined, org: string | null = 'o1') {
  const resent: string[] = []
  return {
    resent,
    ports: {
      organizationOf: () => Promise.resolve(org ?? undefined),
      bump: () => Promise.resolve(bumped),
      resend: (_o: string, serverId: string) => {
        resent.push(serverId)
        return Promise.resolve()
      },
    },
  }
}

test('a stale refusal raises the generation and sends that server its table again', async () => {
  const p = ports(NOW)
  assertEquals(await healStaleTunnelTable(RECORD, STALE, p.ports), true)
  assertEquals(p.resent, ['s1'])
})

test('a refusal inside the gap, an ordinary answer or a gone server sends nothing', async () => {
  const limited = ports(undefined)
  assertEquals(await healStaleTunnelTable(RECORD, STALE, limited.ports), false)
  const ordinary = ports(NOW)
  assertEquals(
    await healStaleTunnelTable(RECORD, { applied: false, warnings: [] }, ordinary.ports),
    false
  )
  const gone = ports(NOW, null)
  assertEquals(await healStaleTunnelTable(RECORD, STALE, gone.ports), false)
  assertEquals([...limited.resent, ...ordinary.resent, ...gone.resent], [])
})
