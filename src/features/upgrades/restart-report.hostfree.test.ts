import { assertEquals } from '@std/assert'
import { stepDetail } from './decisions.ts'
import {
  describeRestartPending,
  readRestartPending,
  readServerSnapshot,
  RESTART_RECOVERED_NOTE,
  sanitizeRestartReport,
  withRestartPending,
  withRestartRecovered,
  withServerSnapshot,
} from './restart-report.ts'

const test = Deno.test.bind(Deno)

test('the restart report keeps only known, bounded fields and strips control characters and URL secrets', () => {
  const report = sanitizeRestartReport({
    command: 'restart',
    exitCode: 1,
    stderr: `line one\nline two https://user:secret@example.test/x${'z'.repeat(900)}`,
    attempts: 2,
    elapsedMs: 31,
    extra: 'dropped',
  })
  assertEquals(report?.command, 'restart')
  assertEquals(report?.exitCode, 1)
  assertEquals(report?.attempts, 2)
  assertEquals(report?.stderr?.includes('\n'), false)
  assertEquals(report?.stderr?.includes('secret'), false)
  assertEquals((report?.stderr?.length ?? 0) <= 500, true)
  assertEquals('extra' in (report ?? {}), false)
})

test('a report without the counters is ignored, never half-trusted', () => {
  assertEquals(sanitizeRestartReport({ exitCode: 1 }), null)
  assertEquals(sanitizeRestartReport('exit 1'), null)
  assertEquals(sanitizeRestartReport({ attempts: Number.NaN, elapsedMs: 1 }), null)
})

test('a second report keeps the first time and the diagnostics it already had', () => {
  const first = withRestartPending(
    {},
    {
      at: '2026-10-22T10:00:00.000Z',
      message: 'first',
      restart: { attempts: 1, elapsedMs: 5, exitCode: 143 },
    }
  )
  const second = withRestartPending(first, { at: '2026-10-22T10:00:09.000Z', message: 'second' })
  assertEquals(readRestartPending(second), {
    at: '2026-10-22T10:00:00.000Z',
    message: 'first',
    restart: { attempts: 1, elapsedMs: 5, exitCode: 143 },
  })
})

test('a bare message gets the diagnostics appended once, a detailed one is left alone', () => {
  const restart = { command: 'restart', exitCode: 1, stderr: 'boom', attempts: 2, elapsedMs: 40 }
  assertEquals(
    describeRestartPending({ at: 'x', message: 'daemon restart failed after reconcile', restart }),
    'daemon restart failed after reconcile (systemctl restart exited 1, stderr: boom; 2 tries, 40 ms)'
  )
  const detailed = 'daemon restart failed after reconcile (systemctl restart exited 1, 2 tries)'
  assertEquals(describeRestartPending({ at: 'x', message: detailed, restart }), detailed)
})

test('the saved step detail keeps the hold, the note and the server snapshot, and drops anything else', () => {
  const held = withRestartPending(
    withServerSnapshot({ junk: 1 }, { serverName: 'w', serverHostname: 'w.lan' }),
    {
      at: '2026-10-22T10:00:00.000Z',
      message: 'm',
    }
  )
  assertEquals(stepDetail(held), {
    restartPending: { at: '2026-10-22T10:00:00.000Z', message: 'm' },
    serverName: 'w',
    serverHostname: 'w.lan',
  })
  const recovered = stepDetail(withRestartRecovered(held))
  assertEquals(recovered.restartNote, RESTART_RECOVERED_NOTE)
  assertEquals(readServerSnapshot(recovered), { serverName: 'w', serverHostname: 'w.lan' })
})
