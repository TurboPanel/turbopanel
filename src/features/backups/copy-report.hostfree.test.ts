import { assertEquals } from '@std/assert'
import type { BackupCopyReportMessage } from '../../contracts/cell-protocol.ts'
import {
  backupCopyReportResultMessage,
  type BackupCopyReportStore,
  handleBackupCopyReport,
} from './copy-report.ts'
import type { CopyReportRecord } from './copy-records.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const SERVER = '00000000-0000-4000-8000-000000000001'
const OTHER_SERVER = '00000000-0000-4000-8000-000000000002'
const ORG = '00000000-0000-4000-8000-0000000000a1'
const OTHER_ORG = '00000000-0000-4000-8000-0000000000a2'

function message(over: Partial<BackupCopyReportMessage> = {}): BackupCopyReportMessage {
  return {
    type: 'backup-copy-report',
    id: 'a'.repeat(32),
    targetId: '00000000-0000-4000-8000-0000000000c1',
    managedId: '00000000-0000-4000-8000-0000000000b1',
    backupId: 'bk_1',
    state: 'copied',
    objectKey: 'tp/managed/x/manual/bk_1.dump',
    sizeBytes: 10,
    attempts: 1,
    finishedAt: '2026-10-21T03:00:00.000Z',
    at: '2026-10-21T03:00:01.000Z',
    ...over,
  }
}

function store(
  over: Partial<{
    engine: Awaited<ReturnType<BackupCopyReportStore['loadEngine']>>
    target: Awaited<ReturnType<BackupCopyReportStore['loadTarget']>>
  }> = {}
): { store: BackupCopyReportStore; recorded: CopyReportRecord[] } {
  const recorded: CopyReportRecord[] = []
  const engine = 'engine' in over ? over.engine : { serverId: SERVER, organizationId: ORG }
  const target = 'target' in over ? over.target : { organizationId: ORG, name: 'Offsite' }
  return {
    recorded,
    store: {
      loadEngine: () => Promise.resolve(engine),
      loadTarget: () => Promise.resolve(target),
      record: (r) => {
        recorded.push(r)
        return Promise.resolve()
      },
    },
  }
}

test('a report for an engine on the reporting server is recorded with the target name', async () => {
  const { store: s, recorded } = store()
  assertEquals(await handleBackupCopyReport(s, message(), { reporterServerId: SERVER }), {
    ok: true,
  })
  assertEquals(recorded.length, 1)
  assertEquals(recorded[0]!.targetName, 'Offsite')
  assertEquals(recorded[0]!.state, 'copied')
})

test('a failed report keeps a bounded reason', async () => {
  const { store: s, recorded } = store()
  const outcome = await handleBackupCopyReport(
    s,
    message({ state: 'failed', objectKey: undefined, error: 'x'.repeat(5000) }),
    { reporterServerId: SERVER }
  )
  assertEquals(outcome, { ok: true })
  assertEquals(recorded[0]!.error?.length, 1000)
})

test('reports are refused for another server, another organization, or a missing engine or target', async () => {
  for (const [label, setup, reporter] of [
    ['engine on another server', store(), OTHER_SERVER],
    ['missing engine', store({ engine: undefined }), SERVER],
    ['missing target', store({ target: undefined }), SERVER],
    ['other organization', store({ target: { organizationId: OTHER_ORG, name: 'x' } }), SERVER],
  ] as const) {
    const outcome = await handleBackupCopyReport(setup.store, message(), {
      reporterServerId: reporter,
    })
    assertEquals(outcome.ok, false, label)
    assertEquals(setup.recorded.length, 0, label)
  }
})

test('inconsistent reports are refused before the database is asked', async () => {
  const { store: s, recorded } = store()
  for (const bad of [
    message({ objectKey: undefined }),
    message({ error: 'copied but with an error' }),
    message({ pruned: ['bk_1'] }),
    message({ state: 'failed' }),
  ]) {
    assertEquals((await handleBackupCopyReport(s, bad, { reporterServerId: SERVER })).ok, false)
  }
  assertEquals(recorded.length, 0)
})

test('the answer carries the id and the reason', () => {
  assertEquals(backupCopyReportResultMessage('id1', { ok: true }, 'now'), {
    type: 'backup-copy-report-result',
    id: 'id1',
    ok: true,
    at: 'now',
  })
  assertEquals(backupCopyReportResultMessage('id1', { ok: false, error: 'no' }, 'now').error, 'no')
})
