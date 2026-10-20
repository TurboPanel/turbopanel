import { assert, assertEquals, assertRejects } from '@std/assert'
import type { Db } from '../../db/connection.ts'
import {
  AUDIT_PRUNE_BATCH_LIMIT,
  AUDIT_RETENTION_MONTHS_DEFAULT,
  auditBoundaryId,
  auditCutoff,
  pruneAuditHistory,
} from './prune.ts'

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

const NOW = '2026-10-19T12:00:00.000Z'

test('the default window is 13 months and a batch is 1000 rows', () => {
  assertEquals(AUDIT_RETENTION_MONTHS_DEFAULT, 13)
  assertEquals(AUDIT_PRUNE_BATCH_LIMIT, 1000)
})

test('the cutoff is whole months before now', () => {
  assertEquals(auditCutoff(NOW, 13).toISOString(), '2025-09-19T12:00:00.000Z')
  assertEquals(auditCutoff(NOW, 3).toISOString(), '2026-07-19T12:00:00.000Z')
  assertEquals(auditCutoff(NOW, 12).toISOString(), '2025-10-19T12:00:00.000Z')
})

test('the boundary id is the smallest uuidv7 of that millisecond', () => {
  assertEquals(auditBoundaryId(0), '00000000-0000-7000-8000-000000000000')
  // 2025-09-19T12:00:00.000Z = 1758283200000 ms = 0x01995 ... (48 bits, big endian)
  const ms = Date.parse('2025-09-19T12:00:00.000Z')
  const id = auditBoundaryId(ms)
  assertEquals(id.length, 36)
  assertEquals(Number.parseInt(id.replaceAll('-', '').slice(0, 12), 16), ms)
  assertEquals(id.slice(14, 15), '7')
  // A later moment sorts after an earlier one.
  assert(auditBoundaryId(ms + 1) > id)
})

test('one capped batch is deleted by id range and the count is returned', async () => {
  const { db, statements } = fakeDb([{ id: 'a' }, { id: 'b' }])
  const deleted = await pruneAuditHistory(db, { now: NOW, limit: 10 })
  assertEquals(deleted, 2)
  assertEquals(statements.length, 1)
  const text = statements[0]!
  assert(text.includes('limit 10'))
  assert(text.includes('order by a.id'))
  assert(text.includes(auditBoundaryId(Date.parse('2025-09-19T12:00:00.000Z'))))
  assert(text.includes('2025-09-19T12:00:00.000Z'))
})

test('zero months keeps everything and never touches the database', async () => {
  const { db, statements } = fakeDb([{ id: 'a' }])
  assertEquals(await pruneAuditHistory(db, { now: NOW, months: 0 }), 0)
  assertEquals(statements.length, 0)
})

test('a window that is not whole months is refused', async () => {
  const { db } = fakeDb([])
  await assertRejects(() => pruneAuditHistory(db, { now: NOW, months: -1 }), TypeError)
  await assertRejects(() => pruneAuditHistory(db, { now: NOW, months: 1.5 }), TypeError)
})

test('the batch size is held between 1 and 5000', async () => {
  const small = fakeDb([])
  await pruneAuditHistory(small.db, { now: NOW, limit: 0 })
  assert(small.statements[0]!.includes('limit 1'))
  const big = fakeDb([])
  await pruneAuditHistory(big.db, { now: NOW, limit: 100000 })
  assert(big.statements[0]!.includes('limit 5000'))
})
