import { assert, assertEquals } from '@std/assert'
import { ALL_GATES_OPEN, type CronGates } from '../../daemon/cell/cron-gates.ts'
import { CRON_CADENCES, resolveJobCadences } from '../../jobs/registry.ts'
import { DAEMON_OFFLINE_SWEEP_MS } from '../../contracts/cell-protocol.ts'
import { createJobTick, type JobTickDeps, type TickJob } from './job-tick.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

/** The first UTC minute of 2026 whose number divides by 15, so `historyPrune` (every 15, offset 0) is due. */
const SLOT_MINUTE = (() => {
  let minute = Math.floor(Date.UTC(2026, 0, 1) / 60_000)
  while (minute % 15 !== 0) minute++
  return minute
})()
const at = (minuteOffset: number): number => (SLOT_MINUTE + minuteOffset) * 60_000

function harness(overrides: Partial<JobTickDeps> & { jobs: readonly TickJob[] }) {
  const clock = { ms: at(0) }
  const events: string[] = []
  let envReads = 0
  const deps: JobTickDeps = {
    loadCadences: () => Promise.resolve({ table: CRON_CADENCES, warnings: [] }),
    readEnv: () => {
      envReads++
      return { KEY: 'value' }
    },
    acquireLease: () => {
      events.push('lease:acquire')
      return Promise.resolve({
        release: () => {
          events.push('lease:release')
          return Promise.resolve()
        },
      })
    },
    loadGates: () => {
      events.push('gates')
      return Promise.resolve(ALL_GATES_OPEN)
    },
    now: () => clock.ms,
    budgetMs: 45_000,
    log: (_level, message) => events.push(`log:${message}`),
    ...overrides,
  }
  return { tick: createJobTick(deps), clock, events, envReads: () => envReads }
}

const job = (
  name: string,
  scope: TickJob['scope'],
  events: string[],
  extra: Partial<TickJob> = {}
): TickJob => ({
  name,
  scope,
  run: () => {
    events.push(`run:${name}`)
    return Promise.resolve()
  },
  ...extra,
})

test('a tick runs the jobs that are due and no others', async () => {
  const events: string[] = []
  const h = harness({
    jobs: [
      job('every tick', 'shared', events),
      job('history', 'shared', events, { due: (ctx) => ctx.isDue('historyPrune') }),
      job('dispatch', 'shared', events, { due: (ctx) => ctx.isDue('commandDispatchCleanup') }),
    ],
  })
  const first = await h.tick.run()
  // Minute SLOT is a `historyPrune` slot (offset 0) and not a `commandDispatchCleanup` one (offset 3).
  assertEquals(first.ran, ['every tick', 'history'])
  h.clock.ms = at(1)
  const second = await h.tick.run()
  assertEquals(second.ran, ['every tick'])
  h.clock.ms = at(3)
  const third = await h.tick.run()
  assertEquals(third.ran, ['every tick', 'dispatch'])
})

test('a gated job is skipped while its flag is closed', async () => {
  const events: string[] = []
  const closed: CronGates = { ...ALL_GATES_OPEN, notificationWork: false }
  const h = harness({
    loadGates: () => Promise.resolve(closed),
    jobs: [
      job('notification retry', 'shared', events, { due: (ctx) => ctx.gates.notificationWork }),
      job('stale commands', 'shared', events, { due: (ctx) => ctx.gates.commandRecoveryWork }),
    ],
  })
  assertEquals((await h.tick.run()).ran, ['stale commands'])
})

test('an unreadable gate read leaves every flag open', async () => {
  const events: string[] = []
  const h = harness({
    loadGates: () => Promise.reject(new Error('db down')),
    jobs: [job('gated', 'shared', events, { due: (ctx) => ctx.gates.tunnels })],
  })
  assertEquals((await h.tick.run()).ran, ['gated'])
})

test('a held lease stops the shared jobs and never stops the local ones', async () => {
  const events: string[] = []
  const h = harness({
    acquireLease: () => Promise.resolve(null),
    loadGates: () => {
      events.push('gates')
      return Promise.resolve(ALL_GATES_OPEN)
    },
    jobs: [job('maintain', 'local', events), job('sweep', 'shared', events)],
  })
  const report = await h.tick.run()
  assertEquals(report.leaseHeld, true)
  assertEquals(report.ran, ['maintain'])
  // No gate statement either: an instance without the lease costs nothing extra.
  assertEquals(events, ['run:maintain'])
})

