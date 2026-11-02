import { assert, assertEquals } from '@std/assert'
import { inArray } from 'drizzle-orm'
import { createDenoDb, endDbConnection } from '../../../db/connection.ts'
import { server } from '../../../db/schema.ts'
import { skipWithoutDatabase } from '../../../test-fixtures/require-service.test.support.ts'
import { readEdgeGate } from './gate.ts'

const test = Deno.test.bind(Deno)
const dbUrl = Deno.env.get('TURBOPANEL_DATABASE_URL')

test('the gate lists a remote server that has not pinned, and drops it once it has', async () => {
  if (!dbUrl) return skipWithoutDatabase('edge gate tests')
  const db = createDenoDb()
  const suffix = crypto.randomUUID().slice(0, 8)
  const ids: string[] = []
  try {
    const rows = await db
      .insert(server)
      .values([
        { name: `gate-unpinned-${suffix}` },
        { name: `gate-unsafe-${suffix}`, trustPinnedBy: 'unsafe' },
        { name: `gate-pinned-${suffix}`, trustPinnedBy: 'upgrade' },
      ])
      .returning({ id: server.id, name: server.name })
    ids.push(...rows.map((row) => row.id))
    const shut = await readEdgeGate(db, {})
    assertEquals(shut.open, false)
    const names = new Set(shut.waiting.map((item) => item.name))
    assert(names.has(`gate-unpinned-${suffix}`))
    assert(names.has(`gate-unsafe-${suffix}`))
    assertEquals(names.has(`gate-pinned-${suffix}`), false)

    await db.update(server).set({ trustPinnedBy: 'install' }).where(inArray(server.id, ids))
    const after = new Set((await readEdgeGate(db, {})).waiting.map((item) => item.id))
    assertEquals(
      ids.some((id) => after.has(id)),
      false
    )
  } finally {
    if (ids.length > 0) await db.delete(server).where(inArray(server.id, ids))
    await endDbConnection(db)
  }
})

test('a single unassigned remote server still holds the gate shut (no guessing it is local)', async () => {
  if (!dbUrl) return skipWithoutDatabase('edge gate tests')
  const db = createDenoDb()
  const name = `gate-lone-${crypto.randomUUID().slice(0, 8)}`
  let id = ''
  try {
    const [row] = await db.insert(server).values({ name }).returning({ id: server.id })
    id = row!.id
    const gate = await readEdgeGate(db, {})
    assertEquals(gate.open, false)
    assert(gate.waiting.some((item) => item.id === id))
  } finally {
    if (id) await db.delete(server).where(inArray(server.id, [id]))
    await endDbConnection(db)
  }
})
