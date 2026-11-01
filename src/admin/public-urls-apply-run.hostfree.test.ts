import { assertEquals } from '@std/assert'
import type { Db } from '../db/connection.ts'
import { loadEdgeTrustState } from '../features/install/edge-trust.ts'
import { recordEdgeTrustApplied } from './public-urls-apply-run.ts'

const test = Deno.test.bind(Deno)

function fakeDb(rows: { key: string; value: unknown }[]): Db {
  return {
    select: () => ({ from: () => ({ where: () => Promise.resolve(rows) }) }),
    insert: () => ({
      values: (row: { key: string; value: unknown }) => ({
        onConflictDoUpdate: () => {
          rows.splice(0, rows.length, row)
          return Promise.resolve()
        },
      }),
    }),
  } as unknown as Db
}

test('an apply that carried no edge set records nothing', async () => {
  const rows: { key: string; value: unknown }[] = []
  await recordEdgeTrustApplied(fakeDb(rows), { urls: [] })
  assertEquals(rows, [])
})

test('an apply that carried an edge set records its hash', async () => {
  const rows: { key: string; value: unknown }[] = []
  const db = fakeDb(rows)
  await recordEdgeTrustApplied(db, {
    urls: [],
    edgeTrust: { cidrs: [], hash: 'abc', cloudflare: [], bunny: [] },
  })
  assertEquals((await loadEdgeTrustState(db)).appliedHash, 'abc')
})
