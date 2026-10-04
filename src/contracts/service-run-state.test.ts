import { assertEquals } from '@std/assert'
import {
  MAX_SERVICE_LAST_ERROR_CHARS,
  MAX_SERVICE_RUN_STATES,
  parseServiceRunStates,
  type ServiceRunState,
  serviceRunStatesEqual,
  worstServiceRunState,
} from './service-run-state.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const AS_OF = '2026-10-04T12:00:00.000Z'

function entry(overrides: Partial<ServiceRunState> = {}): ServiceRunState {
  return {
    serviceId: 'svc-1',
    state: 'running',
    restartCount: 0,
    asOf: AS_OF,
    ...overrides,
  }
}

test('parseServiceRunStates keeps a well-formed list', () => {
  const wire = [
    entry(),
    entry({
      serviceId: 'svc-2',
      state: 'crashing',
      restartCount: 4,
      lastError: 'boom',
    }),
  ]
  assertEquals(parseServiceRunStates(wire), wire)
})

test('parseServiceRunStates tells "nothing sent" from "no services"', () => {
  assertEquals(parseServiceRunStates(undefined), undefined)
  assertEquals(parseServiceRunStates('nope'), undefined)
  assertEquals(parseServiceRunStates({}), undefined)
  assertEquals(parseServiceRunStates([]), [])
})

test('parseServiceRunStates drops malformed and duplicate entries instead of failing', () => {
  const parsed = parseServiceRunStates([
    entry(),
    entry({ state: 'exploded' as ServiceRunState['state'] }),
    {
      serviceId: 'svc-3',
      state: 'running',
      restartCount: 0,
      asOf: 'not a date',
    },
    { serviceId: '', state: 'running', restartCount: 0, asOf: AS_OF },
    { serviceId: 'has space', state: 'running', restartCount: 0, asOf: AS_OF },
    null,
    'x',
    entry({ restartCount: 9 }),
  ])
  assertEquals(parsed, [entry()])
})

test('parseServiceRunStates normalizes counts and caps the error line', () => {
  const parsed = parseServiceRunStates([
    { ...entry(), restartCount: -3 },
    {
      ...entry({ serviceId: 'svc-2' }),
      restartCount: 2.9,
      lastError: 'x'.repeat(MAX_SERVICE_LAST_ERROR_CHARS + 50),
    },
    { ...entry({ serviceId: 'svc-3' }), restartCount: 'many', lastError: '' },
  ])
  assertEquals(parsed?.[0]?.restartCount, 0)
  assertEquals(parsed?.[1]?.restartCount, 2)
  assertEquals(parsed?.[1]?.lastError?.length, MAX_SERVICE_LAST_ERROR_CHARS)
  assertEquals(parsed?.[2]?.restartCount, 0)
  assertEquals('lastError' in (parsed?.[2] ?? {}), false)
})

test('parseServiceRunStates caps the list length', () => {
  const wire = Array.from({ length: MAX_SERVICE_RUN_STATES + 25 }, (_, i) =>
    entry({ serviceId: `svc-${i}` })
  )
  assertEquals(parseServiceRunStates(wire)?.length, MAX_SERVICE_RUN_STATES)
})

test('serviceRunStatesEqual treats missing and empty as the same', () => {
  assertEquals(serviceRunStatesEqual(undefined, []), true)
  assertEquals(serviceRunStatesEqual([entry()], [entry()]), true)
  assertEquals(serviceRunStatesEqual([entry()], [entry({ restartCount: 1 })]), false)
})

test('worstServiceRunState picks stopped-after-crashes over crashing over running', () => {
  assertEquals(worstServiceRunState([]), undefined)
  const worst = worstServiceRunState([
    entry({ state: 'running' }),
    entry({ state: 'stopped_after_crashes', restartCount: 10 }),
    entry({ state: 'crashing' }),
  ])
  assertEquals(worst?.state, 'stopped_after_crashes')
})
