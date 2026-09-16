/**
 * Host-free coverage for server daemon identity DB helpers (no Postgres).
 *
 * The daemon key lives in the `key` table now (schema-child-tables,
 * Road-to-0.1.x) — `getServerDaemonStateByServerId` / `ByFingerprint` join
 * `server` and `key`; `attachDaemonStateToServer` upserts the key row and
 * the server row inside one transaction; `touchDaemonKeyLastUsed` /
 * `revokeDaemonKey` are targeted single-column writes on `key`;
 * `clearServerDaemonState` deletes the `key` row explicitly.
 */

import { assertEquals, assertRejects } from '@std/assert'
import type { Db } from '../../db.ts'
import type { ServerDaemonKey } from './daemon-state.ts'
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

const activeKey: ServerDaemonKey = {
  id: 'key-1',
  algorithm: 'Ed25519',
  publicJwk: { kty: 'OKP', crv: 'Ed25519', x: 'abc' },
  fingerprint: 'fp-test',
  createdAt: '2020-01-01T00:00:00.000Z',
  revokedAt: null,
  lastUsedAt: null,
}

function limitResult<T>(rows: T[]) {
  return { limit: () => Promise.resolve(rows) }
}

type ServerRow = {
  daemon: { projection?: Record<string, unknown> } | null
  hostname: string | null
  machineKey: string | null
  connected: boolean
  statusChangedAt: string | null
}

type IdentityFake = {
  db: Db
  getKey: () => ServerDaemonKey | null
  getServerRow: () => ServerRow
  getUpdates: () => Array<Record<string, unknown>>
  getDeletes: () => number
}

/** `null` simulates a server with no key row (not enrolled). */
function createIdentityFakeDb(
  initialKey: ServerDaemonKey | null = activeKey,
): IdentityFake {
  let key: ServerDaemonKey | null = initialKey
    ? structuredClone(initialKey)
    : null
  const serverRow: ServerRow = {
    daemon: null,
    hostname: 'host-1',
    machineKey: null,
    connected: false,
    statusChangedAt: null,
  }
  const updates: Array<Record<string, unknown>> = []
  let deletes = 0

  function joinedRow() {
    if (!key) return []
    return [{
      id: key.id,
      algorithm: key.algorithm,
      publicJwk: key.publicJwk,
      fingerprint: key.fingerprint,
      createdAt: key.createdAt,
      revokedAt: key.revokedAt ?? null,
      lastUsedAt: key.lastUsedAt ?? null,
      serverId: SERVER_ID,
      ...serverRow,
    }]
  }

  const db = {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: () => limitResult(joinedRow()),
        }),
      }),
    }),
    insert: () => ({
      values: (values: Record<string, unknown>) => ({
        onConflictDoUpdate: (opts: { set: Record<string, unknown> }) => ({
          returning: () => {
            // The real `set.id` is a `sql\`uuidv7()\`` fragment, always
            // present — re-enrollment always mints a new id, never an edit
            // of the old row.
            const createdAt = typeof opts.set.createdAt === 'string'
              ? opts.set.createdAt
              : key?.createdAt ?? '2020-01-01T00:00:00.000Z'
            key = {
              id: `key-${crypto.randomUUID()}`,
              algorithm: (opts.set.algorithm ?? values.algorithm) as 'Ed25519',
              publicJwk: (opts.set.publicJwk ?? values.publicJwk) as JsonWebKey,
              fingerprint: (opts.set.fingerprint ?? values.fingerprint) as string,
              createdAt,
              revokedAt: (opts.set.revokedAt as string | null | undefined) ?? null,
              lastUsedAt: (opts.set.lastUsedAt as string | null | undefined) ?? null,
            }
            return Promise.resolve([{ id: key.id }])
          },
        }),
      }),
    }),
    update: () => ({
      set: (patch: Record<string, unknown>) => {
        updates.push(patch)
        if ('lastUsedAt' in patch || 'revokedAt' in patch) {
          // A `key` table patch — touchDaemonKeyLastUsed / revokeDaemonKey.
          if (key) {
            if ('lastUsedAt' in patch) key.lastUsedAt = patch.lastUsedAt as string | null
            if ('revokedAt' in patch) key.revokedAt = patch.revokedAt as string | null
          }
          return { where: () => Promise.resolve(undefined) }
        }
        // A `server` table patch — attach / clear.
        if ('daemon' in patch) serverRow.daemon = patch.daemon as ServerRow['daemon']
        if ('hostname' in patch) serverRow.hostname = patch.hostname as string | null
        if ('machineKey' in patch) serverRow.machineKey = patch.machineKey as string | null
        if ('isConnected' in patch) serverRow.connected = Boolean(patch.isConnected)
        if ('statusChangedAt' in patch) {
          serverRow.statusChangedAt = patch.statusChangedAt as string | null
        }
        return {
          where: () => ({
            returning: () => Promise.resolve([{ id: SERVER_ID }]),
          }),
        }
      },
    }),
    delete: () => ({
      where: () => {
        deletes += 1
        key = null
        return Promise.resolve(undefined)
      },
    }),
    transaction: (fn: (tx: Db) => Promise<unknown>) => fn(db as unknown as Db),
  } as unknown as Db

  return {
    db,
    getKey: () => key,
    getServerRow: () => serverRow,
    getUpdates: () => updates,
    getDeletes: () => deletes,
  }
}

