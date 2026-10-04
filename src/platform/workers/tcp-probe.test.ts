import { assertEquals } from '@std/assert'
import { createWorkersTcpProbe, stateFromWorkersError } from './tcp-probe.ts'

const test = Deno.test.bind(Deno)

type FakeSocket = { opened: Promise<unknown>; close: () => Promise<void>; closed: number }

function socket(opened: Promise<unknown>): FakeSocket {
  const state: FakeSocket = {
    opened,
    closed: 0,
    close() {
      state.closed += 1
      return Promise.resolve()
    },
  }
  return state
}

test('an opened socket is open, with a time, and is closed afterwards', async () => {
  const fake = socket(Promise.resolve({}))
  const probe = createWorkersTcpProbe(() => fake)
  const result = await probe.connect({ address: '1.1.1.1', port: 22 }, 1_000)
  assertEquals(result.state, 'open')
  assertEquals(typeof result.ms, 'number')
  assertEquals(fake.closed, 1)
})

test('the socket is asked for in plain tcp at exactly the address and port given', async () => {
  const seen: unknown[] = []
  const probe = createWorkersTcpProbe((address, options) => {
    seen.push([address, options])
    return socket(Promise.resolve({}))
  })
  await probe.connect({ address: '93.184.216.34', port: 8443 }, 1_000)
  assertEquals(seen, [
    [
      { hostname: '93.184.216.34', port: 8443 },
      { secureTransport: 'off', allowHalfOpen: false },
    ],
  ])
})

test('platform refusals are blocked, resets are refused, anything else is an error', () => {
  assertEquals(
    stateFromWorkersError(new Error('Connect to Cloudflare IP is not allowed')),
    'blocked'
  )
  assertEquals(stateFromWorkersError(new Error('connecting to private network blocked')), 'blocked')
  assertEquals(stateFromWorkersError(new Error('Connection refused')), 'refused')
  assertEquals(stateFromWorkersError(new Error('connection reset by peer')), 'refused')
  assertEquals(stateFromWorkersError(new Error('something odd')), 'error')
  assertEquals(stateFromWorkersError('plain text'), 'error')
})

test('a rejected open and a connect that throws both resolve to a state, never throw', async () => {
  const rejected = createWorkersTcpProbe(() =>
    socket(Promise.reject(new Error('Connection refused')))
  )
  assertEquals((await rejected.connect({ address: '1.1.1.1', port: 22 }, 1_000)).state, 'refused')
  const thrown = createWorkersTcpProbe(() => {
    throw new Error('port 25 is not allowed')
  })
  assertEquals(await thrown.connect({ address: '1.1.1.1', port: 25 }, 1_000), {
    state: 'blocked',
    ms: null,
  })
})

test('silence past the timeout is a timeout', async () => {
  const probe = createWorkersTcpProbe(() => socket(new Promise(() => undefined)))
  assertEquals(await probe.connect({ address: '1.1.1.1', port: 22 }, 20), {
    state: 'timeout',
    ms: null,
  })
})

test('a hosted Worker cannot reach private networks', () => {
  assertEquals(createWorkersTcpProbe(() => socket(Promise.resolve({}))).canReachPrivate, false)
})
