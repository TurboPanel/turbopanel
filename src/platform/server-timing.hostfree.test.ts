import { assertEquals } from '@std/assert'
import { formatServerTiming } from './server-timing.ts'

Deno.test('formatServerTiming omits init on warm requests', () => {
  assertEquals(
    formatServerTiming({ dbStatements: 3, appMs: 12.34 }),
    'db;desc="3 stmts", app;dur=12.3'
  )
})

Deno.test('formatServerTiming includes init on the cold request', () => {
  assertEquals(
    formatServerTiming({ initMs: 45.67, dbStatements: 0, appMs: 1 }),
    'init;dur=45.7, db;desc="0 stmts", app;dur=1.0'
  )
})

Deno.test('formatServerTiming clamps bad numbers', () => {
  assertEquals(
    formatServerTiming({ initMs: Number.NaN, dbStatements: -2, appMs: -5 }),
    'init;dur=0.0, db;desc="0 stmts", app;dur=0.0'
  )
})
