import { assertEquals } from '@std/assert'
import { edgeGateFrom } from './gate.ts'

const test = Deno.test.bind(Deno)

test('the gate is shut until a superadmin confirms', () => {
  assertEquals(edgeGateFrom(undefined, undefined).open, false)
  assertEquals(edgeGateFrom({ confirmed: false }, undefined).open, false)
  const open = edgeGateFrom(
    { confirmed: true, at: '2026-11-01T00:00:00Z', by: 'root@example.com' },
    undefined
  )
  assertEquals(open.open, true)
  assertEquals(open.confirmedBy, 'root@example.com')
})

test('TURBOPANEL_EDGE_GATE=closed keeps the gate shut; no value opens it', () => {
  const forced = edgeGateFrom({ confirmed: true }, 'closed')
  assertEquals(forced.open, false)
  assertEquals(forced.forcedClosed, true)
  assertEquals(edgeGateFrom({ confirmed: false }, 'open').open, false)
})
