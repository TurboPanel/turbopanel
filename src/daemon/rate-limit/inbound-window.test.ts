import { assertEquals } from 'jsr:@std/assert'
import { createInboundWindowGate } from './inbound-window.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('inbound window allows up to limit then drops', () => {
  const gate = createInboundWindowGate(3, 60_000)
  assertEquals(gate.allow('c1'), true)
  assertEquals(gate.allow('c1'), true)
  assertEquals(gate.allow('c1'), true)
  assertEquals(gate.allow('c1'), false)
  assertEquals(gate.allow('c1'), false)
})

test('inbound window is independent per connection', () => {
  const gate = createInboundWindowGate(1, 60_000)
  assertEquals(gate.allow('a'), true)
  assertEquals(gate.allow('a'), false)
  assertEquals(gate.allow('b'), true)
  assertEquals(gate.allow('b'), false)
})

test('inbound window release clears state', () => {
  const gate = createInboundWindowGate(1, 60_000)
  assertEquals(gate.allow('c1'), true)
  assertEquals(gate.allow('c1'), false)
  gate.release('c1')
  assertEquals(gate.allow('c1'), true)
})

test('inbound window resets after windowMs', async () => {
  const gate = createInboundWindowGate(1, 20)
  assertEquals(gate.allow('c1'), true)
  assertEquals(gate.allow('c1'), false)
  await new Promise((resolve) => setTimeout(resolve, 25))
  assertEquals(gate.allow('c1'), true)
})
