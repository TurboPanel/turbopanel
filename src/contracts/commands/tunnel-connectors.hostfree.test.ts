import { assertEquals, assertThrows } from '@std/assert'
import { parseCommandPayload, parseCommandResult } from './schemas.ts'
import { parseTunnelConnectorsPayload, parseTunnelConnectorsResult } from './tunnel-connectors.ts'

/** Sonar only recognises `test()`; see backups-reconcile.hostfree.test.ts. */
const test = Deno.test.bind(Deno)

const ID_A = '6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f'
const ID_B = '7a2d3e4f-5b6c-4d7e-9f80-1b2c3d4e5f60'
const ENVELOPE = 'tpdaemon.AAAA'

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { install: [{ tunnelId: ID_A, tokenEnvelope: ENVELOPE }], remove: [], ...overrides }
}

test('a list of installs and removes parses, and is registered as a command', () => {
  const value = payload({ remove: [ID_B] })
  assertEquals(parseTunnelConnectorsPayload(value), value)
  assertEquals(parseCommandPayload('server.tunnel.connectors', value), value)
  const result = { installed: [ID_A], unchanged: [], removed: [ID_B] }
  assertEquals(parseTunnelConnectorsResult(result), result)
  assertEquals(parseCommandResult('server.tunnel.connectors', result), result)
})

test('a list that names nothing, or a tunnel twice, is refused', () => {
  assertThrows(() => parseTunnelConnectorsPayload(payload({ install: [], remove: [] })))
  assertThrows(() => parseTunnelConnectorsPayload(payload({ remove: [ID_A] })))
  assertThrows(() =>
    parseTunnelConnectorsPayload(
      payload({
        install: [
          { tunnelId: ID_A, tokenEnvelope: ENVELOPE },
          { tunnelId: ID_A, tokenEnvelope: ENVELOPE },
        ],
      })
    )
  )
})

test('a token must be sealed for the daemon and a tunnel id must be a lower-case UUID', () => {
  for (const tokenEnvelope of [
    'plain',
    'tpdaemon.',
    'tpsecret.AAAA',
    `tpdaemon.${'A'.repeat(9000)}`,
  ]) {
    assertThrows(() =>
      parseTunnelConnectorsPayload(payload({ install: [{ tunnelId: ID_A, tokenEnvelope }] }))
    )
  }
  for (const tunnelId of ['instance', 'default', ID_A.toUpperCase(), '../etc', '']) {
    assertThrows(() =>
      parseTunnelConnectorsPayload(payload({ install: [{ tunnelId, tokenEnvelope: ENVELOPE }] }))
    )
    assertThrows(() => parseTunnelConnectorsPayload(payload({ install: [], remove: [tunnelId] })))
  }
})

test('there is a limit on how many tunnels one command names', () => {
  const many = Array.from(
    { length: 65 },
    (_, index) => `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`
  )
  assertThrows(() => parseTunnelConnectorsPayload(payload({ install: [], remove: many })))
})

test('a result with a wrong shape is refused', () => {
  assertThrows(() => parseTunnelConnectorsResult({ installed: [ID_A] }))
  assertThrows(() =>
    parseTunnelConnectorsResult({ installed: ['nope'], unchanged: [], removed: [] })
  )
})
