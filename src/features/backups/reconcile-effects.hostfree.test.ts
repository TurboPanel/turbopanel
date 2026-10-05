import { assertEquals, assertThrows } from '@std/assert'
import { reportedNextRuns } from './reconcile-effects.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const A = '0192f1de-7c3b-7e4a-9f10-00000000000a'
const B = '0192f1de-7c3b-7e4a-9f10-00000000000b'
const OTHER = '0192f1de-7c3b-7e4a-9f10-0000000000ff'

function entry(policyId: string) {
  return {
    policyId,
    targetKind: 'managed',
    managedId: '0192f1de-7c3b-7e4a-9f10-000000000001',
    engine: 'postgres',
    artifactExtension: 'dump',
    onCalendar: '*-*-* 03:00:00',
    retentionKeep: 7,
    enabled: true,
  }
}

function result(nextRuns: unknown[]) {
  return { policiesApplied: 2, unitsChanged: [], unitsRemoved: [], nextRuns, warnings: [] }
}

test('reportedNextRuns keeps scheduled policies the command sent', () => {
  const payload = { policies: [entry(A), entry(B)] }
  assertEquals(
    reportedNextRuns(
      payload,
      result([
        { policyId: A, nextRunAt: '2026-10-06T08:25:35.000Z' },
        { policyId: B },
        { policyId: OTHER, nextRunAt: '2026-10-06T09:00:00.000Z' },
      ])
    ),
    [{ policyId: A, nextRunAt: '2026-10-06T08:25:35.000Z' }]
  )
})

test('reportedNextRuns refuses a result that is not the reconcile shape', () => {
  assertThrows(() => reportedNextRuns({ policies: [entry(A)] }, { nextRuns: 'soon' }))
})
