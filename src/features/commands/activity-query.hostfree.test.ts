import { assertEquals } from '@std/assert'
import {
  activityCommitOf,
  activityStateOf,
  activityStepsOf,
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
  for (const filter of ['all', 'deploying', 'succeeded', 'failed']) {
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

test('parseActivityQuery takes optional project and environment ids and refuses non-uuids', () => {
  const projectId = '0192f000-0000-7000-8000-00000000000a'
  const environmentId = '0192F000-0000-7000-8000-00000000000B'
  assertEquals(parseActivityQuery({ projectId, environmentId }), {
    ok: true,
    query: {
      filter: 'all',
      limit: ACTIVITY_DEFAULT_LIMIT,
      offset: 0,
      projectId,
      environmentId: environmentId.toLowerCase(),
    },
  })
  assertEquals(parseActivityQuery({ projectId: 'x' }), { ok: false, error: 'Invalid projectId' })
  assertEquals(parseActivityQuery({ environmentId: "1' or 1=1" }), {
    ok: false,
    error: 'Invalid environmentId',
  })
})

test('activityStateOf names every outcome and how a failure ended', () => {
  const of = (status: string, errorCode: string | null = null) =>
    activityStateOf({ status, errorCode, progress: null })
  assertEquals(of('succeeded'), { state: 'succeeded', failure: null })
  assertEquals(of('cancelled'), { state: 'cancelled', failure: null })
  assertEquals(of('failed'), { state: 'failed', failure: null })
  assertEquals(of('timed_out'), { state: 'failed', failure: 'timed_out' })
  assertEquals(of('failed', 'deploy_rolled_back'), { state: 'failed', failure: 'rolled_back' })
  assertEquals(of('failed', 'deploy_needs_attention'), {
    state: 'failed',
    failure: 'needs_attention',
  })
  assertEquals(of('queued'), { state: 'queued', failure: null })
  assertEquals(of('running'), { state: 'deploying', failure: null })
})

test('activityCommitOf reads the first recorded release, else the pushed SHA', () => {
  const release = {
    composeServiceName: 'web',
    releaseId: 'r1',
    sourceId: 'src',
    commitSha: 'abc1234def',
    commitMessage: 'Fix the login page',
  }
  assertEquals(activityCommitOf({ releases: [release] }, null), {
    sha: 'abc1234def',
    message: 'Fix the login page',
  })
  const trigger = { kind: 'push' as const, branch: 'main', commitSha: 'fff0000', sourceId: null }
  assertEquals(activityCommitOf({}, trigger), { sha: 'fff0000', message: null })
  assertEquals(activityCommitOf(null, null), null)
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
    failure: null,
    startedAt: '2026-10-04T12:08:00.000Z',
    finishedAt: null,
    step: null,
    totalSteps: null,
    stepLabel: null,
    durationSecs: 120,
    errorMessage: null,
    actorType: 'system',
    actorName: null,
    trigger: null,
    commit: null,
    crashCount: null,
  })
})

test('shapeActivityItem: a succeeded deploy freezes its duration and names the person and push', () => {
  const item = shapeActivityItem(
    {
      ...BASE,
      status: 'succeeded',
      finishedAt: '2026-10-04T12:09:30.000Z',
      actorType: 'user',
      actorId: 'u1',
      errorMessage: 'not shown on success',
    },
    NAMES,
    NOW,
    new Map([['u1', 'Ada Lovelace']])
  )
  assertEquals(
    [item.state, item.finishedAt, item.durationSecs, item.errorMessage, item.actorName],
    ['succeeded', '2026-10-04T12:09:30.000Z', 90, null, 'Ada Lovelace']
  )
  const pushed = shapeActivityItem(
    {
      ...BASE,
      status: 'succeeded',
      finishedAt: '2026-10-04T12:09:00.000Z',
      actorType: 'system',
      actorId: 'u1',
      metadata: { sourceSelection: { ref: 'refs/heads/main', commitSha: 'abc1234' } },
    },
    NAMES,
    NOW,
    new Map([['u1', 'Ada Lovelace']])
  )
  assertEquals(pushed.actorName, null)
  assertEquals(pushed.trigger?.branch, 'main')
  assertEquals(pushed.commit, { sha: 'abc1234', message: null })
})

test('shapeActivityItem: prefers the environment column over the context copy', () => {
  const item = shapeActivityItem({ ...BASE, environmentId: 'e1', context: {} }, NAMES, NOW)
  assertEquals([item.environmentId, item.environmentName], ['e1', 'Production'])
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
  assertEquals(item.failure, 'timed_out')
  assertEquals(item.startedAt, '2026-10-04T12:00:01.000Z')
  assertEquals(item.durationSecs, 179)
  assertEquals(item.errorMessage, 'no outcome')
})

const PROGRESS = {
  version: 1,
  steps: [
    { id: 'install-docker', label: 'Install Docker', state: 'ready' },
    { id: 'install-build-tool', label: 'Install the build tool', state: 'done' },
    { id: 'fetch', label: 'Fetch the code', state: 'done' },
    { id: 'build', label: 'Build', state: 'running' },
    { id: 'start', label: 'Start the app', state: 'pending' },
  ],
  current: 'build',
  updatedAt: '2026-10-04T12:09:00.000Z',
}

test('activityStepsOf counts done steps plus the running one, never the ready ones', () => {
  assertEquals(activityStepsOf(PROGRESS), { step: 3, totalSteps: 4, stepLabel: 'Build' })
  // Between steps nothing runs: no +1 and no label.
  const between = {
    ...PROGRESS,
    steps: PROGRESS.steps.map((step) => (step.id === 'build' ? { ...step, state: 'done' } : step)),
    current: null,
  }
  assertEquals(activityStepsOf(between), { step: 3, totalSteps: 4, stepLabel: null })
  assertEquals(activityStepsOf(null), { step: null, totalSteps: null, stepLabel: null })
  assertEquals(activityStepsOf({ version: 1 }), { step: null, totalSteps: null, stepLabel: null })
})

test('shapeActivityItem: carries the step plan of a deploying command', () => {
  const item = shapeActivityItem({ ...BASE, progress: PROGRESS }, NAMES, NOW)
  assertEquals([item.step, item.totalSteps, item.stepLabel], [3, 4, 'Build'])
})

test('shapeActivityItem: an environment outside the organization resolves to null names', () => {
  const item = shapeActivityItem(BASE, new Map(), NOW)
  assertEquals(
    [item.projectId, item.projectName, item.environmentId, item.environmentName],
    [null, null, null, null]
  )
})

test('shapeActivityItem: a deploy still in the queue, or waiting on the server, is queued', () => {
  assertEquals(
    shapeActivityItem({ ...BASE, status: 'queued', startedAt: null }, NAMES, NOW).state,
    'queued'
  )
  const waiting = {
    version: 1,
    steps: [],
    current: null,
    updatedAt: NOW.toISOString(),
    runningSince: null,
  }
  assertEquals(
    shapeActivityItem({ ...BASE, status: 'sent', progress: waiting }, NAMES, NOW).state,
    'queued'
  )
})

test('shapeActivityItem: a deploy the server has started is deploying', () => {
  const started = {
    version: 1,
    steps: [],
    current: null,
    updatedAt: NOW.toISOString(),
    runningSince: NOW.toISOString(),
  }
  assertEquals(
    shapeActivityItem({ ...BASE, status: 'sent', progress: started }, NAMES, NOW).state,
    'deploying'
  )
})
