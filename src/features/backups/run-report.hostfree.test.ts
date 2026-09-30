/**
 * Host-free coverage for `handleBackupRunReport`: which reports are believed,
 * which are refused for good, and that a store failure escapes (no answer).
 */

import { assert, assertEquals, assertRejects } from '@std/assert'
import type { BackupRunReportMessage } from '../../contracts/cell-protocol.ts'
import {
  type BackupPolicyTarget,
  type BackupRunRecord,
  type BackupRunReportStore,
  backupRunReportResultMessage,
  handleBackupRunReport,
  MAX_BACKUP_RUN_ERROR_CHARS,
} from './run-report.ts'
import { forEachSequential } from '../../lib/sequential.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const POLICY_ID = '0192a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6b'
const MANAGED_ID = '0192a3b4-c5d6-7e8f-9a0b-aaaaaaaaaaaa'
const SERVER_A = '0192a3b4-c5d6-7e8f-9a0b-000000000001'
const SERVER_B = '0192a3b4-c5d6-7e8f-9a0b-000000000002'
const BACKUP_ID = 'bk_0123456789abcdef0123456789abcdef'
const CHECKSUM = 'a'.repeat(64)

function succeeded(overrides: Partial<BackupRunReportMessage> = {}): BackupRunReportMessage {
  return {
    type: 'backup-run-report',
    id: 'run_1',
    policyId: POLICY_ID,
    runId: 'run_1',
    startedAt: '2026-09-30T03:00:00.000Z',
    finishedAt: '2026-09-30T03:00:05.000Z',
    status: 'succeeded',
    backupId: BACKUP_ID,
    sizeBytes: 1024,
    checksum: CHECKSUM,
    path: `/backup/${MANAGED_ID}/policy-${POLICY_ID}/${BACKUP_ID}.dump`,
    at: '2026-09-30T03:00:06.000Z',
    ...overrides,
  }
}

function failed(overrides: Partial<BackupRunReportMessage> = {}): BackupRunReportMessage {
  return {
    type: 'backup-run-report',
    id: 'run_2',
    policyId: POLICY_ID,
    runId: 'run_2',
    startedAt: '2026-09-30T03:00:00.000Z',
    finishedAt: '2026-09-30T03:00:01.000Z',
    status: 'failed',
    error: 'engine is busy',
    at: '2026-09-30T03:00:02.000Z',
    ...overrides,
  }
}

const MANAGED_ON_A: BackupPolicyTarget = {
  targetKind: 'managed',
  managedId: MANAGED_ID,
  managedServerId: SERVER_A,
}

function fakeStore(target: BackupPolicyTarget | undefined): {
  store: BackupRunReportStore
  recorded: BackupRunRecord[]
} {
  const recorded: BackupRunRecord[] = []
  return {
    recorded,
    store: {
      loadPolicyTarget: () => Promise.resolve(target),
      recordRun: (record) => {
        recorded.push(record)
        return Promise.resolve()
      },
    },
  }
}

async function outcomeOf(
  report: BackupRunReportMessage,
  target: BackupPolicyTarget | undefined = MANAGED_ON_A,
  reporterServerId = SERVER_A
) {
  const { store, recorded } = fakeStore(target)
  const outcome = await handleBackupRunReport(store, report, { reporterServerId })
  return { outcome, recorded }
}

test('a succeeded run from the engine’s own server is recorded with its artifact', async () => {
  const { outcome, recorded } = await outcomeOf(
    succeeded({ pruned: ['bk_old1', 'bk_old2'], nextRunAt: '2026-10-01T03:00:00.000Z' })
  )
  assertEquals(outcome, { ok: true })
  assertEquals(recorded.length, 1)
  assertEquals(recorded[0], {
    policyId: POLICY_ID,
    managedId: MANAGED_ID,
    serverId: SERVER_A,
    runId: 'run_1',
    startedAt: '2026-09-30T03:00:00.000Z',
    finishedAt: '2026-09-30T03:00:05.000Z',
    status: 'succeeded',
    pruned: ['bk_old1', 'bk_old2'],
    nextRunAt: '2026-10-01T03:00:00.000Z',
    artifact: {
      backupId: BACKUP_ID,
      sizeBytes: 1024,
      checksum: CHECKSUM,
      path: `/backup/${MANAGED_ID}/policy-${POLICY_ID}/${BACKUP_ID}.dump`,
    },
  })
})

test('a failed run is recorded without an artifact, its error trimmed', async () => {
  const { outcome, recorded } = await outcomeOf(
    failed({ error: 'x'.repeat(MAX_BACKUP_RUN_ERROR_CHARS + 50) })
  )
  assertEquals(outcome, { ok: true })
  assertEquals(recorded[0]?.artifact, undefined)
  assertEquals(recorded[0]?.error?.length, MAX_BACKUP_RUN_ERROR_CHARS)
})

