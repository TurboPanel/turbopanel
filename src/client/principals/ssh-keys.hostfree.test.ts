import { assertEquals, assertRejects } from '@std/assert'
import type { Db } from '../../db.ts'
import {
  addSshKey,
  countSshKeysByPrincipalIds,
  listSshKeys,
  loadSshKeysByPrincipalIds,
  MAX_SSH_KEYS_PER_PRINCIPAL,
  principalsWithFingerprint,
  removeSshKey,
  SSH_KEY_DUPLICATE_ERROR,
  SSH_KEY_LIMIT_ERROR,
  SshKeyRejected,
} from './ssh-keys.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const PRINCIPAL_ID = '550e8400-e29b-41d4-a716-446655440000'
const OTHER_ID = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'
const ORG_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
const ED25519 =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGEmvBcjT+NvO6sokGNoJ0zA3dr0nhIQhhZ3wP220uFZ'
const ED25519_FINGERPRINT = 'SHA256:HDSPSzosi+vPKLM3F8mb+5In9aGdwTMftxl3drl9WmU'

function fakeDb(resultSets: unknown[][]): Db {
  const queue = [...resultSets]
  const chain: unknown = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'then') {
          const promise = Promise.resolve(queue.shift() ?? [])
          return promise.then.bind(promise)
        }
        if (prop === 'catch' || prop === 'finally') return undefined
        return () => chain
      },
    },
  )
  return chain as Db
}

test('empty principal id lists seed empty maps without a query', async () => {
  const unused = {} as Db
  const keys = await loadSshKeysByPrincipalIds(unused, [])
  assertEquals([...keys.entries()], [])
  const counts = await countSshKeysByPrincipalIds(unused, [])
  assertEquals([...counts.entries()], [])
})

test('load and count group public keys by principal id', async () => {
  const db = fakeDb([
    [
      { principalId: PRINCIPAL_ID, publicKey: ED25519 },
      { principalId: PRINCIPAL_ID, publicKey: 'ssh-ed25519 second' },
    ],
  ])
  const keys = await loadSshKeysByPrincipalIds(db, [PRINCIPAL_ID, OTHER_ID])
  assertEquals(keys.get(PRINCIPAL_ID), [ED25519, 'ssh-ed25519 second'])
  assertEquals(keys.get(OTHER_ID), [])

  const counts = await countSshKeysByPrincipalIds(
    fakeDb([[{ principalId: PRINCIPAL_ID, publicKey: ED25519 }]]),
    [PRINCIPAL_ID, OTHER_ID],
  )
  assertEquals(counts.get(PRINCIPAL_ID), 1)
  assertEquals(counts.get(OTHER_ID), 0)
})

test('listSshKeys and principalsWithFingerprint read the fake chain', async () => {
  const listed = await listSshKeys(
    fakeDb([[{
      id: 'key-1',
      name: 'laptop',
      keyType: 'ssh-ed25519',
      publicKey: ED25519,
      fingerprint: ED25519_FINGERPRINT,
      comment: null,
      bits: null,
      createdAt: '2026-01-01T00:00:00.000Z',
    }]]),
    PRINCIPAL_ID,
  )
  assertEquals(listed[0]?.name, 'laptop')

  const owners = await principalsWithFingerprint(
    fakeDb([[{ principalId: PRINCIPAL_ID, username: 'deploy' }]]),
    ORG_ID,
    ED25519_FINGERPRINT,
  )
  assertEquals(owners, [{ principalId: PRINCIPAL_ID, username: 'deploy' }])
})

test('removeSshKey is true only when a row was deleted', async () => {
  assertEquals(await removeSshKey(fakeDb([[{ id: 'key-1' }]]), PRINCIPAL_ID, 'key-1'), true)
  assertEquals(await removeSshKey(fakeDb([[]]), PRINCIPAL_ID, 'missing'), false)
})

test('addSshKey rejects an empty or overlong name before parsing', async () => {
  const unused = {} as Db
  await assertRejects(
    () => addSshKey(unused, { principalId: PRINCIPAL_ID, name: '  ', publicKey: ED25519 }),
    SshKeyRejected,
    'name must be between 1 and 255 characters',
  )
  await assertRejects(
    () =>
      addSshKey(unused, {
        principalId: PRINCIPAL_ID,
        name: 'a'.repeat(256),
        publicKey: ED25519,
      }),
    SshKeyRejected,
    'name must be between 1 and 255 characters',
  )
})

test('addSshKey rejects an unparseable public key', async () => {
  await assertRejects(
    () =>
      addSshKey({} as Db, {
        principalId: PRINCIPAL_ID,
        name: 'laptop',
        publicKey: 'not-a-key',
      }),
    SshKeyRejected,
  )
})

test('addSshKey stores a parsed key and rejects duplicates or the cap', async () => {
  const inserted = {
    id: 'key-1',
    name: 'laptop',
    keyType: 'ssh-ed25519',
    publicKey: ED25519,
    fingerprint: ED25519_FINGERPRINT,
    comment: null,
    bits: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  }
  const db = {
    transaction: async (fn: (tx: Db) => Promise<typeof inserted>) =>
      await fn(fakeDb([[], [inserted]])),
  } as unknown as Db
  const row = await addSshKey(db, {
    principalId: PRINCIPAL_ID,
    name: ' laptop ',
    publicKey: ED25519,
    userId: 'user-1',
  })
  assertEquals(row.id, 'key-1')
  assertEquals(row.name, 'laptop')

  await assertRejects(
    () =>
      addSshKey({
        transaction: async (fn: (tx: Db) => Promise<typeof inserted>) =>
          await fn(fakeDb([[{ fingerprint: ED25519_FINGERPRINT }]])),
      } as unknown as Db, {
        principalId: PRINCIPAL_ID,
        name: 'laptop',
        publicKey: ED25519,
      }),
    SshKeyRejected,
    SSH_KEY_DUPLICATE_ERROR,
  )

  const atCap = Array.from({ length: MAX_SSH_KEYS_PER_PRINCIPAL }, (_, i) => ({
    fingerprint: `SHA256:other-${i}`,
  }))
  await assertRejects(
    () =>
      addSshKey({
        transaction: async (fn: (tx: Db) => Promise<typeof inserted>) =>
          await fn(fakeDb([atCap])),
      } as unknown as Db, {
        principalId: PRINCIPAL_ID,
        name: 'laptop',
        publicKey: ED25519,
      }),
    SshKeyRejected,
    SSH_KEY_LIMIT_ERROR,
  )
})
