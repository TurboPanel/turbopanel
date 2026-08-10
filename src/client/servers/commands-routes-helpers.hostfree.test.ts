/**
 * Host-free coverage for server command route pure helpers (no Postgres).
 */

import { assertEquals } from 'jsr:@std/assert'
import {
  parseHostnameCommandBody,
  parseTimezoneCommandBody,
  parseNtpCommandBody,
  shapeCommandGetResponse,
  commandNotFoundOnServer,
} from './commands-routes-helpers.ts'

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
