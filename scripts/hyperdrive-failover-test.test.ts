import { assertEquals, assertRejects, assertThrows } from '@std/assert'
// @ts-ignore plain module without types
import { formatReport, parseArgs, runScenario, summarise } from './hyperdrive-failover-test.mjs'

const test = Deno.test.bind(Deno)

test('options need a base url and both commands', () => {
  assertThrows(() => parseArgs(['--base-url', 'https://x.invalid']), Error, 'stop-cmd')
  const opts = parseArgs([
    '--base-url',
    'https://x.invalid',
    '--stop-cmd',
    'a',
    '--start-cmd',
    'b',
    '--down-at',
    '0,10',
  ])
  assertEquals(opts.downAt, [0, 10])
  assertEquals(opts.path, '/api/client/v1/servers')
})

function scenario(downBehaviour: (n: number) => Response | Error) {
  let clock = 0
  let phase = 'warm'
  let downCalls = 0
  const events: string[] = []
  const fetchImpl = (_url: string) => {
    if (phase === 'down') {
      const r = downBehaviour(downCalls++)
      if (r instanceof Error) return Promise.reject(r)
      return Promise.resolve(r)
    }
    return Promise.resolve(new Response('[{"id":"srv-1"}]', { status: 200 }))
  }
  return {
    events,
    run: runScenario(
      {
        baseUrl: 'https://x.invalid',
        path: '/p',
        stopCmd: 'stop',
        startCmd: 'start',
        warm: 2,
        downAt: [0, 30, 80],
        upAt: [0, 5],
      },
      {
        fetchImpl,
        cookie: 'c',
        now: () => clock,
        sleep: (ms: number) => {
          clock += ms
          return Promise.resolve()
        },
        run: (cmd: string) => {
          events.push(cmd)
          phase = cmd === 'stop' ? 'down' : 'up'
        },
      }
    ),
  }
}

test('a cache that answers for a while and then fails is described', async () => {
  const { run, events } = scenario((n) =>
    n < 2 ? new Response('[{"id":"srv-1"}]', { status: 200 }) : new Response('x', { status: 500 })
  )
  const result = await run
  assertEquals(events, ['stop', 'start'])
  assertEquals(result.summary.servedWhileDown, true)
  assertEquals(result.summary.servedWhileDownSameAsWarm, true)
  assertEquals(result.summary.lastServedSecondsAfterStop, 30)
  assertEquals(result.summary.firstFailureSecondsAfterStop, 80)
  assertEquals(result.summary.failureStatuses, [500])
  assertEquals(result.summary.recoveredSecondsAfterStart, 0)
  assertEquals(formatReport(result).includes('Recovered 0s after the start.'), true)
})

test('network failures while down are results, not crashes', async () => {
  const { run } = scenario(() => new Error('connection reset'))
  const result = await run
  assertEquals(result.summary.servedWhileDown, false)
  assertEquals(result.summary.failureStatuses, [0])
})

test('never recovering is reported', () => {
  const summary = summarise(
    [
      { phase: 'down', atSeconds: 0, status: 500, bodyHash: null },
      { phase: 'up', atSeconds: 0, status: 500, bodyHash: null },
    ],
    'h'
  )
  assertEquals(summary.neverRecovered, true)
})

test('options are validated', () => {
  const base = ['--base-url', 'https://x.invalid', '--stop-cmd', 'a', '--start-cmd', 'b']
  assertThrows(() => parseArgs([...base, '--warm', 'abc']), Error, '--warm')
  assertThrows(() => parseArgs([...base, '--down-at', '5,0']), Error, '--down-at')
  assertThrows(() => parseArgs([...base, '--up-at', '0,,x']), Error, '--up-at')
  assertEquals((parseArgs(['--help']) as { help?: boolean }).help, true)
})

test('a failed warm-up stops before the database is touched', async () => {
  const events: string[] = []
  await assertRejects(
    () =>
      runScenario(
        {
          baseUrl: 'https://x.invalid',
          path: '/p',
          stopCmd: 'stop',
          startCmd: 'start',
          warm: 1,
          downAt: [0],
          upAt: [0],
        },
        {
          fetchImpl: () => Promise.resolve(new Response('no', { status: 401 })),
          cookie: 'c',
          now: () => 0,
          sleep: () => Promise.resolve(),
          run: (cmd: string) => {
            events.push(cmd)
          },
        }
      ),
    Error,
    'warm-up'
  )
  assertEquals(events, [])
})

test('the database is started again when reading while it is down fails hard', async () => {
  const events: string[] = []
  await assertRejects(() =>
    runScenario(
      {
        baseUrl: 'https://x.invalid',
        path: '/p',
        stopCmd: 'stop',
        startCmd: 'start',
        warm: 1,
        downAt: [5],
        upAt: [0],
      },
      {
        fetchImpl: () => Promise.resolve(new Response('[]', { status: 200 })),
        cookie: 'c',
        now: () => 0,
        sleep: () => {
          throw new Error('interrupted')
        },
        run: (cmd: string) => {
          events.push(cmd)
        },
      }
    )
  )
  assertEquals(events, ['stop', 'start'])
})
