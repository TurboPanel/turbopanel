import { assertEquals } from '@std/assert'
import { formatServerTiming, isServerTimingRoute } from './server-timing.ts'

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

Deno.test('only GET /api/client/v1/status may carry Server-Timing', () => {
  assertEquals(isServerTimingRoute('GET', '/api/client/v1/status'), true)
  assertEquals(isServerTimingRoute('POST', '/api/client/v1/status'), false)
  for (const path of [
    '/api/client/v1/auth/request-password-reset',
    '/api/client/v1/auth/sign-in',
    '/api/client/v1/auth/sign-up',
    '/api/health',
  ]) {
    assertEquals(isServerTimingRoute('POST', path), false)
    assertEquals(isServerTimingRoute('GET', path), false)
  }
})