test('two instances on one lease: only the holder runs the shared jobs', async () => {
  const events: string[] = []
  let holder: string | null = null
  const lease =
    (name: string): JobTickDeps['acquireLease'] =>
    () => {
      if (holder !== null) return Promise.resolve(null)
      holder = name
      return Promise.resolve({
        release: () => {
          holder = null
          return Promise.resolve()
        },
      })
    }
  const a = harness({ acquireLease: lease('a'), jobs: [job('a sweep', 'shared', events)] })
  const b = harness({ acquireLease: lease('b'), jobs: [job('b sweep', 'shared', events)] })
  const [ra, rb] = await Promise.all([a.tick.run(), b.tick.run()])
  assertEquals([ra.leaseHeld, rb.leaseHeld].sort(), [false, true])
  assertEquals(events.length, 1)
  assertEquals(holder, null, 'the lease is released after the tick')
})

test('a lease that cannot be taken skips the shared jobs and is logged', async () => {
  const events: string[] = []
  const h = harness({
    acquireLease: () => Promise.reject(new Error('db down')),
    jobs: [job('maintain', 'local', events), job('sweep', 'shared', events)],
  })
  const report = await h.tick.run()
  assertEquals(report.ran, ['maintain'])
  assert(h.events.some((e) => e.startsWith('log:job tick lease could not be taken')))
})

test('one failing job does not stop the others, and the lease is still released', async () => {
  const events: string[] = []
  const h = harness({
    jobs: [
      job('first', 'shared', events),
      {
        name: 'broken',
        scope: 'shared',
        run: () => Promise.reject(new Error('boom')),
      },
      {
        name: 'throws synchronously',
        scope: 'shared',
        run: () => {
          throw new Error('sync boom')
        },
      },
      job('last', 'shared', events),
    ],
  })
  const report = await h.tick.run()
  assertEquals(report.ran, ['first', 'broken', 'throws synchronously', 'last'])
  assertEquals(report.failed, ['broken', 'throws synchronously'])
  assertEquals(events, ['run:first', 'run:last'])
  assert(h.events.includes('lease:release'))
  assert(h.events.some((e) => e === 'log:job broken failed: boom'))
})

test('a job that finishes after the budget counts as run and a job that is not due is not carried', async () => {
  const events: string[] = []
  const clockRef: { ms: number } = { ms: at(0) }
  let slowRuns = 0
  const h = harness({
    jobs: [
      {
        name: 'slow',
        scope: 'shared',
        due: () => slowRuns === 0,
        run: () => {
          slowRuns++
          // Takes the rest of the budget on the tick's clock.
          clockRef.ms += 80_000
          events.push('run:slow')
          return Promise.resolve()
        },
      },
      job('after', 'shared', events, { due: () => false }),
    ],
    now: () => clockRef.ms,
  })
  // `after` is not due on its own; only a carry could run it.
  const first = await h.tick.run()
  assertEquals(first.ran, ['slow'])
  assertEquals(first.carried, [])
  assertEquals(events, ['run:slow'])
})

test('a due job past the budget is carried and runs first on the next tick', async () => {
  const events: string[] = []
  const clockRef: { ms: number } = { ms: at(0) }
  let tickNumber = 0
  const h = harness({
    jobs: [
      {
        name: 'slow',
        scope: 'shared',
        due: () => tickNumber === 1,
        run: () => {
          clockRef.ms += 80_000
          events.push('run:slow')
          return Promise.resolve()
        },
      },
      job('after', 'shared', events, { due: () => tickNumber === 1 }),
    ],
    now: () => clockRef.ms,
  })
  tickNumber = 1
  const first = await h.tick.run()
  assertEquals(first.carried, ['after'])
  tickNumber = 2
  clockRef.ms = at(2)
  const second = await h.tick.run()
  assertEquals(second.ran, ['after'])
  assertEquals(events, ['run:slow', 'run:after'])
})

test('a job whose earlier run has not settled is not started a second time', async () => {
  const events: string[] = []
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const clockRef = { ms: at(0) }
  const h = harness({
    now: () => clockRef.ms,
    budgetMs: 5,
    jobs: [
      {
        name: 'hung',
        scope: 'shared',
        run: () => {
          events.push('run:hung')
          return gate
        },
      },
    ],
  })
  const first = await h.tick.run()
  assertEquals(first.failed, ['hung'])
  clockRef.ms = at(1)
  const second = await h.tick.run()
  assertEquals(second.carried, ['hung'])
  assertEquals(events, ['run:hung'])
  release()
  await gate
  await Promise.resolve()
  clockRef.ms = at(2)
  const third = await h.tick.run()
  assertEquals(third.ran, ['hung'])
})

test('a tick that starts while the previous one runs does nothing', async () => {
  const events: string[] = []
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const h = harness({
    jobs: [
      {
        name: 'slow',
        scope: 'shared',
        run: async () => {
          events.push('run:slow')
          await gate
        },
      },
    ],
  })
  const first = h.tick.run()
  const overlapped = await h.tick.run()
  assertEquals(overlapped.overlapped, true)
  release()
  await first
  assertEquals(events, ['run:slow'])
})

