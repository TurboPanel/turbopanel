import { assertEquals } from '@std/assert'
import { createInstanceShutdown, type InstanceShutdownDeps } from './instance-shutdown.ts'

const test = Deno.test.bind(Deno)

function settled(ms = 20): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function harness(overrides: (calls: string[]) => Partial<InstanceShutdownDeps> = () => ({})) {
  const calls: string[] = []
  const exits: number[] = []
  const deps: InstanceShutdownDeps = {
    timers: [],
    closers: [
      { label: 'queue', close: () => void calls.push('queue') },
      { label: 'consumer', close: () => Promise.resolve(void calls.push('consumer')) },
    ],
    resetPorts: () => void calls.push('ports'),
    stopServing: () => void calls.push('stop-serving'),
    endDatabase: () => Promise.resolve(void calls.push('database')),
    exit: (code) => void exits.push(code),
    ...overrides(calls),
  }
  return { calls, exits, shutdown: createInstanceShutdown(deps) }
}

test('shutdown closes in order, ends the database last, then exits 0', async () => {
  const { calls, exits, shutdown } = harness()
  shutdown()
  await settled()
  assertEquals(calls, ['queue', 'consumer', 'ports', 'stop-serving', 'database'])
  assertEquals(exits, [0])
})

test('a failing close is skipped, the rest still run, and the process still exits', async () => {
  const { calls, exits, shutdown } = harness((log) => ({
    closers: [
      {
        label: 'broken',
        close: () => {
          throw new Error('boom')
        },
      },
      { label: 'queue', close: () => void log.push('queue') },
    ],
  }))
  shutdown()
  await settled()
  assertEquals(calls, ['queue', 'ports', 'stop-serving', 'database'])
  assertEquals(exits, [0])
})

test('a second signal does not run shutdown twice', async () => {
  const { calls, exits, shutdown } = harness()
  shutdown()
  shutdown()
  await settled()
  assertEquals(calls.filter((c) => c === 'database').length, 1)
  assertEquals(exits, [0])
})

test('a close that never returns is cut off by the watchdog, which exits 0', async () => {
  const { exits, shutdown } = harness(() => ({
    closers: [{ label: 'hung', close: () => new Promise(() => {}) }],
    forceExitMs: 30,
  }))
  shutdown()
  await settled(100)
  assertEquals(exits, [0])
})
