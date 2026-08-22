/**
 * Host-free coverage for server command route pure helpers (no Postgres).
 */

import { assertEquals } from '@std/assert'
import {
  parseHostnameCommandBody,
  parseTimezoneCommandBody,
  parseNtpCommandBody,
  shapeCommandGetResponse,
  commandNotFoundOnServer,
  parseCommandLogQuery,
  shapeCommandLogResponse,
  shapeCommandStatusResponse,
} from './commands-routes-helpers.ts'
import { DEFAULT_EXECUTION_LOG_READ_BYTES } from '../../lib/execution-logs/types.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('parseHostnameCommandBody validates required hostname shape', () => {
  const missing = parseHostnameCommandBody({})
  if (missing.ok) throw new TypeError('expected missing hostname rejection')
  assertEquals(missing, {
    ok: false,
    error: 'Invalid request',
    status: 400,
  })

  const empty = parseHostnameCommandBody({ hostname: '' })
  if (empty.ok) throw new TypeError('expected empty hostname rejection')
  assertEquals(empty.error, 'Invalid request')

  const invalid = parseHostnameCommandBody({ hostname: 'BAD HOST' })
  if (invalid.ok) throw new TypeError('expected invalid hostname rejection')
  assertEquals(invalid, {
    ok: false,
    error: 'Invalid hostname',
    status: 400,
  })

  const ok = parseHostnameCommandBody({ hostname: 'edge.example.com' })
  if (!ok.ok) throw new TypeError('expected valid hostname')
  assertEquals(ok.hostname, 'edge.example.com')
})

test('parseTimezoneCommandBody rejects invalid and disallowed timezones', () => {
  const badShape = parseTimezoneCommandBody({})
  if (badShape.ok) throw new TypeError('expected missing timezone rejection')
  assertEquals(badShape.error, 'Invalid timezone')

  const disallowed = parseTimezoneCommandBody({ timezone: 'Not/A_Zone' })
  if (disallowed.ok) throw new TypeError('expected disallowed timezone')
  assertEquals(disallowed.error, 'Invalid timezone')

  const ok = parseTimezoneCommandBody({ timezone: 'America/Chicago' })
  if (!ok.ok) throw new TypeError('expected America/Chicago timezone')
  assertEquals(ok.payload.timezone, 'America/Chicago')
})

test('parseNtpCommandBody requires a valid ntp payload', () => {
  const bad = parseNtpCommandBody({})
  if (bad.ok) throw new TypeError('expected empty ntp rejection')
  assertEquals(bad, {
    ok: false,
    error: 'Invalid ntp payload',
    status: 400,
  })

  const ok = parseNtpCommandBody({ enabled: true })
  if (!ok.ok) throw new TypeError('expected valid ntp payload')
  assertEquals(ok.payload.enabled, true)
})

test('commandNotFoundOnServer and shapeCommandGetResponse', () => {
  assertEquals(commandNotFoundOnServer(null, 'srv-1'), true)
  assertEquals(
    commandNotFoundOnServer({ serverId: 'other' }, 'srv-1'),
    true,
  )
  assertEquals(
    commandNotFoundOnServer({ serverId: 'srv-1' }, 'srv-1'),
    false,
  )

  const reboot = shapeCommandGetResponse({
    type: 'server.reboot',
    id: 'c1',
  })
  assertEquals(reboot, { type: 'server.reboot', id: 'c1' })

  const ping = shapeCommandGetResponse({
    type: 'daemon.ping',
    id: 'c2',
    queuedAt: '2020-01-01T00:00:00.000Z',
    createdAt: '2020-01-01T00:00:00.000Z',
  })
  if (!('latency' in ping)) {
    throw new TypeError('expected ping latency field')
  }
  assertEquals(typeof ping.latency, 'object')
})

const STATUS_SOURCE = {
  id: 'cmd-1',
  serverId: 'srv-1',
  status: 'succeeded',
  type: 'daemon.ping',
  queuedAt: null,
  startedAt: null,
  finishedAt: null,
  errorCode: null,
  errorMessage: null,
}

test('shapeCommandStatusResponse defaults hasLog to false', () => {
  assertEquals(shapeCommandStatusResponse(STATUS_SOURCE).hasLog, false)
})

test('shapeCommandStatusResponse carries a store-resolved hasLog', () => {
  assertEquals(shapeCommandStatusResponse(STATUS_SOURCE, true).hasLog, true)
})

test('parseCommandLogQuery defaults an absent or invalid window', () => {
  assertEquals(parseCommandLogQuery(undefined, undefined), {
    from: 0,
    max: DEFAULT_EXECUTION_LOG_READ_BYTES,
  })
  // A poll loop must not 400 on a stray query string — fall back, do not reject.
  assertEquals(parseCommandLogQuery('nope', 'nope'), {
    from: 0,
    max: DEFAULT_EXECUTION_LOG_READ_BYTES,
  })
  assertEquals(parseCommandLogQuery('-3', '0'), {
    from: 0,
    max: DEFAULT_EXECUTION_LOG_READ_BYTES,
  })
})

test('parseCommandLogQuery accepts a window and clamps the byte budget', () => {
  assertEquals(parseCommandLogQuery('12', '1024'), { from: 12, max: 1024 })
  assertEquals(
    parseCommandLogQuery('0', String(DEFAULT_EXECUTION_LOG_READ_BYTES * 10)).max,
    DEFAULT_EXECUTION_LOG_READ_BYTES,
  )
})

test('shapeCommandLogResponse reports "not started" without a 404', () => {
  assertEquals(shapeCommandLogResponse(null, 7), {
    ok: true,
    text: '',
    nextSeq: 7,
    sealed: false,
    truncated: false,
    exists: false,
  })
})

test('shapeCommandLogResponse decodes transcript bytes as UTF-8', () => {
  assertEquals(
    shapeCommandLogResponse(
      {
        bytes: new TextEncoder().encode('done\n'),
        nextSeq: 3,
        sealed: true,
        truncated: false,
      },
      1,
    ),
    {
      ok: true,
      text: 'done\n',
      nextSeq: 3,
      sealed: true,
      truncated: false,
      exists: true,
    },
  )
})

test('shapeCommandLogResponse distinguishes empty output from no transcript', () => {
  const empty = shapeCommandLogResponse(
    { bytes: new Uint8Array(0), nextSeq: 0, sealed: false, truncated: false },
    0,
  )
  assertEquals(empty.text, '')
  assertEquals(empty.exists, true)
})
