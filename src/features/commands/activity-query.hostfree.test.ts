import { assertEquals } from '@std/assert'
import {
  ACTIVITY_DEFAULT_LIMIT,
  ACTIVITY_MAX_LIMIT,
  activityActionOf,
  parseActivityQuery,
  shapeActivityItem,
} from './activity-query.ts'

const test = Deno.test.bind(Deno)
const NOW = new Date('2026-10-04T12:10:00.000Z')

test('parseActivityQuery defaults to all, 50, offset 0', () => {
  assertEquals(parseActivityQuery({}), {
    ok: true,
    query: { filter: 'all', limit: ACTIVITY_DEFAULT_LIMIT, offset: 0 },
  })
})

test('parseActivityQuery clamps limit to 100 and rejects malformed numbers', () => {
  assertEquals(parseActivityQuery({ limit: '5000' }), {
    ok: true,
    query: { filter: 'all', limit: ACTIVITY_MAX_LIMIT, offset: 0 },
  })
  for (const limit of ['0', '-1', 'abc', '1.5']) {
    assertEquals(parseActivityQuery({ limit }), { ok: false, error: 'Invalid limit' })
  }
  for (const offset of ['-1', 'x', '1e3']) {
    assertEquals(parseActivityQuery({ offset }), { ok: false, error: 'Invalid offset' })
  }
})

test('parseActivityQuery accepts the served filters and refuses the rest', () => {
  for (const filter of ['all', 'deploying', 'failed']) {
    assertEquals(parseActivityQuery({ filter, offset: '20' }).ok, true)
  }
  // crash states are not served: no restart count is recorded
  for (const filter of ['crashing', 'crashed', 'DEPLOYING', 'x']) {
    assertEquals(parseActivityQuery({ filter }), { ok: false, error: 'Invalid filter' })
  }
})

test('activityActionOf names deploy and stop, and reads the lifecycle action', () => {
  assertEquals(activityActionOf('environment.deploy', null), 'deploy')
  assertEquals(activityActionOf('environment.stop', {}), 'stop')
  assertEquals(activityActionOf('environment.lifecycle', { action: 'start' }), 'start')
  assertEquals(activityActionOf('environment.lifecycle', { action: 'restart' }), 'restart')
  assertEquals(activityActionOf('environment.lifecycle', { action: 'rm -rf' }), 'restart')
  assertEquals(activityActionOf('environment.lifecycle', null), 'restart')
})

const BASE = {
  id: 'c1',
  serverId: 's1',
  name: 'environment.deploy',
  status: 'running',
  context: { environmentId: 'e1' },
  errorMessage: 'ignored while running',
  createdAt: '2026-10-04T12:00:00.000Z',
  queuedAt: '2026-10-04T12:00:01.000Z',
  startedAt: '2026-10-04T12:08:00.000Z',
  finishedAt: null,
}
const NAMES = new Map([['e1', { name: 'Production', projectId: 'p1', projectName: 'My App' }]])

test('shapeActivityItem: an in-progress deploy runs against now and hides the error', () => {
  assertEquals(shapeActivityItem(BASE, NAMES, NOW), {
    id: 'c1',
    projectId: 'p1',
    projectName: 'My App',
    environmentId: 'e1',
    environmentName: 'Production',
    serverId: 's1',
    action: 'deploy',
    state: 'deploying',
    startedAt: '2026-10-04T12:08:00.000Z',
    step: null,
    totalSteps: null,
    durationSecs: 120,
    errorMessage: null,
    crashCount: null,
  })
})

test('shapeActivityItem: a failed command freezes its duration and shows the error', () => {
  const item = shapeActivityItem(
    {
      ...BASE,
      status: 'timed_out',
      startedAt: null,
      finishedAt: '2026-10-04T12:03:00.000Z',
      errorMessage: 'no outcome',
    },
    NAMES,
    NOW
  )
  assertEquals(item.state, 'failed')
  assertEquals(item.startedAt, '2026-10-04T12:00:01.000Z')
  assertEquals(item.durationSecs, 179)
  assertEquals(item.errorMessage, 'no outcome')
})

test('shapeActivityItem: an environment outside the organization resolves to null names', () => {
  const item = shapeActivityItem(BASE, new Map(), NOW)
  assertEquals(
    [item.projectId, item.projectName, item.environmentId, item.environmentName],
    [null, null, null, null]
  )
})
