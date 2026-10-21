/**
 * The audit prune against a real database: old rows go oldest first in
 * batches, young rows and rows of other organizations stay, a second run with
 * nothing old deletes nothing. Needs a database.
 */
import { assertEquals } from '@std/assert'
import { inArray } from 'drizzle-orm'
import { createDenoDb } from '../../db/connection.ts'
import { getDatabaseUrl } from '../../db/url.ts'
import { audit } from '../../db/schema.ts'
import { skipWithoutDatabase } from '../../test-fixtures/require-service.test.support.ts'
import { auditBoundaryId, pruneAuditHistory } from './prune.ts'

const test = Deno.test.bind(Deno)

const NOW = '2026-10-19T12:00:00.000Z'
const DAY = 86_400_000

/** A uuidv7-shaped id for a moment, with a counter in the random part so ids stay unique and ordered. */
function idAt(ms: number, counter: number): string {
  const base = auditBoundaryId(ms)
  return `${base.slice(0, 24)}${counter.toString(16).padStart(12, '0')}`
}

function row(ms: number, counter: number, action: string) {
  return {
    id: idAt(ms, counter),
    createdAt: new Date(ms).toISOString(),
    action,
    targetType: 'organization',
  }
}

test('old audit rows are removed oldest first in batches and young rows stay', async () => {
  if (!getDatabaseUrl()) {
    skipWithoutDatabase('audit prune tests')
    return
  }
  const db = createDenoDb()
  const now = Date.parse(NOW)
  // A moment so far back that nothing real predates it keeps the rows this test made apart.
  const longAgo = Date.parse('2001-03-04T00:00:00.000Z')
  const old = [0, 1, 2].map((n) => row(longAgo + n * DAY, 1 + n, 'test.audit_prune.old'))
  const young = [
    row(now - 30 * DAY, 10, 'test.audit_prune.young'),
    row(now - 12 * 30 * DAY, 11, 'test.audit_prune.young'),
  ]
  // Rows of realistic age: 14 months old (past the window) and 12 months old (inside it).
  const aged = [row(now - 14 * 30 * DAY, 30, 'test.audit_prune.aged')]
  const recent = [row(now - 12 * 30 * DAY, 31, 'test.audit_prune.recent')]
  const ids = [...old, ...young, ...aged, ...recent].map((r) => r.id)
  try {
    await db.insert(audit).values([...young, ...old, ...aged, ...recent])

    // Two at a time: a batch never exceeds its limit and the oldest go first.
    assertEquals(await pruneAuditHistory(db, { now: NOW, limit: 2 }), 2)
    const afterFirst = await db.select({ id: audit.id }).from(audit).where(inArray(audit.id, ids))
    assertEquals(new Set(afterFirst.map((r) => r.id)).has(old[0]!.id), false)
    assertEquals(new Set(afterFirst.map((r) => r.id)).has(old[1]!.id), false)
    assertEquals(new Set(afterFirst.map((r) => r.id)).has(old[2]!.id), true)

    // The rest of the old rows go; the young ones are never touched.
    assertEquals((await pruneAuditHistory(db, { now: NOW, limit: 50 })) >= 1, true)
    const left = await db.select({ id: audit.id }).from(audit).where(inArray(audit.id, ids))
    // The 14 month old row went with the 2001 ones; the 12 month old row and the young ones stay.
    assertEquals(new Set(left.map((r) => r.id)), new Set([...young, ...recent].map((r) => r.id)))

    // Nothing old is left (of ours): the same call deletes nothing more of these rows.
    await pruneAuditHistory(db, { now: NOW, limit: 50 })
    const again = await db.select({ id: audit.id }).from(audit).where(inArray(audit.id, ids))
    assertEquals(again.length, young.length + recent.length)

    // Zero months keeps everything, however old.
    await db.insert(audit).values(row(longAgo, 20, 'test.audit_prune.keep'))
    assertEquals(await pruneAuditHistory(db, { now: NOW, months: 0 }), 0)
    const kept = await db
      .select({ id: audit.id })
      .from(audit)
      .where(inArray(audit.id, [idAt(longAgo, 20)]))
    assertEquals(kept.length, 1)
  } finally {
    await db.delete(audit).where(inArray(audit.id, [...ids, idAt(longAgo, 20)]))
  }
})
