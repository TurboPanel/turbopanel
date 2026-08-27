/**
 * Host-free coverage for organization tag / marker records (no Postgres).
 */

import { assertEquals, assertRejects } from '@std/assert'
import type { Db } from '../../db.ts'
import { marker, tag } from './schema.ts'
import {
  createTag,
  isTagUniqueViolation,
  listOrganizationTags,
  listTagsForEntity,
  parseTagNameInput,
  setEntityTags,
  TAGGABLE_PARENTS,
  updateTag,
} from './tag-records.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

type ConflictConfig = {
  target?: unknown
  where?: unknown
}

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

function flattenSql(value: unknown): string {
  const parts: string[] = []
  const visit = (node: unknown): void => {
    if (typeof node === 'string') {
      parts.push(node)
      return
    }
    if (!node || typeof node !== 'object') return
    const obj = node as Record<string, unknown>
    if (typeof obj.name === 'string' && typeof obj.columnType === 'string') {
      parts.push(obj.name)
    }
    if (typeof obj.value === 'string') {
      parts.push(obj.value)
    } else if (Array.isArray(obj.value)) {
      for (const item of obj.value) visit(item)
    }
    if (Array.isArray(obj.queryChunks)) {
      for (const chunk of obj.queryChunks) visit(chunk)
    }
  }
  visit(value)
  return parts.join('')
}

const organizationId = '00000000-0000-4000-8000-000000000001'
const entityId = '00000000-0000-4000-8000-00000000000a'
const tagA = '11111111-1111-4111-8111-111111111111'
const tagB = '22222222-2222-4222-8222-222222222222'

function tagRow(opts: { id: string; name: string }) {
  return {
    id: opts.id,
    organizationId,
    name: opts.name,
    description: null,
    color: null,
    createdAt: '2020-01-01T00:00:00.000Z',
    updatedAt: '2020-01-01T00:00:00.000Z',
    metadata: null,
    options: null,
  }
}

function createTagDb(opts?: {
  tagRows?: ReturnType<typeof tagRow>[]
}): Db & {
  inserts: Array<Record<string, unknown>>
  updates: Array<Record<string, unknown>>
  conflictConfigs: ConflictConfig[]
  conflictNothings: number
  deletes: number
} {
  const inserts: Array<Record<string, unknown>> = []
  const updates: Array<Record<string, unknown>> = []
  const conflictConfigs: ConflictConfig[] = []
  let conflictNothings = 0
  let deletes = 0
  const tagRows = [...(opts?.tagRows ?? [])]

  const db = {
    inserts,
    updates,
    conflictConfigs,
    get conflictNothings() {
      return conflictNothings
    },
    get deletes() {
      return deletes
    },
    select: () => ({
      from: (table: unknown) => ({
        where: () => thenableRows(table === tag ? tagRows : []),
        innerJoin: () => ({
          where: () => thenableRows(tagRows),
        }),
      }),
    }),
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        inserts.push(values)
        return {
          onConflictDoNothing: (config?: ConflictConfig) => {
            conflictNothings += 1
            if (config) conflictConfigs.push(config)
            return Promise.resolve()
          },
          returning: () => thenableRows([{ id: `tag-${String(inserts.length)}` }]),
        }
      },
    }),
    update: () => ({
      set: (fields: Record<string, unknown>) => {
        updates.push(fields)
        return {
          where: () => Promise.resolve(),
        }
      },
    }),
    delete: () => {
      deletes += 1
      return {
        where: () => thenableRows([]),
      }
    },
    transaction: (fn: (tx: Db) => Promise<unknown>) => fn(db as unknown as Db),
  }

  return db as unknown as Db & {
    inserts: Array<Record<string, unknown>>
    updates: Array<Record<string, unknown>>
    conflictConfigs: ConflictConfig[]
    conflictNothings: number
    deletes: number
  }
}

test('setEntityTags inserts requested markers and deletes removed ones', async () => {
  const db = createTagDb()
  await setEntityTags(db, 'projectId', entityId, [tagA, tagB])

  assertEquals(db.inserts.length, 2)
  assertEquals(db.inserts[0]?.tagId, tagA)
  assertEquals(db.inserts[0]?.projectId, entityId)
  assertEquals(db.inserts[1]?.tagId, tagB)
  assertEquals(db.conflictNothings, 2)
  assertEquals(db.deletes, 1)
})

