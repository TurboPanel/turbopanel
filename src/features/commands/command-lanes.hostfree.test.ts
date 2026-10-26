/**
 * Host-free coverage for the per-server command lanes. No timers: every task
 * waits on a deferred the test releases, and expiry uses a clock the test moves.
 */

import { assertEquals } from '@std/assert'
import { commandIsExpired } from './consumer.ts'
import { createLaneScheduler } from './command-lanes.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

function deferred() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

/** Let every queued microtask run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

test('commands for different servers run at the same time', async () => {
  const lanes = createLaneScheduler({ maxConcurrent: 8 })
  const a = deferred()
  const b = deferred()
  const started: string[] = []
  const runA = lanes.run('server-a', async () => {
    started.push('a')
    await a.promise
  })
  const runB = lanes.run('server-b', async () => {
    started.push('b')
    await b.promise
  })
  await settle()
  assertEquals(started, ['a', 'b'])
  assertEquals(lanes.activeCount(), 2)
  a.release()
  b.release()
  await Promise.all([runA, runB])
  assertEquals(lanes.activeCount(), 0)
})

test('commands for one server run one at a time, in arrival order', async () => {
  const lanes = createLaneScheduler({ maxConcurrent: 8 })
  const first = deferred()
  const second = deferred()
  const events: string[] = []
  const run1 = lanes.run('server-a', async () => {
    events.push('1 start')
    await first.promise
    events.push('1 end')
  })
  const run2 = lanes.run('server-a', async () => {
    events.push('2 start')
    await second.promise
    events.push('2 end')
  })
  const run3 = lanes.run('server-a', () => {
    events.push('3 start')
    return Promise.resolve()
  })
  await settle()
  assertEquals(events, ['1 start'])
  first.release()
  await settle()
  assertEquals(events, ['1 start', '1 end', '2 start'])
  second.release()
  await Promise.all([run1, run2, run3])
  assertEquals(events, ['1 start', '1 end', '2 start', '2 end', '3 start'])
})

test('a slow command on one server does not delay a short one on another', async () => {
  const lanes = createLaneScheduler({ maxConcurrent: 8 })
  const slow = deferred()
  const done: string[] = []
  const slowRun = lanes.run('server-a', async () => {
    await slow.promise
    done.push('slow a')
  })
  const queuedBehind = lanes.run('server-a', () => {
    done.push('queued a')
    return Promise.resolve()
  })
  await lanes.run('server-b', () => {
    done.push('short b')
    return Promise.resolve()
  })
  assertEquals(done, ['short b'])
  slow.release()
  await Promise.all([slowRun, queuedBehind])
  assertEquals(done, ['short b', 'slow a', 'queued a'])
})

test('expiry counts the wait behind the same server only', async () => {
  const lanes = createLaneScheduler({ maxConcurrent: 8 })
  let nowMs = 0
  const slow = deferred()
  const outcome: Record<string, string> = {}
  // The consumer's own check: a command past its valid time is not sent.
  const command = (name: string, expiresAtMs: number) => () => {
    outcome[name] = commandIsExpired(new Date(expiresAtMs).toISOString(), nowMs) ? 'expired' : 'ran'
    return Promise.resolve()
  }
  const apply = lanes.run('server-a', async () => {
    await slow.promise
  })
  // Both were queued with 5 minutes to live, behind an apply that takes 10.
  const sameServer = lanes.run('server-a', command('same server', 300_000))
  const otherServer = lanes.run('server-b', command('other server', 300_000))
  await otherServer
  nowMs = 600_000
  slow.release()
  await Promise.all([apply, sameServer])
  assertEquals(outcome, { 'other server': 'ran', 'same server': 'expired' })
})

test('the cap limits how many servers run at once and lanes take turns', async () => {
  const lanes = createLaneScheduler({ maxConcurrent: 2 })
  const gates = { a: deferred(), b: deferred(), c: deferred() }
  const started: string[] = []
  const runs = [
    lanes.run('a', async () => {
      started.push('a1')
      await gates.a.promise
    }),
    lanes.run('a', () => {
      started.push('a2')
      return Promise.resolve()
    }),
    lanes.run('b', async () => {
      started.push('b1')
      await gates.b.promise
    }),
    lanes.run('c', async () => {
      started.push('c1')
      await gates.c.promise
    }),
  ]
  await settle()
  assertEquals(started, ['a1', 'b1'])
  assertEquals(lanes.activeCount(), 2)
  // Server a finishes: server c has waited longest, so it goes before a's next.
  gates.a.release()
  await settle()
  assertEquals(started, ['a1', 'b1', 'c1'])
  gates.b.release()
  gates.c.release()
  await Promise.all(runs)
  assertEquals(started, ['a1', 'b1', 'c1', 'a2'])
})

test('a task that fails rejects its caller and does not block its lane', async () => {
  const lanes = createLaneScheduler({ maxConcurrent: 1 })
  const failed = lanes.run('a', () => Promise.reject(new Error('boom')))
  const next = lanes.run('a', () => Promise.resolve('ok'))
  let message = ''
  await failed.catch((error: Error) => {
    message = error.message
  })
  assertEquals(message, 'boom')
  assertEquals(await next, 'ok')
  await settle()
  assertEquals(lanes.activeCount(), 0)
})

test('a task that throws before returning a promise is contained in its lane', async () => {
  const lanes = createLaneScheduler({ maxConcurrent: 1 })
  const failed = lanes.run('a', () => {
    throw new Error('sync boom')
  })
  const next = lanes.run('a', () => Promise.resolve('ok'))
  let message = ''
  await failed.catch((error: Error) => {
    message = error.message
  })
  assertEquals(message, 'sync boom')
  assertEquals(await next, 'ok')
})

test('a task waiting on a result that releases its lane no longer blocks its server', async () => {
  const lanes = createLaneScheduler({ maxConcurrent: 8 })
  // A deploy the server has taken over: it waits for hours on a result.
  const outcome = deferred()
  const events: string[] = []
  const deploy = lanes.run('server-a', async (release) => {
    events.push('deploy sent')
    release()
    await outcome.promise
    events.push('deploy settled')
  })
  const next = lanes.run('server-a', () => {
    events.push('next deploy')
    return Promise.resolve()
  })
  await next
  await settle()
  assertEquals(events, ['deploy sent', 'next deploy'])
  // The released task stays pending but no longer counts as holding a lane.
  assertEquals(lanes.activeCount(), 0)
  outcome.release()
  await deploy
  await settle()
  assertEquals(events, ['deploy sent', 'next deploy', 'deploy settled'])
  assertEquals(lanes.activeCount(), 0)
})

test('releasing a lane twice, or releasing and then ending, frees it only once', async () => {
  const lanes = createLaneScheduler({ maxConcurrent: 1 })
  const hold = deferred()
  const started: string[] = []
  const first = lanes.run('a', async (release) => {
    release()
    release()
    await hold.promise
  })
  const second = lanes.run('b', async () => {
    started.push('b')
    await hold.promise
  })
  const third = lanes.run('c', () => {
    started.push('c')
    return Promise.resolve()
  })
  await settle()
  // Cap 1: `a` gave its slot to `b`; a second release must not let `c` in too.
  assertEquals(started, ['b'])
  assertEquals(lanes.activeCount(), 1)
  hold.release()
  await Promise.all([first, second, third])
  await settle()
  assertEquals(started, ['b', 'c'])
  assertEquals(lanes.activeCount(), 0)
})

test('a released task that fails still rejects its caller', async () => {
  const lanes = createLaneScheduler({ maxConcurrent: 1 })
  const failed = lanes.run('a', async (release) => {
    release()
    await Promise.resolve()
    throw new Error('lost outcome')
  })
  const next = lanes.run('a', () => Promise.resolve('ok'))
  let message = ''
  await failed.catch((error: Error) => {
    message = error.message
  })
  assertEquals(message, 'lost outcome')
  assertEquals(await next, 'ok')
  await settle()
  assertEquals(lanes.activeCount(), 0)
})
