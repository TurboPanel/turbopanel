import { assertEquals, assertGreater } from '@std/assert'
import type { TcpProbe, TcpProbeResult, TcpProbeTarget } from '../../platform/ports/tcp-probe.ts'
import { FIREWALL_APPLY_ENABLED } from './enforcement.ts'
import type { PortReach } from './probe-decision.ts'
import {
  decideAfterApply,
  MAX_PROBE_ADDRESSES,
  MAX_PROBE_TARGETS,
  observeOutside,
  PROBE_CONCURRENCY,
  PROBE_TIMEOUT_MS,
  type OutsideProbeRecord,
  type ProbePlan,
  probeGiveUpAt,
  probeOfLastResult,
} from './probe-run.ts'

const test = Deno.test.bind(Deno)

const OPEN: TcpProbeResult = { state: 'open', ms: 7 }
const SILENT: TcpProbeResult = { state: 'timeout', ms: null }

function plan(addresses: string[], ports: number[] = [22, 8443]): ProbePlan {
  return {
    serverId: 's1',
    organizationId: 'o1',
    addresses,
    ports: ports.map((port, index) => ({
      port,
      role: index === 0 ? ('invariant' as const) : ('public' as const),
      reason: `port ${port}`,
    })),
    notes: [],
  }
}

type Calls = { targets: TcpProbeTarget[]; timeouts: number[]; maxInFlight: number }

function fakeProbe(
  answer: (target: TcpProbeTarget) => TcpProbeResult,
  options: { canReachPrivate?: boolean; delayMs?: number } = {}
): { probe: TcpProbe; calls: Calls } {
  const calls: Calls = { targets: [], timeouts: [], maxInFlight: 0 }
  let inFlight = 0
  const probe: TcpProbe = {
    canReachPrivate: options.canReachPrivate ?? false,
    connect: async (target, timeoutMs) => {
      calls.targets.push(target)
      calls.timeouts.push(timeoutMs)
      inFlight += 1
      calls.maxInFlight = Math.max(calls.maxInFlight, inFlight)
      await new Promise((done) => setTimeout(done, options.delayMs ?? 0))
      inFlight -= 1
      return answer(target)
    },
  }
  return { probe, calls }
}

test('only the plan’s own addresses and ports are dialled, and every dial gets the timeout', async () => {
  const { probe, calls } = fakeProbe(() => OPEN)
  const round = await observeOutside(probe, plan(['93.184.216.34', '1.1.1.1']))
  assertEquals(calls.targets.map((t) => `${t.address}:${t.port}`).sort(), [
    '1.1.1.1:22',
    '1.1.1.1:8443',
    '93.184.216.34:22',
    '93.184.216.34:8443',
  ])
  assertEquals(new Set(calls.timeouts), new Set([PROBE_TIMEOUT_MS]))
  assertEquals(
    round.reach.map((r) => [r.port, r.state]),
    [
      [22, 'open'],
      [8443, 'open'],
    ]
  )
})

test('loopback, link-local, metadata and other forbidden addresses are never dialled', async () => {
  const forbidden = [
    '127.0.0.1',
    '169.254.169.254',
    '0.0.0.0',
    '::1',
    'fe80::1',
    '224.0.0.1',
    'junk',
  ]
  const { probe, calls } = fakeProbe(() => OPEN, { canReachPrivate: true })
  const round = await observeOutside(probe, plan([...forbidden, '93.184.216.34']))
  assertEquals(new Set(calls.targets.map((t) => t.address)), new Set(['93.184.216.34']))
  assertEquals(round.notes.filter((note) => note.includes('not checked')).length, forbidden.length)
})

test('private addresses are dialled only when the platform can reach private networks', async () => {
  const hosted = fakeProbe(() => OPEN, { canReachPrivate: false })
  const hostedRound = await observeOutside(hosted.probe, plan(['10.0.0.5']))
  assertEquals(hosted.calls.targets, [])
  assertEquals(
    hostedRound.notes.includes('This server has no address the control plane can check'),
    true
  )
  assertEquals(
    hostedRound.reach.map((r) => r.state),
    ['blocked', 'blocked']
  )

  const selfHosted = fakeProbe(() => OPEN, { canReachPrivate: true })
  await observeOutside(selfHosted.probe, plan(['10.0.0.5', '192.168.1.7']))
  assertEquals(
    new Set(selfHosted.calls.targets.map((t) => t.address)),
    new Set(['10.0.0.5', '192.168.1.7'])
  )
})

test('at most PROBE_CONCURRENCY connections are in flight, and the round is capped', async () => {
  const addresses = ['1.1.1.1', '8.8.8.8', '9.9.9.9', '93.184.216.34', '208.67.222.222', '4.4.4.4']
  const ports = [22, 80, 443, 8443, 3000, 3001, 3002]
  const { probe, calls } = fakeProbe(() => OPEN, { delayMs: 4 })
  await observeOutside(probe, plan(addresses, ports))
  assertEquals(calls.maxInFlight <= PROBE_CONCURRENCY, true)
  assertGreater(calls.maxInFlight, 1)
  assertEquals(new Set(calls.targets.map((t) => t.address)).size <= MAX_PROBE_ADDRESSES, true)
  assertEquals(calls.targets.length <= MAX_PROBE_TARGETS, true)
  assertEquals(calls.targets.length, MAX_PROBE_TARGETS)
})

