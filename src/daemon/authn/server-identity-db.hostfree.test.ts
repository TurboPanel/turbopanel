/**
 * Host-free coverage for server daemon identity DB helpers (no Postgres).
 */

import { assertEquals, assertRejects } from '@std/assert'
import type { Db } from '../../db.ts'
import type { ServerDaemonState } from './daemon-state.ts'
import {
  attachDaemonStateToServer,
  clearServerDaemonState,
  getServerDaemonStateByFingerprint,
  getServerDaemonStateByServerId,
  revokeDaemonKey,
  touchDaemonKeyLastUsed,
} from './server-identity-db.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const SERVER_ID = '00000000-0000-4000-8000-0000000000b1'

const activeState: ServerDaemonState = {
  key: {
    id: 'key-1',
    algorithm: 'Ed25519',
    publicJwk: { kty: 'OKP', crv: 'Ed25519', x: 'abc' },
    fingerprint: 'fp-test',
    createdAt: '2020-01-01T00:00:00.000Z',
    revokedAt: null,
  },
}

function queryResult<T>(rows: T[]) {
  const promise = Promise.resolve(rows)
  return Object.assign(promise, {
    limit: (_n: number) => Promise.resolve(rows),
  })
}

type IdentityFake = {
  db: Db
  getDaemon: () => ServerDaemonState | null
  getUpdates: () => Array<Record<string, unknown>>
}

function createIdentityFakeDb(
  initial: ServerDaemonState | null = activeState,
): IdentityFake {
  let daemon: ServerDaemonState | null = initial
    ? structuredClone(initial)
    : null
  let connected = false
  let statusChangedAt: string | null = null
  const updates: Array<Record<string, unknown>> = []

  const db = {
    select: () => ({
      from: () => ({
        where: () =>
          queryResult(
            daemon
              ? [{
                serverId: SERVER_ID,
                daemon,
                metadata: null,
                hostname: 'host-1',
                machineKey: null,
                connected,
                statusChangedAt,
              }]
              : [],
          ),
      }),
    }),
    update: () => ({
      set: (patch: Record<string, unknown>) => {
        updates.push(patch)
        if ('daemon' in patch) {
          daemon = patch.daemon as ServerDaemonState | null
        }
        if ('isConnected' in patch) {
          connected = Boolean(patch.isConnected)
        }
        if ('statusChangedAt' in patch) {
          statusChangedAt = patch.statusChangedAt as string | null
        }
        return {
          where: () => ({
            returning: () =>
              Promise.resolve(daemon ? [{ id: SERVER_ID }] : []),
          }),
        }
      },
    }),
  } as unknown as Db

  return {
    db,
    getDaemon: () => daemon,
    getUpdates: () => updates,
  }
}

test('getServerDaemonStateByServerId returns null when missing or unparsable', async () => {
  const empty = createIdentityFakeDb(null)
  assertEquals(await getServerDaemonStateByServerId(empty.db, SERVER_ID), null)

  const broken = {
    select: () => ({
      from: () => ({
        where: () =>
          queryResult([{
            daemon: { not: 'a-key' },
            metadata: null,
            hostname: null,
            machineKey: null,
            connected: false,
            statusChangedAt: null,
          }]),
      }),
    }),
  } as unknown as Db
  assertEquals(await getServerDaemonStateByServerId(broken, SERVER_ID), null)
})

test('getServerDaemonStateByServerId maps status columns and identity', async () => {
  const fake = createIdentityFakeDb(activeState)
  const row = await getServerDaemonStateByServerId(fake.db, SERVER_ID)
  if (!row) throw new TypeError('expected daemon state')
  assertEquals(row.key.fingerprint, 'fp-test')
  assertEquals(row.hostname, 'host-1')
  assertEquals(row.status.connected, false)
})

test('getServerDaemonStateByFingerprint returns serverId when present', async () => {
  const fake = createIdentityFakeDb(activeState)
  const row = await getServerDaemonStateByFingerprint(fake.db, 'fp-test')
  if (!row) throw new TypeError('expected fingerprint hit')
  assertEquals(row.serverId, SERVER_ID)
  assertEquals(row.key.id, 'key-1')
})

test('attachDaemonStateToServer writes daemon + default status columns', async () => {
  const fake = createIdentityFakeDb(null)
  // Attach requires returning a row — seed an empty server via returning path.
  const db = {
    select: fake.db.select,
    update: () => ({
      set: (patch: Record<string, unknown>) => {
        fake.getUpdates().push(patch)
        return {
          where: () => ({
            returning: () => Promise.resolve([{ id: SERVER_ID }]),
          }),
        }
      },
    }),
  } as unknown as Db

  const result = await attachDaemonStateToServer(db, SERVER_ID, {
    publicJwk: { kty: 'OKP', crv: 'Ed25519', x: 'xyz' },
    fingerprint: 'fp-new',
    hostname: 'edge-1',
    machineKey: 'a'.repeat(64),
  })
  assertEquals(typeof result.keyId, 'string')
  assertEquals(fake.getUpdates().length, 1)
  const patch = fake.getUpdates()[0]!
  assertEquals(typeof patch.daemon, 'object')
  assertEquals(patch.hostname, 'edge-1')
  assertEquals(patch.isConnected, false)
})

test('attachDaemonStateToServer throws when the server row is missing', async () => {
  const db = {
    update: () => ({
      set: () => ({
        where: () => ({
          returning: () => Promise.resolve([]),
        }),
      }),
    }),
  } as unknown as Db
  await assertRejects(
    () =>
      attachDaemonStateToServer(db, SERVER_ID, {
        publicJwk: { kty: 'OKP', crv: 'Ed25519', x: 'abc' },
        fingerprint: 'fp',
      }),
    Error,
    'server row missing for enroll attach',
  )
})

test('touchDaemonKeyLastUsed and revokeDaemonKey update key timestamps', async () => {
  const fake = createIdentityFakeDb(activeState)
  await touchDaemonKeyLastUsed(fake.db, SERVER_ID, '2020-02-01T00:00:00.000Z')
  assertEquals(
    fake.getDaemon()?.key.lastUsedAt,
    '2020-02-01T00:00:00.000Z',
  )

  await revokeDaemonKey(fake.db, SERVER_ID)
  assertEquals(typeof fake.getDaemon()?.key.revokedAt, 'string')
})

test('touchDaemonKeyLastUsed is a no-op when the server has no daemon state', async () => {
  const fake = createIdentityFakeDb(null)
  await touchDaemonKeyLastUsed(fake.db, SERVER_ID)
  assertEquals(fake.getUpdates().length, 0)
})

test('clearServerDaemonState nulls daemon and resets status columns', async () => {
  const fake = createIdentityFakeDb(activeState)
  await clearServerDaemonState(fake.db, SERVER_ID)
  assertEquals(fake.getDaemon(), null)
  const patch = fake.getUpdates().at(-1)
  assertEquals(patch?.daemon, null)
  assertEquals(patch?.isConnected, false)
})
