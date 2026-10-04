/**
 * `backup-run-report` frame shape (`validateDaemonInboundFrame`). Whether a
 * well-formed report is believed is `handleBackupRunReport`'s job, covered in
 * src/features/backups/run-report.hostfree.test.ts.
 */

import { assert, assertEquals } from '@std/assert'
import {
  DAEMON_INBOUND_ALLOWED,
  MAX_DAEMON_WS_BACKUP_PATH_CHARS,
  MAX_DAEMON_WS_BACKUP_PRUNED,
  MAX_DAEMON_WS_ERROR_CHARS,
  validateDaemonInboundFrame,
  wireMessageToInboundEnvelope,
} from './cell-protocol.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const POLICY_ID = '0192a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6b'

function report(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'backup-run-report',
    id: 'run_0123456789abcdef',
    policyId: POLICY_ID,
    runId: 'run_0123456789abcdef',
    startedAt: '2026-09-30T03:00:00.000Z',
    finishedAt: '2026-09-30T03:00:05.000Z',
    status: 'succeeded',
    backupId: 'bk_0123456789abcdef',
    sizeBytes: 1024,
    checksum: 'f'.repeat(64),
    path: '/backup/x/policy-y/bk_0123456789abcdef.dump',
    pruned: ['bk_old'],
    nextRunAt: '2026-10-01T03:00:00.000Z',
    at: '2026-09-30T03:00:06.000Z',
    ...overrides,
  }
}

function reason(frame: Record<string, unknown>): string | null {
  const result = validateDaemonInboundFrame(JSON.stringify(frame))
  return result.ok ? null : result.reason
}

test('backup-run-report is an allowed inbound type', () => {
  const allowed: ReadonlySet<string> = DAEMON_INBOUND_ALLOWED
  assert(allowed.has('backup-run-report'))
  assert(!allowed.has('backup-run-report-result'))
})

test('a well-formed succeeded or failed report passes the frame check', () => {
  assertEquals(reason(report()), null)
  assertEquals(
    reason({
      type: 'backup-run-report',
      id: 'run_2',
      policyId: POLICY_ID,
      runId: 'run_2',
      startedAt: '2026-09-30T03:00:00.000Z',
      finishedAt: '2026-09-30T03:00:01.000Z',
      status: 'failed',
      error: 'engine is busy',
      at: '2026-09-30T03:00:02.000Z',
    }),
    null
  )
})

test('malformed fields are rejected at the frame', () => {
  const cases: [Record<string, unknown>, string][] = [
    [{ policyId: POLICY_ID.toUpperCase() }, 'invalid policyId'],
    [{ policyId: 'not-a-uuid' }, 'invalid policyId'],
    [{ runId: 'run/../../etc' }, 'invalid runId'],
    [{ runId: 'r'.repeat(65) }, 'invalid runId'],
    [{ startedAt: 'yesterday' }, 'invalid startedAt'],
    [{ finishedAt: 42 }, 'invalid finishedAt'],
    [{ status: 'partial' }, 'invalid status'],
    [{ nextRunAt: 'soon' }, 'invalid nextRunAt'],
    [{ error: 'x'.repeat(MAX_DAEMON_WS_ERROR_CHARS + 1) }, 'error exceeds max length'],
    [{ backupId: 'bk 1' }, 'invalid backupId'],
    [{ sizeBytes: -1 }, 'invalid sizeBytes'],
    [{ sizeBytes: 1.5 }, 'invalid sizeBytes'],
    [{ sizeBytes: Number.MAX_SAFE_INTEGER + 2 }, 'invalid sizeBytes'],
    [{ checksum: 'F'.repeat(64) }, 'invalid checksum'],
    [{ checksum: 'f'.repeat(63) }, 'invalid checksum'],
    [{ path: 'p'.repeat(MAX_DAEMON_WS_BACKUP_PATH_CHARS + 1) }, 'invalid path'],
    [{ pruned: 'bk_old' }, 'invalid pruned'],
    [{ pruned: ['bk_ok', 'bk/../x'] }, 'invalid pruned'],
    [
      { pruned: Array.from({ length: MAX_DAEMON_WS_BACKUP_PRUNED + 1 }, () => 'bk') },
      'invalid pruned',
    ],
  ]
  for (const [overrides, expected] of cases) {
    assertEquals(reason(report(overrides)), expected, JSON.stringify(overrides).slice(0, 80))
  }
})

test('a report is daemon-initiated: it never completes a pending request envelope', () => {
  const result = validateDaemonInboundFrame(JSON.stringify(report()))
  assert(result.ok)
  assertEquals(wireMessageToInboundEnvelope(result.message), null)
})