test('a port counts as open when any one of the server’s addresses answers', async () => {
  const { probe } = fakeProbe((target) => (target.address === '1.1.1.1' ? OPEN : SILENT))
  const round = await observeOutside(probe, plan(['93.184.216.34', '1.1.1.1']))
  assertEquals(
    round.reach.map((r) => r.state),
    ['open', 'open']
  )
})

test('nothing in production code runs the check or decides a confirmation yet, except the check-now route', async () => {
  assertEquals(FIREWALL_APPLY_ENABLED, false)
  const callers: Record<string, string[]> = { observeOutside: [], decideAfterApply: [] }
  const root = new URL('../../', import.meta.url).pathname
  const walk = async (dir: string): Promise<void> => {
    for await (const entry of Deno.readDir(dir)) {
      const path = `${dir}/${entry.name}`
      if (entry.isDirectory) await walk(path)
      else if (/\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) {
        const text = await Deno.readTextFile(path)
        for (const name of Object.keys(callers)) {
          if (new RegExp(`\\b${name}\\(`).test(text) && !path.endsWith('/probe-run.ts')) {
            callers[name]!.push(path.slice(root.length))
          }
        }
      }
    }
  }
  await walk(root.replace(/\/$/, ''))
  assertEquals(callers.observeOutside, ['client/organizations/firewall-routes.ts'])
  assertEquals(callers.decideAfterApply, [])
})

function reach(port: number, role: PortReach['role'], state: PortReach['state']): PortReach {
  return { port, role, reason: `port ${port}`, state, ms: state === 'open' ? 5 : null }
}

const BASELINE = [reach(22, 'invariant', 'open'), reach(443, 'public', 'open')]

function clock(): { now: () => number; sleep: (ms: number) => Promise<void> } {
  let at = 1_000
  return {
    now: () => at,
    sleep: (ms) => {
      at += ms
      return Promise.resolve()
    },
  }
}

test('a confirm or unavailable answer is final at once; no second round runs', async () => {
  for (const [baseline, kind] of [
    [BASELINE, 'confirm'],
    [[] as PortReach[], 'unavailable'],
  ] as const) {
    let rounds = 0
    const decision = await decideAfterApply({
      baseline,
      observe: () => {
        rounds += 1
        return Promise.resolve(baseline)
      },
      deadlineMs: 1_000_000,
      ...clock(),
    })
    assertEquals([decision.kind, rounds], [kind, 1])
  }
})

test('a cut that is only transient is re-checked and then confirmed', async () => {
  const rounds = [
    [reach(22, 'invariant', 'timeout'), reach(443, 'public', 'open')],
    [reach(22, 'invariant', 'open'), reach(443, 'public', 'open')],
  ]
  let index = 0
  const decision = await decideAfterApply({
    baseline: BASELINE,
    observe: () => Promise.resolve(rounds[Math.min(index++, rounds.length - 1)]!),
    deadlineMs: 1_000_000,
    intervalMs: 1_000,
    ...clock(),
  })
  assertEquals(decision.kind, 'confirm')
  assertEquals(index, 2)
})

test('a cut that persists is withheld once the deadline is reached, never confirmed', async () => {
  let rounds = 0
  const decision = await decideAfterApply({
    baseline: BASELINE,
    observe: () => {
      rounds += 1
      return Promise.resolve([reach(22, 'invariant', 'timeout'), reach(443, 'public', 'open')])
    },
    deadlineMs: 1_000 + 10_500,
    intervalMs: 4_000,
    ...clock(),
  })
  assertEquals(decision.kind, 'withhold')
  assertEquals(rounds, 3)
})

test('when the deadline has already passed, one round runs and a cut is withheld', async () => {
  let rounds = 0
  const decision = await decideAfterApply({
    baseline: BASELINE,
    observe: () => {
      rounds += 1
      return Promise.resolve([reach(22, 'invariant', 'refused'), reach(443, 'public', 'open')])
    },
    deadlineMs: 0,
    ...clock(),
  })
  assertEquals([decision.kind, rounds], ['withhold', 1])
})

test('the give-up time is the host’s deadline minus a margin, or null when unreadable', () => {
  const deadline = '2026-10-01T12:00:00.000Z'
  assertEquals(probeGiveUpAt(deadline, 20_000), Date.parse(deadline) - 20_000)
  assertEquals(probeGiveUpAt('not a time'), null)
})

test('the stored probe record is read from beside the preview, and absent when there is none', () => {
  assertEquals(probeOfLastResult(null), null)
  assertEquals(probeOfLastResult({ kind: 'preview' }), null)
  const record: OutsideProbeRecord = {
    at: 'now',
    phase: 'manual',
    status: 'done',
    ports: [],
    notes: [],
  }
  assertEquals(probeOfLastResult({ kind: 'preview', probe: record }), record)
})
