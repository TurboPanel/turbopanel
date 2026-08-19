import { assertEquals, assertThrows } from '@std/assert'
import {
  encodeCommandEnvelope,
  parseCommandEnvelope,
  type CommandEnvelope,
} from './envelope.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const valid: CommandEnvelope = {
  commandId: '00000000-0000-4000-8000-000000000001',
  serverId: '00000000-0000-4000-8000-000000000002',
  type: 'daemon.ping',
  attempt: 1,
  queuedAt: '2020-01-01T00:00:00.000Z',
}

test('encodeCommandEnvelope round-trips through parseCommandEnvelope', () => {
  const encoded = encodeCommandEnvelope(valid)
  assertEquals(typeof encoded, 'string')
  assertEquals(parseCommandEnvelope(encoded), valid)
})

test('parseCommandEnvelope accepts an already-parsed object', () => {
  assertEquals(parseCommandEnvelope({ ...valid }), valid)
})

test('parseCommandEnvelope keeps a non-empty correlationId', () => {
  const withCorrelation = {
    ...valid,
    correlationId: 'corr-1',
  }
  assertEquals(parseCommandEnvelope(withCorrelation).correlationId, 'corr-1')
})

test('parseCommandEnvelope drops empty or non-string correlationId', () => {
  assertEquals(
    parseCommandEnvelope({ ...valid, correlationId: '' }).correlationId,
    undefined,
  )
  assertEquals(
    parseCommandEnvelope({ ...valid, correlationId: 12 }).correlationId,
    undefined,
  )
})

test('parseCommandEnvelope rejects invalid JSON strings', () => {
  assertThrows(
    () => parseCommandEnvelope('{not-json'),
    Error,
    'Invalid command envelope',
  )
})

test('parseCommandEnvelope rejects non-objects', () => {
  for (const raw of [null, undefined, 1, true, [], 'plain']) {
    assertThrows(
      () => parseCommandEnvelope(raw),
      Error,
      'Invalid command envelope',
    )
  }
})

test('parseCommandEnvelope rejects missing or empty required string fields', () => {
  const cases: Array<Record<string, unknown>> = [
    { ...valid, commandId: '' },
    { ...valid, serverId: '' },
    { ...valid, queuedAt: '' },
    { ...valid, commandId: undefined },
    { ...valid, serverId: null },
    { ...valid, queuedAt: 1 },
  ]
  for (const raw of cases) {
    assertThrows(
      () => parseCommandEnvelope(raw),
      Error,
      'Invalid command envelope',
    )
  }
})

test('parseCommandEnvelope rejects unknown command types', () => {
  assertThrows(
    () => parseCommandEnvelope({ ...valid, type: 'not.a.command' }),
    Error,
    'Invalid command envelope',
  )
})

test('parseCommandEnvelope rejects non-positive attempt values', () => {
  for (const attempt of [0, -1, 1.5, '1', null, undefined]) {
    assertThrows(
      () => parseCommandEnvelope({ ...valid, attempt }),
      Error,
      'Invalid command envelope',
    )
  }
})

test('parseCommandEnvelope accepts every canonical command type', () => {
  const types = [
    'daemon.ping',
    'server.hostname.set',
    'server.ntp.set',
    'server.reboot',
    'server.timezone.set',
    'server.fabric.reconcile',
    'environment.deploy',
    'environment.lifecycle',
    'environment.stop',
    'managed.apply',
    'managed.lifecycle',
    'managed.destroy',
    'managed.backup',
    'managed.restore',
    'managed.promote',
    'managed.ingress.reconcile',
    'managed.ha.reconcile',
    'managed.ha.failover',
    'system.reconcile',
  ] as const
  for (const type of types) {
    const parsed = parseCommandEnvelope({ ...valid, type, attempt: 3 })
    assertEquals(parsed.type, type)
    assertEquals(parsed.attempt, 3)
  }
})