test('a late tick still runs a job whose slot fell between two ticks', async () => {
  const events: string[] = []
  const h = harness({
    jobs: [job('history', 'shared', events, { due: (ctx) => ctx.isDue('historyPrune') })],
  })
  h.clock.ms = at(-5)
  await h.tick.run()
  assertEquals(events.length, 0)
  // The tick after minute -5 comes at minute +2: the slot at 0 was missed.
  h.clock.ms = at(2)
  assertEquals((await h.tick.run()).ran, ['history'])
  h.clock.ms = at(3)
  assertEquals((await h.tick.run()).ran, [])
})

test('the environment is read once per tick and the cadences once per tick', async () => {
  const events: string[] = []
  let cadenceReads = 0
  const h = harness({
    loadCadences: () => {
      cadenceReads++
      return Promise.resolve({ table: CRON_CADENCES, warnings: [] })
    },
    jobs: [
      job('a', 'shared', events, { due: (ctx) => ctx.env.KEY === 'value' }),
      job('b', 'shared', events, { due: (ctx) => ctx.env.KEY === 'value' }),
    ],
  })
  await h.tick.run()
  assertEquals(h.envReads(), 1)
  assertEquals(cadenceReads, 1)
})

test('an override from the cadence map decides what is due', async () => {
  const events: string[] = []
  const table = resolveJobCadences('{"historyPrune": 1}').table
  const h = harness({
    loadCadences: () => Promise.resolve({ table, warnings: [] }),
    jobs: [job('history', 'shared', events, { due: (ctx) => ctx.isDue('historyPrune') })],
  })
  h.clock.ms = at(1)
  assertEquals((await h.tick.run()).ran, ['history'])
})

test('cadence warnings are logged each tick and a failed read falls back to the defaults', async () => {
  const events: string[] = []
  const warned = harness({
    loadCadences: () => Promise.resolve({ table: CRON_CADENCES, warnings: ['bad value'] }),
    jobs: [job('a', 'shared', events)],
  })
  await warned.tick.run()
  assert(warned.events.includes('log:job cadences: bad value'))
  const failed = harness({
    loadCadences: () => Promise.reject(new Error('settings down')),
    jobs: [job('history', 'shared', events, { due: (ctx) => ctx.isDue('historyPrune') })],
  })
  assertEquals((await failed.tick.run()).ran, ['history'])
})

test('a resource is opened once, shared by the jobs and closed after the tick', async () => {
  const events: string[] = []
  const h = harness({
    jobs: [
      {
        name: 'one',
        scope: 'shared',
        run: (ctx) => {
          ctx.resource(
            'db',
            () => {
              events.push('open')
              return 'client'
            },
            () => {
              events.push('close')
            }
          )
          return Promise.resolve()
        },
      },
      {
        name: 'two',
        scope: 'shared',
        run: (ctx) => {
          assertEquals(
            ctx.resource(
              'db',
              () => 'other',
              () => {}
            ),
            'client'
          )
          events.push('shared')
          return Promise.resolve()
        },
      },
    ],
  })
  await h.tick.run()
  assertEquals(events, ['open', 'shared', 'close'])
})

test('a duplicate job name is refused', () => {
  const events: string[] = []
  let message = ''
  try {
    harness({ jobs: [job('same', 'shared', events), job('same', 'local', events)] })
  } catch (err) {
    message = String(err)
  }
  assert(message.includes('duplicate job name same'))
})

