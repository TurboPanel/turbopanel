/**
 * Host-free coverage for the loader behind `GET /servers/:id/traffic-map`: a
 * fake `Db` answers each select by table so the whole path runs (memberships,
 * policies, reported addresses, names) without a database.
 */

import { assertEquals } from '@std/assert'
import { getTableName } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { loadServerTrafficMap } from './server-traffic-map-load.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const A = '00000000-0000-4000-8000-00000000000a'
const B = '00000000-0000-4000-8000-00000000000b'
const C = '00000000-0000-4000-8000-00000000000c'
const LAN = '00000000-0000-4000-8000-0000000000d1'
const BACKHAUL = '00000000-0000-4000-8000-0000000000d2'

type Row = Record<string, unknown>

function pinRow(serverId: string, datacenterId: string, address: string, metadata: unknown = null) {
  return {
    ipId: `ip-${serverId}-${datacenterId}`,
    serverId,
    datacenterId,
    networkId: null,
    address,
    metadata,
  }
}

function thenable(rows: Row[]) {
  const chain: Record<string, unknown> = {
    then(resolve: (value: Row[]) => unknown, reject?: (err: unknown) => unknown) {
      return Promise.resolve(rows).then(resolve, reject)
    },
  }
  for (const method of ['where', 'innerJoin', 'leftJoin', 'orderBy', 'limit']) {
    chain[method] = () => chain
  }
  return chain
}

function createDb(): Db {
  const serverMetadata = (ips: Row[]) => ({ resources: { ips } })
  const tables: Record<string, (fields: Record<string, unknown>) => Row[]> = {
    ip: (fields) =>
      'ipId' in fields
        ? [
            pinRow(A, LAN, '192.168.1.10'),
            pinRow(A, BACKHAUL, '10.9.0.10', { linkDown: { since: '2026-10-05T10:00:00.000Z' } }),
            pinRow(B, LAN, '192.168.1.11'),
            pinRow(B, BACKHAUL, '10.9.0.11'),
            pinRow(C, '00000000-0000-4000-8000-0000000000d9', '172.16.0.5'),
          ]
        : [],
    datacenter: (fields) =>
      'options' in fields
        ? [
            { id: LAN, options: { priority: 100 } },
            { id: BACKHAUL, options: { priority: 10 } },
          ]
        : [
            { id: LAN, name: 'Office LAN' },
            { id: BACKHAUL, name: 'Backhaul' },
          ],
    server: () => [
      {
        id: A,
        name: 'adrastea',
        metadata: serverMetadata([
          { address: '192.168.1.10', version: 4, scope: 'private', interface: 'eth0', link: 'up' },
          { address: '10.9.0.10', version: 4, scope: 'private', interface: 'eth1', link: 'down' },
        ]),
      },
      { id: B, name: 'kore', metadata: serverMetadata([]) },
    ],
  }
  return {
    select(fields: Record<string, unknown> = {}) {
      return {
        from(table: Parameters<typeof getTableName>[0]) {
          const rows = tables[getTableName(table)]?.(fields) ?? []
          return thenable(rows)
        },
      }
    },
  } as unknown as Db
}

test('loadServerTrafficMap lists peers that share a network, with the flagged backhaul demoted', async () => {
  const map = await loadServerTrafficMap(createDb(), {
    serverId: A,
    organizationId: 'org-1',
    candidates: [
      { serverId: A, name: 'adrastea' },
      { serverId: B, name: 'kore' },
      { serverId: C, name: 'elsewhere' },
    ],
  })
  assertEquals(
    map.peers.map((peer) => peer.name),
    ['kore']
  )
  const peer = map.peers[0]
  assertEquals(peer.chosenDatacenterId, LAN)
  assertEquals(
    peer.sharedNetworks.map((row) => [row.name, row.state, row.localLink]),
    [
      ['Office LAN', 'chosen', 'up'],
      ['Backhaul', 'link_down', 'down'],
    ]
  )
  assertEquals(peer.fabric, null)
  assertEquals(
    map.nics.map((nic) => [nic.name, nic.link, nic.metrics]),
    [
      ['eth0', 'up', null],
      ['eth1', 'down', null],
    ]
  )
})

test('loadServerTrafficMap filters to peers that share a network before it caps, in name order', async () => {
  const SERVERS = 170
  const pins: Row[] = [pinRow(A, LAN, '192.168.1.10')]
  const candidates = [{ serverId: A, name: 'adrastea' }]
  for (let n = 0; n < SERVERS; n++) {
    const id = `00000000-0000-4000-8000-${String(1000 + n).padStart(12, '0')}`
    // Every third server shares nothing with A and must not use up a slot.
    const shares = n % 3 !== 0
    pins.push(pinRow(id, shares ? LAN : BACKHAUL, `192.168.${n % 200}.${(n % 250) + 2}`))
    candidates.push({ serverId: id, name: `host-${String(SERVERS - n).padStart(3, '0')}` })
  }
  const db = {
    select(fields: Record<string, unknown> = {}) {
      return {
        from(table: Parameters<typeof getTableName>[0]) {
          const name = getTableName(table)
          if (name === 'ip' && 'ipId' in fields) return thenable(pins)
          return thenable([])
        },
      }
    },
  } as unknown as Db
  const map = await loadServerTrafficMap(db, { serverId: A, organizationId: 'org-1', candidates })
  const sharing = candidates.filter((_, index) => index > 0 && (index - 1) % 3 !== 0)
  assertEquals(sharing.length > 100, true)
  assertEquals(map.peers.length, 100)
  assertEquals(map.truncated, true)
  const expected = sharing
    .map((candidate) => candidate.name)
    .sort((a, b) => a.localeCompare(b))
    .slice(0, 100)
  assertEquals(
    map.peers.map((peer) => peer.name),
    expected
  )
})
