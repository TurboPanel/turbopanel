/**
 * `backup-copy-report` frame shape (`validateDaemonInboundFrame`). Whether a
 * well-formed report is believed is `handleBackupCopyReport`'s job, covered in
 * src/features/backups/copy-report.hostfree.test.ts.
 */

import { assert, assertEquals } from '@std/assert'
import { DAEMON_INBOUND_ALLOWED, validateDaemonInboundFrame } from './cell-protocol.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

function report(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'backup-copy-report',
    id: 'a'.repeat(32),
    targetId: '0192a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6b',
    managedId: '1192a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6b',
    backupId: 'bk_0123456789abcdef',
    policyId: '2192a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6b',
    state: 'copied',
    objectKey: 'tp/managed/x/policy-y/bk_0123456789abcdef.dump',
    sizeBytes: 2048,
    attempts: 1,
    finishedAt: '2026-10-21T03:00:05.000Z',
    pruned: ['bk_old'],
    at: '2026-10-21T03:00:06.000Z',
    ...overrides,
  }
}

function reason(frame: Record<string, unknown>): string | null {
  const result = validateDaemonInboundFrame(JSON.stringify(frame))
  return result.ok ? null : result.reason
}

test('backup-copy-report is an allowed inbound type and its answer is not', () => {
  const allowed: ReadonlySet<string> = DAEMON_INBOUND_ALLOWED
  assert(allowed.has('backup-copy-report'))
  assert(!allowed.has('backup-copy-report-result'))
})

test('well-formed copied and failed reports pass the frame check', () => {
  assertEquals(reason(report()), null)
  assertEquals(
    reason(
      report({
        state: 'failed',
        objectKey: undefined,
        pruned: undefined,
        policyId: undefined,
        error: 'the bucket does not exist',
      })
    ),
    null
  )
})

test('a malformed report is refused with a reason', () => {
  for (const [override, expected] of [
    [{ targetId: 'nope' }, 'invalid targetId'],
    [{ managedId: 'nope' }, 'invalid managedId'],
    [{ backupId: 'a/b' }, 'invalid backupId'],
    [{ policyId: 'X' }, 'invalid policyId'],
    [{ state: 'pending' }, 'invalid state'],
    [{ finishedAt: 'yesterday' }, 'invalid finishedAt'],
    [{ attempts: -1 }, 'invalid attempts'],
    [{ sizeBytes: 1.5 }, 'invalid sizeBytes'],
    [{ objectKey: 'x'.repeat(2000) }, 'invalid objectKey'],
    [{ pruned: ['a/b'] }, 'invalid pruned'],
    [{ at: 'later' }, 'invalid at timestamp'],
  ] as const) {
    assertEquals(reason(report(override)), expected, JSON.stringify(override))
  }
})