test('getServerDaemonStateByServerId returns null when there is no key row', async () => {
  const empty = createIdentityFakeDb(null)
  assertEquals(await getServerDaemonStateByServerId(empty.db, SERVER_ID), null)
})

test('getServerDaemonStateByServerId returns null for a malformed key row', async () => {
  const broken = createIdentityFakeDb({ ...activeKey, algorithm: 'RSA' as 'Ed25519' })
  assertEquals(await getServerDaemonStateByServerId(broken.db, SERVER_ID), null)
})

test('getServerDaemonStateByServerId maps status columns and identity', async () => {
  const fake = createIdentityFakeDb(activeKey)
  const row = await getServerDaemonStateByServerId(fake.db, SERVER_ID)
  if (!row) throw new TypeError('expected daemon state')
  assertEquals(row.key.fingerprint, 'fp-test')
  assertEquals(row.hostname, 'host-1')
  assertEquals(row.status.connected, false)
})

test('getServerDaemonStateByFingerprint returns serverId when present', async () => {
  const fake = createIdentityFakeDb(activeKey)
  const row = await getServerDaemonStateByFingerprint(fake.db, 'fp-test')
  if (!row) throw new TypeError('expected fingerprint hit')
  assertEquals(row.serverId, SERVER_ID)
  assertEquals(row.key.id, 'key-1')
})

test('getServerDaemonStateByFingerprint returns null with no matching key row', async () => {
  const empty = createIdentityFakeDb(null)
  assertEquals(await getServerDaemonStateByFingerprint(empty.db, 'fp-test'), null)
})

test('attachDaemonStateToServer inserts the key row and writes default status columns', async () => {
  const fake = createIdentityFakeDb(null)
  const result = await attachDaemonStateToServer(fake.db, SERVER_ID, {
    publicJwk: { kty: 'OKP', crv: 'Ed25519', x: 'xyz' },
    fingerprint: 'fp-new',
    hostname: 'edge-1',
    machineKey: 'a'.repeat(64),
  })
  assertEquals(typeof result.keyId, 'string')
  assertEquals(fake.getKey()?.fingerprint, 'fp-new')
  assertEquals(fake.getKey()?.revokedAt, null)
  assertEquals(fake.getServerRow().hostname, 'edge-1')
  assertEquals(fake.getServerRow().connected, false)
  // Re-enrollment always clears projection too — a full replace, not a merge.
  assertEquals(fake.getServerRow().daemon, null)
})

test('attachDaemonStateToServer mints a new key id and clears revocation on re-enroll', async () => {
  const fake = createIdentityFakeDb({
    ...activeKey,
    revokedAt: '2020-06-01T00:00:00.000Z',
  })
  const originalId = fake.getKey()?.id
  const result = await attachDaemonStateToServer(fake.db, SERVER_ID, {
    publicJwk: { kty: 'OKP', crv: 'Ed25519', x: 'new' },
    fingerprint: 'fp-replaced',
  })
  // A re-enroll is a new key, not an edit of the old row.
  assertEquals(result.keyId !== originalId, true)
  assertEquals(fake.getKey()?.fingerprint, 'fp-replaced')
  assertEquals(fake.getKey()?.revokedAt, null)
})

test('attachDaemonStateToServer throws when the server row is missing', async () => {
  const db = {
    insert: () => ({
      values: () => ({
        onConflictDoUpdate: () => ({
          returning: () => Promise.resolve([{ id: 'key-1' }]),
        }),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => ({
          returning: () => Promise.resolve([]),
        }),
      }),
    }),
    transaction: (fn: (tx: Db) => Promise<unknown>) => fn(db as unknown as Db),
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

test('touchDaemonKeyLastUsed and revokeDaemonKey are targeted single-column writes', async () => {
  const fake = createIdentityFakeDb(activeKey)
  await touchDaemonKeyLastUsed(fake.db, SERVER_ID, '2020-02-01T00:00:00.000Z')
  assertEquals(fake.getKey()?.lastUsedAt, '2020-02-01T00:00:00.000Z')

  await revokeDaemonKey(fake.db, SERVER_ID)
  assertEquals(typeof fake.getKey()?.revokedAt, 'string')

  // Neither write ever touches server-shaped patch fields.
  for (const patch of fake.getUpdates()) {
    assertEquals('daemon' in patch, false)
  }
})

test('clearServerDaemonState deletes the key row and resets server status columns', async () => {
  const fake = createIdentityFakeDb(activeKey)
  await clearServerDaemonState(fake.db, SERVER_ID)
  assertEquals(fake.getDeletes(), 1)
  assertEquals(fake.getKey(), null)
  assertEquals(fake.getServerRow().daemon, null)
  assertEquals(fake.getServerRow().connected, false)
})
