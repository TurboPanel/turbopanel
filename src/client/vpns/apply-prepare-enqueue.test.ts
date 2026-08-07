import { assertEquals } from 'jsr:@std/assert'
import type { Db } from '../../db.ts'
import type { CommandQueue } from '../../lib/commands/queue.ts'
import { command } from '../../lib/db/schema.ts'
import {
  enqueuePreparedVpnApply,
  vpnPeersAllKeyed,
} from './apply-prepare.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const WG_PUBKEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='

type CommandRow = {
  id: string
  serverId: string
  actorType: string
  actorId: string
  name: string
  status: string
  attempts: number
  payload: unknown
  metadata: Record<string, unknown>
  result: unknown
  createdAt: string
  updatedAt: string
}

function createEnqueueDb(): {
  db: Db
  commandRows: CommandRow[]
  commandUpdates: Array<{ id: string; patch: Record<string, unknown> }>
} {
  const commandRows: CommandRow[] = []
  const commandUpdates: Array<{ id: string; patch: Record<string, unknown> }> = []

  const db = {
    update: (table: unknown) => ({
      set: (patch: Record<string, unknown>) => ({
        where: () => {
          const id = commandRows.at(-1)?.id ?? 'cmd-1'
          commandUpdates.push({ id, patch })
          const row = commandRows.find((entry) => entry.id === id)
          if (row) {
            Object.assign(row, patch)
            if (typeof patch.metadata === 'object' && patch.metadata !== null) {
              row.metadata = {
                ...row.metadata,
                ...(patch.metadata as Record<string, unknown>),
              }
            }
          }
          return {
            returning: () => Promise.resolve(row ? [row] : []),
          }
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: (row: Record<string, unknown>) => ({
        returning: () => {
          const created: CommandRow = {
            id: 'cmd-00000000-0000-4000-8000-000000000099',
            serverId: row.serverId as string,
            actorType: row.actorType as string,
            actorId: row.actorId as string,
            name: (row.name ?? row.type) as string,
            status: 'queued',
            attempts: 0,
            payload: row.payload,
            metadata: (row.metadata as Record<string, unknown>) ?? {},
            result: null,
            createdAt: '2024-01-01T00:00:00.000Z',
            updatedAt: '2024-01-01T00:00:00.000Z',
          }
          if (table === command) {
            commandRows.push(created)
          }
          return Promise.resolve([created])
        },
      }),
    }),
    select: () => ({
      from: () => ({
        where: async () => commandRows,
      }),
    }),
  } as unknown as Db

  return { db, commandRows, commandUpdates }
}

function recordingQueue(fail = false): CommandQueue {
  let enqueued = 0
  return {
    enqueue: async () => {
      enqueued += 1
      if (fail) throw new Error('Command queue unavailable')
    },
    get enqueueCount() {
      return enqueued
    },
  } as CommandQueue & { enqueueCount: number }
}

test('enqueuePreparedVpnApply queues one wireguard command per payload', async () => {
  const { db, commandRows } = createEnqueueDb()
  const queue = recordingQueue()

  const results = await enqueuePreparedVpnApply({
    db,
    commandQueue: queue,
    actorType: 'user',
    actorId: 'user-1',
    prepared: {
      interfaceName: 'tpwg550e8400',
      payloads: [
        {
          serverId: 'server-a',
          payload: {
            vpnId: 'vpn-1',
            peerId: 'peer-a',
            interfaceName: 'tpwg550e8400',
            address: '203.0.113.1/24',
            peers: [],
          },
        },
        {
          serverId: 'server-b',
          payload: {
            vpnId: 'vpn-1',
            peerId: 'peer-b',
            interfaceName: 'tpwg550e8400',
            address: '203.0.113.2/24',
            peers: [],
          },
        },
      ],
    },
  })

  assertEquals(results, [
    {
      peerId: 'peer-a',
      serverId: 'server-a',
      commandId: 'cmd-00000000-0000-4000-8000-000000000099',
      status: 'queued',
    },
    {
      peerId: 'peer-b',
      serverId: 'server-b',
      commandId: 'cmd-00000000-0000-4000-8000-000000000099',
      status: 'queued',
    },
  ])
  assertEquals(commandRows.length, 2)
  assertEquals((queue as CommandQueue & { enqueueCount: number }).enqueueCount, 2)
})

test('enqueuePreparedVpnApply marks queue failures without throwing', async () => {
  const { db, commandUpdates } = createEnqueueDb()
  const queue = recordingQueue(true)

  const results = await enqueuePreparedVpnApply({
    db,
    commandQueue: queue,
    actorType: 'user',
    actorId: 'user-1',
    prepared: {
      interfaceName: 'tpwg550e8400',
      payloads: [
        {
          serverId: 'server-a',
          payload: {
            vpnId: 'vpn-1',
            peerId: 'peer-a',
            interfaceName: 'tpwg550e8400',
            address: '203.0.113.1/24',
            peers: [],
          },
        },
      ],
    },
  })

  assertEquals(results, [
    {
      peerId: 'peer-a',
      serverId: 'server-a',
      status: 'failed',
      error: 'Command queue unavailable',
    },
  ])
  assertEquals(commandUpdates.length, 1)
  assertEquals(commandUpdates[0]?.patch.status, 'failed')
})

function createPeerKeyDb(publicKeys: Array<string | null>): Db {
  return {
    select: () => ({
      from: () => ({
        where: async () => publicKeys.map((publicKey) => ({ publicKey })),
      }),
    }),
  } as unknown as Db
}

test('vpnPeersAllKeyed is false for empty VPNs and invalid keys', async () => {
  assertEquals(await vpnPeersAllKeyed(createPeerKeyDb([]), 'vpn-1'), false)
  assertEquals(
    await vpnPeersAllKeyed(createPeerKeyDb([null, WG_PUBKEY]), 'vpn-1'),
    false,
  )
  assertEquals(
    await vpnPeersAllKeyed(createPeerKeyDb(['not-a-key']), 'vpn-1'),
    false,
  )
})

test('vpnPeersAllKeyed is true when every peer has a valid public key', async () => {
  assertEquals(
    await vpnPeersAllKeyed(createPeerKeyDb([WG_PUBKEY, WG_PUBKEY]), 'vpn-1'),
    true,
  )
})
