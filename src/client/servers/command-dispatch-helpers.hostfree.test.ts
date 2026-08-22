/**
 * Host-free coverage for command-dispatch pure helpers (no Postgres).
 */

import { assertEquals } from '@std/assert'
import {
  buildUserCommandExpiresAt,
  buildCommandEnqueueEnvelope,
  queuedCommandResponseBody,
} from './command-dispatch-helpers.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('buildUserCommandExpiresAt adds ttl to now', () => {
  assertEquals(
    buildUserCommandExpiresAt(60_000, Date.parse('2020-01-01T00:00:00.000Z')),
    '2020-01-01T00:01:00.000Z',
  )
})

test('buildCommandEnqueueEnvelope defaults attempt to 1', () => {
  assertEquals(
    buildCommandEnqueueEnvelope({
      commandId: 'cmd-1',
      serverId: 'srv-1',
      type: 'daemon.ping',
      queuedAt: '2020-01-01T00:00:00.000Z',
    }),
    {
      commandId: 'cmd-1',
      serverId: 'srv-1',
      type: 'daemon.ping',
      attempt: 1,
      queuedAt: '2020-01-01T00:00:00.000Z',
    },
  )
  assertEquals(
    buildCommandEnqueueEnvelope({
      commandId: 'cmd-2',
      serverId: 'srv-1',
      type: 'server.reboot',
      queuedAt: '2020-01-01T00:00:00.000Z',
      attempt: 3,
    }).attempt,
    3,
  )
})

test('queuedCommandResponseBody is the standard queued ack', () => {
  assertEquals(queuedCommandResponseBody('cmd-9'), {
    ok: true,
    commandId: 'cmd-9',
    status: 'queued',
  })
})
