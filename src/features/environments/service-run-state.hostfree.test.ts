import { assertEquals } from '@std/assert'
import { buildServiceRunStateViews, toServiceRunStateView } from './service-run-state.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const AS_OF = '2026-10-04T12:00:00.000Z'

function report(serviceId: string, state: string, restartCount = 0, lastError?: string) {
  return {
    serviceId,
    state,
    restartCount,
    asOf: AS_OF,
    ...(lastError ? { lastError } : {}),
  }
}

test('toServiceRunStateView spells out running and nulls a missing error', () => {
  assertEquals(
    toServiceRunStateView({
      serviceId: 's',
      state: 'running',
      restartCount: 0,
      asOf: AS_OF,
    }),
    {
      state: 'running',
      running: true,
      restartCount: 0,
      lastError: null,
      asOf: AS_OF,
    }
  )
  assertEquals(
    toServiceRunStateView({
      serviceId: 's',
      state: 'starting',
      restartCount: 1,
      asOf: AS_OF,
    }).running,
    false
  )
})

test('a service takes its report from the server that holds its container', () => {
  const views = buildServiceRunStateViews(
    [{ serviceId: 'web', serverId: 'srv-1' }],
    [
      {
        id: 'srv-1',
        metadata: {
          services: [report('web', 'crashing', 4, 'boom'), report('api', 'running')],
        },
      },
      { id: 'srv-2', metadata: { services: [report('web', 'running')] } },
    ]
  )
  assertEquals(views.get('web'), {
    state: 'crashing',
    running: false,
    restartCount: 4,
    lastError: 'boom',
    asOf: AS_OF,
  })
  assertEquals(views.has('api'), false)
})

test('a service on several servers shows its worst state', () => {
  const views = buildServiceRunStateViews(
    [
      { serviceId: 'web', serverId: 'srv-1' },
      { serviceId: 'web', serverId: 'srv-2' },
    ],
    [
      { id: 'srv-1', metadata: { services: [report('web', 'running')] } },
      {
        id: 'srv-2',
        metadata: {
          services: [report('web', 'stopped_after_crashes', 10, 'boom')],
        },
      },
    ]
  )
  assertEquals(views.get('web')?.state, 'stopped_after_crashes')
  assertEquals(views.get('web')?.running, false)
})

test('a service nobody has reported is absent, not defaulted', () => {
  assertEquals(
    buildServiceRunStateViews(
      [{ serviceId: 'web', serverId: 'srv-1' }],
      [
        { id: 'srv-1', metadata: null },
        { id: 'srv-9', metadata: { services: 'garbage' } },
      ]
    ).size,
    0
  )
  assertEquals(
    buildServiceRunStateViews(
      [{ serviceId: 'web', serverId: 'srv-1' }],
      [{ id: 'srv-1', metadata: { services: [] } }]
    ).size,
    0
  )
})
