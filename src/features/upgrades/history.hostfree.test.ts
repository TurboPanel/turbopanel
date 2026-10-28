import { assertEquals } from '@std/assert'
import {
  durationMs,
  escapeLikePattern,
  isoOrNull,
  outcomeFromRank,
  outcomeRank,
  parseHistoryQuery,
  parseRunServersQuery,
  runTrigger,
  serverOutcome,
  stepOutcome,
  summaryFromOutcomes,
  summaryFromStoredCounts,
  UPGRADE_SERVER_OUTCOMES,
} from './history.ts'
import { UPGRADE_STATUSES, UPGRADE_TERMINAL_STATUSES } from './vocabulary.ts'

/** Jest/Mocha-shaped alias so Sonar sees real tests (typescript:S2187). */
const test = Deno.test.bind(Deno)

test('a step the run never had to send reads as already current, not updated', () => {
  assertEquals(stepOutcome({ status: 'done', attempts: 0 }), 'already_current')
  assertEquals(stepOutcome({ status: 'done', attempts: 1 }), 'updated')
  assertEquals(stepOutcome({ status: 'done', attempts: 3 }), 'updated')
})

test('failed, rolled back and needs-attention steps all read as failed', () => {
  for (const status of ['failed', 'rolled_back', 'needs_attention'] as const) {
    assertEquals(stepOutcome({ status, attempts: 1 }), 'failed')
  }
})

test('skipped stays skipped and every open status is in progress', () => {
  assertEquals(stepOutcome({ status: 'skipped', attempts: 0 }), 'skipped')
  for (const status of [
    'pending',
    'waiting',
    'dispatched',
    'preparing',
    'downloading',
    'installing',
    'restarting',
    'verifying',
  ] as const) {
    assertEquals(stepOutcome({ status, attempts: 0 }), 'in_progress')
  }
})

test('a server takes the worst outcome of its steps', () => {
  assertEquals(
    serverOutcome([
      { status: 'done', attempts: 1 },
      { status: 'needs_attention', attempts: 3 },
    ]),
    'failed'
  )
  assertEquals(
    serverOutcome([
      { status: 'done', attempts: 0 },
      { status: 'done', attempts: 1 },
    ]),
    'updated'
  )
  assertEquals(
    serverOutcome([
      { status: 'done', attempts: 0 },
      { status: 'done', attempts: 0 },
    ]),
    'already_current'
  )
  assertEquals(
    serverOutcome([
      { status: 'done', attempts: 1 },
      { status: 'installing', attempts: 1 },
    ]),
    'in_progress'
  )
  assertEquals(serverOutcome([]), 'in_progress')
})

test('outcome ranks round-trip and put failed first', () => {
  assertEquals(outcomeRank('failed'), 0)
  for (const outcome of UPGRADE_SERVER_OUTCOMES) {
    assertEquals(outcomeFromRank(outcomeRank(outcome)), outcome)
  }
  assertEquals(outcomeFromRank(99), 'in_progress')
})

test('only the maintenance tick is an automatic trigger', () => {
  assertEquals(runTrigger('auto'), 'automatic')
  assertEquals(runTrigger('manual'), 'manual')
  assertEquals(runTrigger('server'), 'manual')
})

test('server totals add up and never count an already-current host as updated', () => {
  assertEquals(
    summaryFromOutcomes({ failed: 1, in_progress: 0, skipped: 2, updated: 3, already_current: 4 }),
    {
      detail: 'steps',
      total: 10,
      updated: 3,
      alreadyCurrent: 4,
      skipped: 2,
      failed: 1,
      inProgress: 0,
    }
  )
})

test('a pruned run keeps its stored totals and leaves updated unknown', () => {
  assertEquals(
    summaryFromStoredCounts({
      total: 5,
      done: 3,
      skipped: 1,
      failed: 0,
      needsAttention: 1,
      inProgress: 0,
    }),
    {
      detail: 'pruned',
      total: 5,
      updated: null,
      alreadyCurrent: null,
      skipped: 1,
      failed: 1,
      inProgress: 0,
    }
  )
  assertEquals(summaryFromStoredCounts(null).total, 0)
})

