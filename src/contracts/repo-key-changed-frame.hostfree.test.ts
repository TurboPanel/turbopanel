/**
 * `repo-key-changed` frame shape (`validateDaemonInboundFrame`). Raising the
 * notice is `handleRepoKeyChanged`'s job, covered in
 * src/features/notifications/repo-key-alerts.hostfree.test.ts.
 */

import { assert, assertEquals } from '@std/assert'
import {
  DAEMON_INBOUND_ALLOWED,
  MAX_DAEMON_WS_REPO_KEY_EXPECTED,
  validateDaemonInboundFrame,
  wireMessageToInboundEnvelope,
} from './cell-protocol.ts'
import type { DaemonMessage } from './cell-protocol.ts'

/** Sonar typescript:S2187 only recognizes `test()`; keep this alias. */
const test = Deno.test.bind(Deno)

const OLD = '9DC858229FC7DD38854AE2D88D81803C0EBFCD88'
const NEW = 'ABCDEF0123456789ABCDEF0123456789ABCDEF01'

function frame(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'repo-key-changed',
    keyName: 'docker',
    expected: [OLD],
    got: NEW,
    at: '2026-10-31T12:00:00.000Z',
    ...overrides,
  }
}

function reason(value: Record<string, unknown>): string | null {
  const result = validateDaemonInboundFrame(JSON.stringify(value))
  return result.ok ? null : result.reason
}

test('repo-key-changed is an allowed, fire-and-forget inbound type', () => {
  const allowed: ReadonlySet<string> = DAEMON_INBOUND_ALLOWED
  assert(allowed.has('repo-key-changed'))
  assertEquals(wireMessageToInboundEnvelope(frame() as unknown as DaemonMessage), null)
})

test('a well-formed frame passes, with lower case or 64-digit fingerprints too', () => {
  assertEquals(reason(frame()), null)
  assertEquals(reason(frame({ got: NEW.toLowerCase() })), null)
  assertEquals(reason(frame({ got: 'a'.repeat(64), keyName: 'php-8.4' })), null)
})

test('malformed frames are refused', () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [frame({ at: 'yesterday' }), 'invalid at timestamp'],
    [frame({ keyName: undefined }), 'invalid keyName'],
    [frame({ keyName: 'Docker Inc' }), 'invalid keyName'],
    [frame({ keyName: 'x'.repeat(33) }), 'invalid keyName'],
    [frame({ got: undefined }), 'invalid got'],
    [frame({ got: 'not-hex' }), 'invalid got'],
    [frame({ got: NEW.slice(0, 39) }), 'invalid got'],
    [frame({ expected: undefined }), 'invalid expected'],
    [frame({ expected: [] }), 'invalid expected'],
    [frame({ expected: [OLD, 'nope'] }), 'invalid expected'],
    [frame({ expected: [5] }), 'invalid expected'],
    [
      frame({ expected: Array.from({ length: MAX_DAEMON_WS_REPO_KEY_EXPECTED + 1 }, () => OLD) }),
      'invalid expected',
    ],
  ]
  for (const [value, expected] of cases) {
    assertEquals(reason(value), expected)
  }
})
