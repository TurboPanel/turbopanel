import { assertEquals, assertThrows } from 'jsr:@std/assert'
import {
  encodeCommandEnvelope,
  parseCommandEnvelope,
} from './envelope.ts'
import {
  parseCommandPayload,
  parseCommandResult,
  parseHostnameSetPayload,
  parseHostnameSetResult,
  parsePingPayload,
  parsePingResult,
  parseRebootPayload,
  parseRebootResult,
} from './schemas.ts'
import type { CommandType } from './types.ts'

Deno.test('parsePingPayload accepts empty object', () => {
  assertEquals(parsePingPayload({}), {})
})

Deno.test('parsePingPayload rejects non-object values', () => {
  for (const value of [null, [], 'x']) {
    assertThrows(() => parsePingPayload(value), Error, 'Invalid ping payload')
  }
})

Deno.test('parseRebootPayload accepts empty object', () => {
  assertEquals(parseRebootPayload({}), {})
})

Deno.test('parseRebootPayload rejects non-object values', () => {
  for (const value of [null, [], 'x']) {
    assertThrows(() => parseRebootPayload(value), Error, 'Invalid reboot payload')
  }
})

Deno.test('parseHostnameSetPayload accepts valid hostname', () => {
  assertEquals(parseHostnameSetPayload({ hostname: 'web-01' }), { hostname: 'web-01' })
})

Deno.test('parseHostnameSetPayload rejects invalid hostnames', () => {
  for (const hostname of [undefined, '', 'a b', 'a;b']) {
    assertThrows(
      () => parseHostnameSetPayload({ hostname }),
      Error,
      'Invalid hostname set payload',
    )
  }
  assertThrows(
    () => parseHostnameSetPayload(null),
    Error,
    'Invalid hostname set payload',
  )
})

Deno.test('parsePingResult keeps only valid string hop fields', () => {
  assertEquals(parsePingResult(null), {})
  assertEquals(
    parsePingResult({
      daemonReceivedAt: '2020-01-01T00:00:00.000Z',
      daemonRespondedAt: '2020-01-01T00:00:01.000Z',
      daemonHostname: 'web-01',
      daemonBuild: {
        commit: 'abc',
        buildId: 'build-1',
        builtAt: '2020-01-01T00:00:00.000Z',
        channel: 'trunk',
        extra: 1,
      },
      bogus: 123,
    }),
    {
      daemonReceivedAt: '2020-01-01T00:00:00.000Z',
      daemonRespondedAt: '2020-01-01T00:00:01.000Z',
      daemonHostname: 'web-01',
      daemonBuild: {
        commit: 'abc',
        buildId: 'build-1',
        builtAt: '2020-01-01T00:00:00.000Z',
        channel: 'trunk',
      },
    },
  )
  assertEquals(parsePingResult({ daemonBuild: {} }), {})
})

Deno.test('parseRebootResult returns default for non-records and round-trips valid results', () => {
  assertEquals(parseRebootResult(null), { scheduled: false })
  assertEquals(parseRebootResult({ scheduled: true, summary: 'ok' }), {
    scheduled: true,
    summary: 'ok',
  })
  assertEquals(parseRebootResult({ scheduled: true }), { scheduled: true })
})

Deno.test('parseHostnameSetResult round-trips valid results', () => {
  assertEquals(
    parseHostnameSetResult({ observedHostname: 'web-01', summary: 'ok' }),
    { observedHostname: 'web-01', summary: 'ok' },
  )
  assertEquals(
    parseHostnameSetResult({ observedHostname: 'web-01' }),
    { observedHostname: 'web-01' },
  )
})

Deno.test('parseHostnameSetResult rejects missing or empty observedHostname', () => {
  for (const value of [{}, { observedHostname: '' }, { observedHostname: 1 }]) {
    assertThrows(
      () => parseHostnameSetResult(value),
      Error,
      'Invalid hostname set result',
    )
  }
})

Deno.test('parseCommandPayload and parseCommandResult dispatch by type', () => {
  assertEquals(parseCommandPayload('daemon.ping' as CommandType, {}), {})
  assertEquals(
    parseCommandPayload('server.hostname.set' as CommandType, { hostname: 'web-01' }),
    { hostname: 'web-01' },
  )
  assertEquals(parseCommandPayload('server.reboot' as CommandType, {}), {})
  assertEquals(parseCommandResult('daemon.ping' as CommandType, { daemonHostname: 'x' }), {
    daemonHostname: 'x',
  })
  assertEquals(
    parseCommandResult('server.hostname.set' as CommandType, { observedHostname: 'web-01' }),
    { observedHostname: 'web-01' },
  )
  assertEquals(
    parseCommandResult('server.reboot' as CommandType, { scheduled: true, summary: 'ok' }),
    { scheduled: true, summary: 'ok' },
  )
})

Deno.test('encodeCommandEnvelope round-trips through parseCommandEnvelope', () => {
  const envelope = {
    commandId: 'cmd-1',
    serverId: 'srv-1',
    type: 'daemon.ping' as CommandType,
    attempt: 1,
    queuedAt: '2020-01-01T00:00:00.000Z',
    correlationId: 'corr-1',
  }
  assertEquals(parseCommandEnvelope(encodeCommandEnvelope(envelope)), envelope)
  assertEquals(parseCommandEnvelope(envelope), envelope)
})

Deno.test('parseCommandEnvelope rejects invalid envelopes', () => {
  assertThrows(() => parseCommandEnvelope('not-json'), Error, 'Invalid command envelope')
  assertThrows(() => parseCommandEnvelope(null), Error, 'Invalid command envelope')
  assertThrows(
    () => parseCommandEnvelope({ commandId: '', serverId: 's', type: 'daemon.ping', attempt: 1, queuedAt: 't' }),
    Error,
    'Invalid command envelope',
  )
  assertThrows(
    () => parseCommandEnvelope({ commandId: 'c', serverId: 's', type: 'unknown', attempt: 1, queuedAt: 't' }),
    Error,
    'Invalid command envelope',
  )
  assertThrows(
    () => parseCommandEnvelope({ commandId: 'c', serverId: 's', type: 'daemon.ping', attempt: 0, queuedAt: 't' }),
    Error,
    'Invalid command envelope',
  )
  assertThrows(
    () => parseCommandEnvelope({ commandId: 'c', serverId: 's', type: 'daemon.ping', attempt: 1.5, queuedAt: 't' }),
    Error,
    'Invalid command envelope',
  )
})