test('history without a status filter keeps the old answer: finished runs only', () => {
  const query = parseHistoryQuery({})
  if ('error' in query) throw new Error('expected a query')
  assertEquals(query.statuses, UPGRADE_TERMINAL_STATUSES)
  assertEquals(query.sources, null)
  assertEquals(query.offset, 0)
  assertEquals(query.limit, 50)
})

test('history filters by any run, active runs, one status and the trigger', () => {
  const any = parseHistoryQuery({ status: 'any', trigger: 'manual', limit: '500', offset: '20' })
  if ('error' in any) throw new Error('expected a query')
  assertEquals(any.statuses, UPGRADE_STATUSES)
  assertEquals(any.sources, ['manual', 'server'])
  assertEquals(any.limit, 100)
  assertEquals(any.offset, 20)
  const active = parseHistoryQuery({ status: 'active', trigger: 'automatic' })
  if ('error' in active) throw new Error('expected a query')
  assertEquals(active.statuses, ['pending', 'running'])
  assertEquals(active.sources, ['auto'])
  const one = parseHistoryQuery({ status: 'failed' })
  if ('error' in one) throw new Error('expected a query')
  assertEquals(one.statuses, ['failed'])
})

test('history refuses an unknown status or trigger', () => {
  assertEquals(parseHistoryQuery({ status: 'done' }), { error: 'invalid_filter', field: 'status' })
  assertEquals(parseHistoryQuery({ trigger: 'cron' }), {
    error: 'invalid_filter',
    field: 'trigger',
  })
})

test('server list defaults to status order, ascending, first page', () => {
  const query = parseRunServersQuery({})
  if ('error' in query) throw new Error('expected a query')
  assertEquals(query.sort, 'status')
  assertEquals(query.dir, 'asc')
  assertEquals(query.outcome, null)
  assertEquals(query.organizationId, null)
  assertEquals(query.serverId, null)
  assertEquals(query.search, null)
})

test('server list reads every filter and trims the search', () => {
  const org = '0199a3b2-1c2d-7e3f-8a4b-5c6d7e8f9a0b'
  const query = parseRunServersQuery({
    sort: 'duration',
    dir: 'desc',
    status: 'already_current',
    organizationId: org.toUpperCase(),
    serverId: org,
    q: `  web-1  `,
  })
  if ('error' in query) throw new Error('expected a query')
  assertEquals(query.sort, 'duration')
  assertEquals(query.dir, 'desc')
  assertEquals(query.outcome, 'already_current')
  assertEquals(query.organizationId, org)
  assertEquals(query.serverId, org)
  assertEquals(query.search, 'web-1')
  const long = parseRunServersQuery({ q: 'x'.repeat(500) })
  if ('error' in long) throw new Error('expected a query')
  assertEquals(long.search?.length, 200)
})

test('server list refuses unknown sorts, statuses and ids', () => {
  assertEquals(parseRunServersQuery({ sort: 'name' }), { error: 'invalid_filter', field: 'sort' })
  assertEquals(parseRunServersQuery({ dir: 'up' }), { error: 'invalid_filter', field: 'dir' })
  assertEquals(parseRunServersQuery({ status: 'done' }), {
    error: 'invalid_filter',
    field: 'status',
  })
  assertEquals(parseRunServersQuery({ organizationId: 'nope' }), {
    error: 'invalid_filter',
    field: 'organizationId',
  })
  assertEquals(parseRunServersQuery({ serverId: '1' }), {
    error: 'invalid_filter',
    field: 'serverId',
  })
})

test('search text is matched literally', () => {
  assertEquals(escapeLikePattern('50%_off\\x'), '50\\%\\_off\\\\x')
})

test('timestamps come back as UTC ISO and durations only when both ends are known', () => {
  assertEquals(isoOrNull('2026-10-27 12:00:00.5+00'), '2026-10-27T12:00:00.500Z')
  assertEquals(isoOrNull('not a time'), null)
  assertEquals(isoOrNull(null), null)
  assertEquals(durationMs('2026-10-27T12:00:00.000Z', '2026-10-27T12:01:30.000Z'), 90_000)
  assertEquals(durationMs(null, '2026-10-27T12:01:30.000Z'), null)
  assertEquals(durationMs('2026-10-27T12:01:30.000Z', '2026-10-27T12:00:00.000Z'), null)
})
