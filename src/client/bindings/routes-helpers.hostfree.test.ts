/**
 * Host-free coverage for binding collision helpers and pure parsers.
 */

import { assertEquals } from 'jsr:@std/assert'
import type { Db } from '../../db.ts'
import {
  assertNoBindingKeyConflicts,
  BINDING_KEY_CONFLICT_ERROR,
  findBindingKeyConflicts,
  isEngineDefaultsInUse,
  isKeyOwnedByBindingOnService,
  isPrefixInUse,
  parseBindingKeyPrefix,
  parseEmitEngineDefaults,
  resolveServiceIdForHosting,
} from './routes-helpers.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

function thenableRows(rows: unknown[]) {
  const promise = Promise.resolve(rows)
  return {
    limit: () => promise,
    then: promise.then.bind(promise),
    catch: promise.catch.bind(promise),
    finally: promise.finally.bind(promise),
  }
}

function selectQueueDb(responses: unknown[][]): Db {
  let i = 0
  return {
    select: () => ({
      from: () => ({
        where: () => {
          const rows = responses[i] ?? []
          i += 1
          return thenableRows(rows)
        },
      }),
    }),
  } as unknown as Db
}

test('parseBindingKeyPrefix rejects reserved and non-string values', () => {
  assertEquals(parseBindingKeyPrefix(12).ok, false)
  assertEquals(parseBindingKeyPrefix('TURBOPANEL').ok, false)
  assertEquals(parseBindingKeyPrefix('APP_DB'), { ok: true, prefix: 'APP_DB' })
})

test('parseEmitEngineDefaults validates booleans only', () => {
  assertEquals(parseEmitEngineDefaults(undefined), { ok: true, value: true })
  assertEquals(parseEmitEngineDefaults(false), { ok: true, value: false })
  assertEquals(parseEmitEngineDefaults('no').ok, false)
})

test('findBindingKeyConflicts returns null for empty key sets', async () => {
  assertEquals(
    await findBindingKeyConflicts(selectQueueDb([]), {
      serviceId: 'svc',
      keys: [],
    }),
    null,
  )
})

test('findBindingKeyConflicts reports service-scoped user variable first', async () => {
  const conflict = await findBindingKeyConflicts(
    selectQueueDb([[{ key: 'DATABASE_URL' }]]),
    { serviceId: 'svc', keys: ['DATABASE_URL'] },
  )
  assertEquals(conflict, 'DATABASE_URL')
})

test('findBindingKeyConflicts checks hosting-scoped keys when service is clean', async () => {
  const conflict = await findBindingKeyConflicts(
    selectQueueDb([
      [], // service miss
      [{ id: 'h1' }, { id: 'h2' }], // hostings
      [{ key: 'DATABASE_PASSWORD' }], // hosting hit
    ]),
    { serviceId: 'svc', keys: ['DATABASE_PASSWORD'] },
  )
  assertEquals(conflict, 'DATABASE_PASSWORD')
})

test('findBindingKeyConflicts returns null when hostings absent', async () => {
  assertEquals(
    await findBindingKeyConflicts(
      selectQueueDb([[], []]),
      { serviceId: 'svc', keys: ['DATABASE_URL'] },
    ),
    null,
  )
})

test('assertNoBindingKeyConflicts maps emitted key collisions', async () => {
  const ok = await assertNoBindingKeyConflicts(selectQueueDb([[]]), {
    serviceId: 'svc',
    keyPrefix: 'DATABASE',
    emitEngineDefaults: false,
    engineCode: 'postgres',
  })
  assertEquals(ok, { ok: true })

  const bad = await assertNoBindingKeyConflicts(
    selectQueueDb([[{ key: 'DATABASE_URL' }]]),
    {
      serviceId: 'svc',
      keyPrefix: 'DATABASE',
      emitEngineDefaults: false,
      engineCode: 'postgres',
    },
  )
  assertEquals(bad, { ok: false, key: 'DATABASE_URL' })
  assertEquals(BINDING_KEY_CONFLICT_ERROR, 'binding_key_conflict')
})

test('isPrefixInUse / isEngineDefaultsInUse / isKeyOwnedByBindingOnService', async () => {
  assertEquals(
    await isPrefixInUse(selectQueueDb([[{ id: 'b1' }]]), 'svc', 'DB'),
    true,
  )
  assertEquals(
    await isPrefixInUse(selectQueueDb([[]]), 'svc', 'DB', 'exclude'),
    false,
  )
  assertEquals(
    await isEngineDefaultsInUse(selectQueueDb([[{ id: 'b1' }]]), 'svc'),
    true,
  )
  assertEquals(
    await isEngineDefaultsInUse(selectQueueDb([[]]), 'svc', 'exclude'),
    false,
  )
  assertEquals(
    await isKeyOwnedByBindingOnService(
      selectQueueDb([[{ id: 'v1' }]]),
      'svc',
      'DATABASE_URL',
    ),
    true,
  )
  assertEquals(
    await isKeyOwnedByBindingOnService(selectQueueDb([[]]), 'svc', 'X'),
    false,
  )
})

test('resolveServiceIdForHosting returns null when missing', async () => {
  assertEquals(
    await resolveServiceIdForHosting(selectQueueDb([[]]), 'hosting'),
    null,
  )
  assertEquals(
    await resolveServiceIdForHosting(
      selectQueueDb([[{ serviceId: 'svc-1' }]]),
      'hosting',
    ),
    'svc-1',
  )
})
