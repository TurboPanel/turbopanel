/**
 * Host-free reencrypt sweep lock + empty-stage batch walks (no Postgres).
 */

import { assertEquals, assertRejects } from 'jsr:@std/assert'
import type { Db } from '../db.ts'
import {
  deriveEncryptionSecretsConfig,
  parseSecretsEnv,
  type DerivedSecretsConfig,
} from '../client/authn/secrets.ts'
import { TEST_ONLY_TURBOPANEL_SECRET } from '../test-fixtures/secrets.ts'
import {
  endReencryptSweep,
  REENCRYPT_BATCH_SIZE,
  reencryptAtRestSecrets,
  reencryptAtRestSecretsToCompletion,
  resetReencryptSweepLockForTests,
  tryBeginReencryptSweep,
} from './reencrypt-secrets.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

/** Batches use orderBy→limit; email uses where→limit only. */
function emptySweepDb(): Db {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: () => Promise.resolve([]),
          }),
          limit: () => Promise.resolve([]),
        }),
      }),
    }),
  } as unknown as Db
}

test('tryBeginReencryptSweep is exclusive until end', () => {
  resetReencryptSweepLockForTests()
  assertEquals(tryBeginReencryptSweep(), true)
  assertEquals(tryBeginReencryptSweep(), false)
  endReencryptSweep()
  assertEquals(tryBeginReencryptSweep(), true)
  endReencryptSweep()
})

test('reencryptAtRestSecrets walks empty stages to completed', async () => {
  resetReencryptSweepLockForTests()
  const result = await reencryptAtRestSecrets(
    emptySweepDb(),
    {} as DerivedSecretsConfig,
    { limit: 10 },
  )
  assertEquals(result.completed, true)
  assertEquals(result.cursor, null)
  assertEquals(result.scanned, 0)
  assertEquals(REENCRYPT_BATCH_SIZE >= 10, true)
})

test('reencryptAtRestSecrets rejects non-positive limits', async () => {
  await assertRejects(
    () =>
      reencryptAtRestSecrets(emptySweepDb(), {} as DerivedSecretsConfig, {
        limit: 0,
      }),
    TypeError,
    'reencrypt limit must be a positive integer',
  )
})

test('reencryptAtRestSecrets resume from tls across empty stages', async () => {
  resetReencryptSweepLockForTests()
  const mid = await reencryptAtRestSecrets(
    emptySweepDb(),
    {} as DerivedSecretsConfig,
    { cursor: { stage: 'tls' }, limit: 5 },
  )
  assertEquals(mid.completed, true)
  assertEquals(mid.cursor, null)

  const done = await reencryptAtRestSecretsToCompletion(
    emptySweepDb(),
    {} as DerivedSecretsConfig,
  )
  assertEquals(done.scanned, 0)
})

test('reencryptAtRestSecrets reseals plaintext variable blobs with secrets', async () => {
  resetReencryptSweepLockForTests()
  const config = parseSecretsEnv(TEST_ONLY_TURBOPANEL_SECRET, undefined, 'deno')
  const dataSecrets = await deriveEncryptionSecretsConfig(config, 'data-encryption')

  let variablePages = 0
  let updateCalls = 0
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: () => {
              variablePages += 1
              // First page of first stage only (variables).
              if (variablePages === 1) {
                return Promise.resolve([
                  { id: '00000000-0000-4000-8000-0000000000v1', value: 'plain-at-rest' },
                  {
                    id: '00000000-0000-4000-8000-0000000000v2',
                    value: 'enc.malformed-not-parseable',
                  },
                ])
              }
              return Promise.resolve([])
            },
          }),
          limit: () => Promise.resolve([]),
        }),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => ({
          returning: () => {
            updateCalls += 1
            return Promise.resolve([{ id: 'row' }])
          },
        }),
      }),
    }),
  } as unknown as Db

  const batch = await reencryptAtRestSecrets(db, dataSecrets, { limit: 50 })
  assertEquals(batch.scanned >= 2, true)
  assertEquals(batch.reencrypted >= 1, true)
  assertEquals(batch.failed >= 1, true)
  assertEquals(updateCalls >= 1, true)
  assertEquals(batch.completed, true)
})

test('reencryptAtRestSecrets normalizes bad cursors to variables', async () => {
  const result = await reencryptAtRestSecrets(
    emptySweepDb(),
    {} as DerivedSecretsConfig,
    { cursor: { stage: 'nope' as never }, limit: 1 },
  )
  assertEquals(result.completed, true)
})
