import { assert, assertEquals } from '@std/assert'
import type { Db } from '../../db/connection.ts'
import { COMMAND_RETENTION_DAYS, pruneCommandHistory } from './prune.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

function sqlText(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (!value || typeof value !== 'object') return ''
  if ('queryChunks' in value && Array.isArray(value.queryChunks)) {
    return value.queryChunks.map(sqlText).join('')
  }
  if ('value' in value) {
    const inner = value.value
    if (typeof inner === 'string' || typeof inner === 'number') return String(inner)
    if (Array.isArray(inner) && inner.every((part) => typeof part === 'string')) {
      return inner.join('')
    }
  }
  return ''
}

function fakeDb(rows: unknown[]) {
  const statements: string[] = []
  const db = {
    delete() {
      return {
        where(condition: unknown) {
          statements.push(sqlText(condition))
          return { returning: () => Promise.resolve(rows) }
        },
      }
    },
  }
  return { db: db as unknown as Db, statements }
}

test('pruneCommandHistory deletes one capped batch and returns the count', async () => {
  const { db, statements } = fakeDb([{ id: 'a' }, { id: 'b' }])
  const deleted = await pruneCommandHistory(db, { now: '2026-10-04T00:00:00.000Z', limit: 10 })
  assertEquals(deleted, 2)
  assertEquals(statements.length, 1)
  assert(statements[0]!.includes('limit 10'))
})

test('the prune only ever targets terminal, unreferenced, non-latest, non-deploy rows', async () => {
  const { db, statements } = fakeDb([])
  await pruneCommandHistory(db, { now: '2026-10-04T00:00:00.000Z' })
  const text = statements[0]!
  assert(text.includes("c.status in ('succeeded', 'failed', 'timed_out', 'cancelled')"))
  for (const active of ['queued', 'dispatching', 'sent', 'acked', 'running']) {
    assertEquals(text.includes(`'${active}'`), false, `${active} must never be pruned`)
  }
  assert(text.includes("c.name <> 'environment.deploy'"))
  assert(text.includes('c.managed_destroy_gate_id is null'))
  assert(text.includes('from dispatch d where d.command_id = c.id'))
  assert(text.includes('select last_command_id from deployment'))
  assert(text.includes('newer.created_at > c.created_at'))
})

test('the retention window cannot be configured below 30 days and defaults to 180', async () => {
  const now = '2026-10-04T00:00:00.000Z'
  const cutoffOf = (days: number) => new Date(Date.parse(now) - days * 86_400_000).toISOString()
  assertEquals(COMMAND_RETENTION_DAYS, 180)

  const short = fakeDb([])
  await pruneCommandHistory(short.db, { now, retentionDays: 1 })
  assert(short.statements[0]!.includes(cutoffOf(30)))

  const dflt = fakeDb([])
  await pruneCommandHistory(dflt.db, { now })
  assert(dflt.statements[0]!.includes(cutoffOf(180)))
})