test('setEntityTags empty list deletes all markers', async () => {
  const db = createTagDb()
  await setEntityTags(db, 'projectId', entityId, [])

  assertEquals(db.inserts.length, 0)
  assertEquals(db.conflictNothings, 0)
  assertEquals(db.deletes, 1)
})

test('setEntityTags conflict handling matches partial unique indexes', async () => {
  for (const { column } of TAGGABLE_PARENTS) {
    const db = createTagDb()
    await setEntityTags(db, column, entityId, [tagA])

    assertEquals(db.conflictConfigs.length, 1)
    const config = db.conflictConfigs[0]
    if (!config) {
      throw new TypeError(`missing conflict config for ${column}`)
    }
    assertEquals(config.target, [marker.tagId, marker[column]])
    const predicate = flattenSql(config.where)
    assertEquals(predicate.includes(marker[column].name), true, column)
    assertEquals(predicate.includes('IS NOT NULL'), true, column)
  }
})

test('listOrganizationTags sorts via localeCompare', async () => {
  const db = createTagDb({
    tagRows: [tagRow({ id: '2', name: 'zeta' }), tagRow({ id: '1', name: 'alpha' })],
  })
  const records = await listOrganizationTags(db, organizationId)
  assertEquals(records.map((row) => row.name), ['alpha', 'zeta'])
})

test('listTagsForEntity sorts via localeCompare', async () => {
  const db = createTagDb({
    tagRows: [tagRow({ id: '2', name: 'prod' }), tagRow({ id: '1', name: 'dev' })],
  })
  const records = await listTagsForEntity(db, 'projectId', entityId)
  assertEquals(records.map((row) => row.name), ['dev', 'prod'])
})

test('isTagUniqueViolation matches only 23505 naming uniq_tag_organization_name', () => {
  const named = Object.assign(new Error('duplicate key value violates unique constraint "uniq_tag_organization_name"'), {
    code: '23505',
  })
  assertEquals(isTagUniqueViolation(named), true)

  const otherUnique = Object.assign(new Error('duplicate key value violates unique constraint "uniq_marker_project"'), {
    code: '23505',
  })
  assertEquals(isTagUniqueViolation(otherUnique), false)

  assertEquals(isTagUniqueViolation({ code: '23503', message: 'uniq_tag_organization_name' }), false)
  assertEquals(isTagUniqueViolation(null), false)
})

test('parseTagNameInput trims names', () => {
  assertEquals(parseTagNameInput('  prod  '), { ok: true, name: 'prod' })
})

test('parseTagNameInput rejects blank and control-character names', () => {
  assertEquals(parseTagNameInput(''), { ok: false, error: 'Invalid request' })
  assertEquals(parseTagNameInput('   '), { ok: false, error: 'Invalid request' })
  assertEquals(parseTagNameInput('a\nb'), { ok: false, error: 'Invalid request' })
  assertEquals(parseTagNameInput(1), { ok: false, error: 'Invalid request' })
})

test('createTag stores a normalized name', async () => {
  const db = createTagDb()
  await createTag(db, {
    organizationId,
    name: '  prod  ',
    description: null,
    color: null,
  })
  assertEquals(db.inserts[0]?.name, 'prod')
})

test('createTag rejects invalid names', async () => {
  const db = createTagDb()
  await assertRejects(
    () =>
      createTag(db, {
        organizationId,
        name: '   ',
        description: null,
        color: null,
      }),
    TypeError,
    'Invalid request',
  )
  await assertRejects(
    () =>
      createTag(db, {
        organizationId,
        name: 'a\nb',
        description: null,
        color: null,
      }),
    TypeError,
    'Invalid request',
  )
})

test('updateTag stores a normalized rename', async () => {
  const db = createTagDb()
  await updateTag(db, tagA, {
    name: '  staging  ',
    updatedAt: '2020-01-01T00:00:00.000Z',
  })
  assertEquals(db.updates.length, 1)
  assertEquals(db.updates[0]?.name, 'staging')
})

test('updateTag rejects invalid rename names', async () => {
  const db = createTagDb()
  await assertRejects(
    () =>
      updateTag(db, tagA, {
        name: 'a\nb',
        updatedAt: '2020-01-01T00:00:00.000Z',
      }),
    TypeError,
    'Invalid request',
  )
})