test('an unknown policy is refused and nothing is written', async () => {
  const { store, recorded } = fakeStore(undefined)
  const outcome = await handleBackupRunReport(store, succeeded(), { reporterServerId: SERVER_A })
  assertEquals(outcome, { ok: false, error: 'unknown backup policy' })
  assertEquals(recorded.length, 0)
})

test('a storage-copy policy is refused until copy targets are supported', async () => {
  const { outcome, recorded } = await outcomeOf(succeeded(), {
    targetKind: 'copy',
    managedId: null,
    managedServerId: null,
  })
  assertEquals(outcome, { ok: false, error: 'storage-copy backups are not accepted yet' })
  assertEquals(recorded.length, 0)
})

test('a report from a server other than the engine’s placement is refused', async () => {
  const { outcome, recorded } = await outcomeOf(succeeded(), MANAGED_ON_A, SERVER_B)
  assertEquals(outcome, {
    ok: false,
    error: 'the policy targets an engine placed on another server',
  })
  assertEquals(recorded.length, 0)
})

test('an engine with no placement server believes no one', async () => {
  const { outcome } = await outcomeOf(succeeded(), { ...MANAGED_ON_A, managedServerId: null })
  assertEquals(outcome.ok, false)
})

test('inconsistent runs are refused before the database is asked', async () => {
  const cases: [BackupRunReportMessage, string][] = [
    [succeeded({ finishedAt: '2026-09-30T02:59:59.000Z' }), 'finishedAt is before startedAt'],
    [failed({ backupId: BACKUP_ID }), 'a failed run cannot report an artifact'],
    [succeeded({ checksum: undefined }), 'a succeeded run must report its artifact'],
    [succeeded({ pruned: [BACKUP_ID] }), 'a run cannot prune the artifact it made'],
  ]
  await forEachSequential(cases, async ([report, error]) => {
    let asked = false
    const store: BackupRunReportStore = {
      loadPolicyTarget: () => {
        asked = true
        return Promise.resolve(MANAGED_ON_A)
      },
      recordRun: () => Promise.resolve(),
    }
    assertEquals(await handleBackupRunReport(store, report, { reporterServerId: SERVER_A }), {
      ok: false,
      error,
    })
    assertEquals(asked, false, error)
  })
})

test('the artifact must sit in this policy’s own directory for this engine', async () => {
  const otherEngine = '0192a3b4-c5d6-7e8f-9a0b-bbbbbbbbbbbb'
  const otherPolicy = '0192a3b4-c5d6-7e8f-9a0b-cccccccccccc'
  const cases: [string, string][] = [
    [`/backup/${otherEngine}/policy-${POLICY_ID}/${BACKUP_ID}.dump`, 'outside'],
    [`/backup/${MANAGED_ID}/policy-${otherPolicy}/${BACKUP_ID}.dump`, 'outside'],
    [`/backup/${MANAGED_ID}/${BACKUP_ID}.dump`, 'outside'],
    [`/backup/${MANAGED_ID}/policy-${POLICY_ID}/${BACKUP_ID}.exe`, 'extension'],
    [`relative/${MANAGED_ID}/policy-${POLICY_ID}/${BACKUP_ID}.dump`, 'invalid'],
    [`/backup/${MANAGED_ID}/policy-${POLICY_ID}/${BACKUP_ID}.dump\nx`, 'invalid'],
  ]
  await forEachSequential(cases, async ([path, fragment]) => {
    const { outcome, recorded } = await outcomeOf(succeeded({ path }))
    assert(!outcome.ok && outcome.error.includes(fragment), `${path}: ${JSON.stringify(outcome)}`)
    assertEquals(recorded.length, 0)
  })
})

test('a store failure escapes so no answer is sent and the daemon resends', async () => {
  const store: BackupRunReportStore = {
    loadPolicyTarget: () => Promise.resolve(MANAGED_ON_A),
    recordRun: () => Promise.reject(new Error('database unavailable')),
  }
  await assertRejects(
    () => handleBackupRunReport(store, succeeded(), { reporterServerId: SERVER_A }),
    Error,
    'database unavailable'
  )
})

test('the answer carries the report id, ok, and the refusal reason', () => {
  assertEquals(backupRunReportResultMessage('run_1', { ok: true }, '2026-09-30T03:00:07.000Z'), {
    type: 'backup-run-report-result',
    id: 'run_1',
    ok: true,
    at: '2026-09-30T03:00:07.000Z',
  })
  assertEquals(
    backupRunReportResultMessage(
      'run_1',
      { ok: false, error: 'unknown backup policy' },
      '2026-09-30T03:00:07.000Z'
    ),
    {
      type: 'backup-run-report-result',
      id: 'run_1',
      ok: false,
      error: 'unknown backup policy',
      at: '2026-09-30T03:00:07.000Z',
    }
  )
})
