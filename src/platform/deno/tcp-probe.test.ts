import { assertEquals } from '@std/assert'
import { createDenoTcpProbe } from './tcp-probe.ts'

const test = Deno.test.bind(Deno)

function conn(): { close: () => void; closed: number } {
  const state = {
    closed: 0,
    close() {
      state.closed += 1
    },
  }
  return state
}

test('a completed handshake is open, takes a time, and the connection is closed straight away', async () => {
  const opened = conn()
  const probe = createDenoTcpProbe(() => Promise.resolve(opened))
  const result = await probe.connect({ address: '1.1.1.1', port: 22 }, 1_000)
  assertEquals(result.state, 'open')
  assertEquals(typeof result.ms, 'number')
  assertEquals(opened.closed, 1)
})

test('the connection is asked for over tcp at exactly the address and port given', async () => {
  const seen: unknown[] = []
  const probe = createDenoTcpProbe((options) => {
    seen.push(options)
    return Promise.resolve(conn())
  })
  await probe.connect({ address: '93.184.216.34', port: 8443 }, 1_000)
  assertEquals(seen, [{ hostname: '93.184.216.34', port: 8443, transport: 'tcp' }])
})

test('a refused or reset connection is refused; other failures are errors', async () => {
  const refused = createDenoTcpProbe(() => Promise.reject(new Deno.errors.ConnectionRefused('no')))
  assertEquals((await refused.connect({ address: '1.1.1.1', port: 22 }, 1_000)).state, 'refused')
  const reset = createDenoTcpProbe(() => Promise.reject(new Deno.errors.ConnectionReset('no')))
  assertEquals((await reset.connect({ address: '1.1.1.1', port: 22 }, 1_000)).state, 'refused')
  const timedOut = createDenoTcpProbe(() => Promise.reject(new Deno.errors.TimedOut('no')))
  assertEquals((await timedOut.connect({ address: '1.1.1.1', port: 22 }, 1_000)).state, 'timeout')
  const other = createDenoTcpProbe(() => Promise.reject(new Error('boom')))
  assertEquals((await other.connect({ address: '1.1.1.1', port: 22 }, 1_000)).state, 'error')
})

test('silence past the timeout is a timeout, and a late connection is still closed', async () => {
  const late = conn()
  let resolveConnect: (value: ReturnType<typeof conn>) => void = () => undefined
  const probe = createDenoTcpProbe(
    () => new Promise((resolve) => (resolveConnect = resolve as typeof resolveConnect))
  )
  const result = await probe.connect({ address: '1.1.1.1', port: 22 }, 20)
  assertEquals(result, { state: 'timeout', ms: null })
  resolveConnect(late)
  await new Promise((done) => setTimeout(done, 10))
  assertEquals(late.closed, 1)
})

test('a self-hosted control plane may reach private networks', () => {
  assertEquals(createDenoTcpProbe(() => Promise.resolve(conn())).canReachPrivate, true)
})
