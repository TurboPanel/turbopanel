import { assertEquals } from 'jsr:@std/assert'
import { createInboundWindowGate } from './inbound-window.ts'

Deno.test('inbound window allows up to limit then drops', () => {
  const gate = createInboundWindowGate(3, 60_000)
  assertEquals(gate.allow('c1'), true)
  assertEquals(gate.allow('c1'), true)
  assertEquals(gate.allow('c1'), true)
  assertEquals(gate.allow('c1'), false)
  assertEquals(gate.allow('c1'), false)
})

Deno.test('inbound window is independent per connection', () => {
  const gate = createInboundWindowGate(1, 60_000)
  assertEquals(gate.allow('a'), true)
  assertEquals(gate.allow('a'), false)
  assertEquals(gate.allow('b'), true)
  assertEquals(gate.allow('b'), false)
})

Deno.test('inbound window release clears state', () => {
  const gate = createInboundWindowGate(1, 60_000)
  assertEquals(gate.allow('c1'), true)
  assertEquals(gate.allow('c1'), false)
  gate.release('c1')
  assertEquals(gate.allow('c1'), true)
})

Deno.test('inbound window resets after windowMs', async () => {
  const gate = createInboundWindowGate(1, 20)
  assertEquals(gate.allow('c1'), true)
  assertEquals(gate.allow('c1'), false)
  await new Promise((resolve) => setTimeout(resolve, 25))
  assertEquals(gate.allow('c1'), true)
})