test('the self-hosted server has one timer, the job tick, and none of the old loops', () => {
  const server = Deno.readTextFileSync(new URL('./server.ts', import.meta.url))
  assertEquals(server.match(/\bsetInterval\(/g)?.length, 1)
  assert(server.includes('setInterval(() => void jobTick.run(), JOB_TICK_MS)'))
  assert(server.includes('timers: [jobTickTimer]'))
  for (const gone of [
    'createDenoMaintenanceScheduler',
    'startIngressTimer',
    'LEAF_RENEWAL_SWEEP_INTERVAL_MS',
    'HEARTBEAT_REFRESH_MS',
    'runSystemReconcileSweepTick',
  ]) {
    assertEquals(server.includes(gone), false, `${gone} is still in server.ts`)
  }
})

test('every registry job the self-hosted tick reads exists in the table', () => {
  const server = Deno.readTextFileSync(new URL('./server.ts', import.meta.url))
  const names = new Set<string>(Object.keys(CRON_CADENCES))
  const used = [
    ...server.matchAll(/(?:onCadence\(\s*'[^']+',\s*|isDue\(\s*|reconcile\(\s*)'([A-Za-z]+)'/g),
  ].map((match) => match[1])
  assert(used.length >= 15, `found only ${used.length} registry names; the parser is broken`)
  for (const name of used) assert(names.has(name), `${name} is not in CRON_CADENCES`)
})

test('Workers keeps its 90 second offline threshold and self-hosted its 150 second one', () => {
  // Read as text: importing offline-sweep.ts pulls the Workers-only types into a Deno check.
  const sweep = Deno.readTextFileSync(
    new URL('../../daemon/cell/offline-sweep.ts', import.meta.url)
  )
  assert(sweep.includes('export const OFFLINE_SWEEP_STALE_MS = 90_000'))
  const server = Deno.readTextFileSync(new URL('./server.ts', import.meta.url))
  assert(server.includes('graceMs: DAEMON_OFFLINE_SWEEP_MS'))
  assert(!server.includes('OFFLINE_SWEEP_STALE_MS'))
  assertEquals(DAEMON_OFFLINE_SWEEP_MS, 150_000)
})

/** Lets the settle callbacks of a finished job run. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 10))

test('a job past the budget keeps the lease and the shared client until it settles', async () => {
  const events: string[] = []
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const h = harness({
    budgetMs: 5,
    jobs: [
      {
        name: 'slow',
        scope: 'shared',
        run: (ctx) => {
          ctx.resource(
            'db',
            () => {
              events.push('db:open')
              return {}
            },
            () => {
              events.push('db:close')
            }
          )
          events.push('run:slow')
          return gate
        },
      },
    ],
  })
  const report = await h.tick.run()
  assertEquals(report.failed, ['slow'])
  assertEquals(h.events.includes('lease:release'), false)
  assertEquals(events.includes('db:close'), false)
  release()
  await flush()
  assertEquals(events, ['db:open', 'run:slow', 'db:close'])
  assertEquals(h.events.filter((e) => e === 'lease:release').length, 1)
  assertEquals(h.events.indexOf('lease:release') > h.events.indexOf('lease:acquire'), true)
})

test('liveness jobs run every minute while a long job is still in flight', async () => {
  const events: string[] = []
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let acquires = 0
  let renewals = 0
  let releases = 0
  const clockRef = { ms: at(0) }
  const h = harness({
    now: () => clockRef.ms,
    budgetMs: 5,
    acquireLease: () => {
      acquires++
      return Promise.resolve({
        release: () => {
          releases++
          return Promise.resolve()
        },
        renew: () => {
          renewals++
          return Promise.resolve(true)
        },
      })
    },
    jobs: [
      job('cell maintain', 'local', events),
      job('stale presence', 'shared', events),
      { name: 'slow', scope: 'shared', run: () => gate },
      job('after slow', 'shared', events),
    ],
  })
  await h.tick.run()
  clockRef.ms = at(1)
  const second = await h.tick.run()
  assertEquals(second.overlapped, false)
  clockRef.ms = at(2)
  await h.tick.run()
  assertEquals(events.filter((e) => e === 'run:cell maintain').length, 3)
  assertEquals(events.filter((e) => e === 'run:stale presence').length, 3)
  // The straggler holds one lease across all three ticks.
  assertEquals(acquires, 1)
  assertEquals(renewals, 2)
  assertEquals(releases, 0)
  release()
  await flush()
  assertEquals(releases, 1)
})

test('a lease that can no longer be renewed is taken again', async () => {
  const events: string[] = []
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let acquires = 0
  const clockRef = { ms: at(0) }
  const h = harness({
    now: () => clockRef.ms,
    budgetMs: 5,
    acquireLease: () => {
      acquires++
      return Promise.resolve({
        release: () => Promise.resolve(),
        renew: () => Promise.resolve(false),
      })
    },
    jobs: [{ name: 'slow', scope: 'shared', run: () => gate }, job('quick', 'shared', events)],
  })
  await h.tick.run()
  clockRef.ms = at(1)
  await h.tick.run()
  assertEquals(acquires, 2)
  release()
  await flush()
})

test('a job whose due check throws is skipped and logged, and the tick still completes', async () => {
  const events: string[] = []
  const h = harness({
    jobs: [
      job('broken', 'shared', events, {
        due: () => {
          throw new Error('bad gate')
        },
      }),
      job('fine', 'shared', events),
    ],
  })
  const report = await h.tick.run()
  assertEquals(report.ran, ['fine'])
  assertEquals(
    h.events.some((e) => e.includes('job broken could not decide') && e.includes('bad gate')),
    true
  )
})

test('the upgrade tick runs every minute while a run is active and on its slot otherwise', () => {
  const server = Deno.readTextFileSync(new URL('./server.ts', import.meta.url))
  assert(server.includes("name: 'upgrade tick'"))
  assert(server.includes("ctx.gates.upgradeRunActive || ctx.isDue('upgradeTick')"))
})
