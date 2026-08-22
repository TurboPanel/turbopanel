/**
 * Host-free coverage for server label records (no Postgres).
 */

import { assertEquals } from '@std/assert'
import type { Db } from '../../db.ts'
import { DESCRIPTION_MAX_LENGTH } from '../display-name-format.ts'
import { label } from './schema.ts'
import {
  listServerLabels,
  parseServerLabelInput,
  setServerLabels,
} from './label-records.ts'

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
    orderBy: () => thenableRows(rows),
    returning: () => promise,
    then: promise.then.bind(promise),
    catch: promise.catch.bind(promise),
    finally: promise.finally.bind(promise),
  }
}

const serverId = '00000000-0000-4000-8000-00000000000a'

test('parseServerLabelInput accepts a labels map and trims keys', () => {
  const parsed = parseServerLabelInput({ labels: { ' env ': 'prod', region: 'us-east' } })
  if (parsed.ok !== true) throw new TypeError('expected parse to succeed')
  assertEquals(parsed.labels, [
    { key: 'env', value: 'prod' },
    { key: 'region', value: 'us-east' },
  ])
})

test('parseServerLabelInput rejects bad keys', () => {
  const parsed = parseServerLabelInput({ labels: { '-nope': 'x' } })
  if (parsed.ok !== false) throw new TypeError('expected parse to fail')
  assertEquals(parsed.error.includes('invalid'), true)
})

test('parseServerLabelInput rejects oversized values', () => {
  const parsed = parseServerLabelInput({
    labels: { env: 'x'.repeat(DESCRIPTION_MAX_LENGTH + 1) },
  })
  if (parsed.ok !== false) throw new TypeError('expected parse to fail')
  assertEquals(parsed.error.includes('exceeds'), true)
})

test('parseServerLabelInput accepts DESCRIPTION_MAX_LENGTH emoji code points', () => {
  const parsed = parseServerLabelInput({
    labels: { env: '😀'.repeat(DESCRIPTION_MAX_LENGTH) },
  })
  if (parsed.ok !== true) throw new TypeError('expected parse to succeed')
  assertEquals(parsed.labels, [
    { key: 'env', value: '😀'.repeat(DESCRIPTION_MAX_LENGTH) },
  ])
})

test('parseServerLabelInput rejects DESCRIPTION_MAX_LENGTH + 1 emoji code points', () => {
  const parsed = parseServerLabelInput({
    labels: { env: '😀'.repeat(DESCRIPTION_MAX_LENGTH + 1) },
  })
  if (parsed.ok !== false) throw new TypeError('expected parse to fail')
  assertEquals(parsed.error.includes('exceeds'), true)
})

test('parseServerLabelInput rejects too many labels', () => {
  const labels: Record<string, string> = {}
  for (let i = 0; i < 65; i++) {
    labels[`k${String(i)}`] = 'v'
  }
  const parsed = parseServerLabelInput({ labels })
  if (parsed.ok !== false) throw new TypeError('expected parse to fail')
  assertEquals(parsed.error.includes('at most 64'), true)
})

test('parseServerLabelInput rejects duplicate keys after trim', () => {
  const parsed = parseServerLabelInput({ 'env': 'a', ' env': 'b' })
  if (parsed.ok !== false) throw new TypeError('expected parse to fail')
  assertEquals(parsed.error.includes('Duplicate'), true)
})

test('parseServerLabelInput rejects non-string values', () => {
  const parsed = parseServerLabelInput({ labels: { env: 1 } })
  if (parsed.ok !== false) throw new TypeError('expected parse to fail')
  assertEquals(parsed.error.includes('string'), true)
})

function createLabelDb(opts?: {
  rows?: Array<{ id: string; createdAt: string; updatedAt: string; serverId: string; key: string; value: string }>
}): Db & {
  inserts: Array<Record<string, unknown>>
  conflictSets: Array<Record<string, unknown>>
  deletes: number
} {
  const inserts: Array<Record<string, unknown>> = []
  const conflictSets: Array<Record<string, unknown>> = []
  let deletes = 0
  const rows = [...(opts?.rows ?? [])]

  const db = {
    inserts,
    conflictSets,
    get deletes() {
      return deletes
    },
    select: () => ({
      from: (table: unknown) => {
        if (table !== label) return { where: () => thenableRows([]) }
        return {
          where: () => thenableRows(rows),
        }
      },
    }),
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        inserts.push(values)
        rows.push({
          id: `lbl-${String(inserts.length)}`,
          createdAt: '2020-01-01T00:00:00.000Z',
          updatedAt: String(values.updatedAt ?? '2020-01-01T00:00:00.000Z'),
          serverId: String(values.serverId),
          key: String(values.key),
          value: String(values.value),
        })
        return {
          onConflictDoUpdate: (conflict: { set: Record<string, unknown> }) => {
            conflictSets.push(conflict.set)
            return Promise.resolve()
          },
        }
      },
    }),
    delete: () => {
      deletes += 1
      return {
        where: () => thenableRows([]),
      }
    },
    transaction: async (fn: (tx: Db) => Promise<unknown>) => fn(db as unknown as Db),
  }

  return db as unknown as Db & {
    inserts: Array<Record<string, unknown>>
    conflictSets: Array<Record<string, unknown>>
    deletes: number
  }
}

test('setServerLabels upserts present keys and deletes removed ones', async () => {
  const db = createLabelDb({
    rows: [{
      id: 'old',
      createdAt: '2020-01-01T00:00:00.000Z',
      updatedAt: '2020-01-01T00:00:00.000Z',
      serverId,
      key: 'gone',
      value: 'x',
    }],
  })

  await setServerLabels(db, serverId, [
    { key: 'env', value: 'prod' },
    { key: 'region', value: 'us' },
  ])

  assertEquals(db.inserts.length, 2)
  assertEquals(db.conflictSets.length, 2)
  assertEquals(db.deletes, 1)
})

test('listServerLabels sorts via localeCompare', async () => {
  const db = createLabelDb({
    rows: [
      {
        id: '2',
        createdAt: '2020-01-01T00:00:00.000Z',
        updatedAt: '2020-01-01T00:00:00.000Z',
        serverId,
        key: 'zone',
        value: 'a',
      },
      {
        id: '1',
        createdAt: '2020-01-01T00:00:00.000Z',
        updatedAt: '2020-01-01T00:00:00.000Z',
        serverId,
        key: 'env',
        value: 'prod',
      },
    ],
  })

  const listed = await listServerLabels(db, serverId)
  assertEquals(listed.map((row) => row.key), ['env', 'zone'])
})
