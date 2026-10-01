import { assert, assertEquals } from '@std/assert'
import { resultSummaryForPersist } from './result-summary.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('result summary keeps only the listed fields of a ping result', () => {
  const stored = resultSummaryForPersist('daemon.ping', {
    daemonHostname: 'h1',
    cellDispatchedAt: '2026-01-01T00:00:00.000Z',
    leaked: 'nope',
  })
  assertEquals(stored, {
    daemonHostname: 'h1',
    cellDispatchedAt: '2026-01-01T00:00:00.000Z',
  })
})

test('result summary drops unlisted fields from a deploy result', () => {
  const stored = resultSummaryForPersist('environment.deploy', {
    projectName: 'shop',
    summary: 'ok',
    services: ['web'],
    envFileContents: 'SECRET=1',
  }) as Record<string, unknown>
  assertEquals(stored.projectName, 'shop')
  assertEquals(stored.summary, 'ok')
  assertEquals(stored.services, ['web'])
  assert(!('envFileContents' in stored))
})

test('result summary is null when the report does not fit its command type', () => {
  assertEquals(resultSummaryForPersist('server.hostname.set', { observedHostname: '' }), null)
  assertEquals(resultSummaryForPersist('server.hostname.set', 'not an object'), null)
})

test('result summary is null for an unknown command type', () => {
  assertEquals(resultSummaryForPersist('server.mystery', { a: 1 }), null)
})
