import { assert, assertEquals } from '@std/assert'
import type { Db } from '../../db/connection.ts'
import { createNoopCommandQueue } from '../../features/commands/noop-command-queue.ts'
import {
  TUNNEL_SWEEPS,
  type TunnelSweep,
  type TunnelSweepDeps,
} from '../../features/tunnels/sweeps.ts'
import { runSelfHostedTunnelSweeps } from './tunnel-sweeps.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const fakeDb = {} as Db
const fakeDeps = {
  commandQueue: createNoopCommandQueue(),
  secretsConfig: {},
  dataEncryptionSecrets: {},
} as unknown as TunnelSweepDeps

function readSource(relative: string): string {
  return Deno.readTextFileSync(new URL(relative, import.meta.url))
}

test('the tunnel sweep list holds every hosted tunnel sweep, in order', () => {
  assertEquals(
    TUNNEL_SWEEPS.map((sweep) => sweep.failureLabel),
    [
      'tunnel-routes-sweep-failed',
      'tunnel-verified-names-sweep-failed',
      'tunnel-connectors-sweep-failed',
      'tunnel-run-token-rotation-failed',
      'tunnel-removal-sweep-failed',
      'tunnel-token-recheck-failed',
      'tunnel-status-poll-failed',
    ]
  )
})

test('the self-hosted run calls every tunnel sweep, and a failing one does not stop the rest', async () => {
  const ran: string[] = []
  const sweeps: TunnelSweep[] = TUNNEL_SWEEPS.map((real, index) => ({
    failureLabel: real.failureLabel,
    run: (db, deps) => {
      assert(db === fakeDb)
      assert(deps === fakeDeps)
      ran.push(real.failureLabel)
      return index === 1 ? Promise.reject(new Error('provider down')) : Promise.resolve()
    },
  }))
  await runSelfHostedTunnelSweeps(fakeDb, fakeDeps, sweeps)
  assertEquals(
    ran,
    TUNNEL_SWEEPS.map((sweep) => sweep.failureLabel)
  )
})

test('the self-hosted tick runs the tunnel sweeps and delivers peer leaves with their table', () => {
  const server = readSource('./server.ts')
  const start = server.indexOf("name: 'leaf renewal'")
  const end = server.indexOf("onCadence('ingress tick'", start)
  assert(start >= 0 && end > start, 'the certificate jobs are not where this test looks for them')
  const jobs = server.slice(start, end)
  assert(
    jobs.includes('runSelfHostedTunnelSweeps(certificateDb(ctx)'),
    'the tick must run the tunnel sweeps'
  )
  assert(jobs.includes('deliverPeerLeaf: peerLeafDelivery('), 'peer leaves must ride their table')
})

test('no single tunnel sweep is wired into one scheduler only', () => {
  // A tunnel sweep belongs in features/tunnels/sweeps.ts, which both schedulers run.
  const direct = /\brun(Tunnel\w*|BadgeRecheck\w*|RunTokenRotation\w*)Tick\b/
  for (const path of ['./server.ts', '../../daemon/cell/offline-sweep.ts']) {
    const match = readSource(path).match(direct)
    assertEquals(match?.[0], undefined, `${path} calls a tunnel sweep directly`)
  }
})

test('every sweep the hosted cron runs on its queue also runs on a self-hosted control plane', () => {
  const offline = readSource('../../daemon/cell/offline-sweep.ts')
  const start = offline.indexOf('async function runQueuedCronSweeps(')
  const end = offline.indexOf('\nfunction capDbTimeout(', start)
  assert(start >= 0 && end > start, 'runQueuedCronSweeps is not where this test looks for it')
  // The queued sweeps and the helpers split out of it, up to the next function.
  const region = offline.slice(start, end)
  const helpers = new Set([...region.matchAll(/function (run\w+)\(/g)].map((match) => match[1]))
  const hosted = new Set(
    [...region.matchAll(/\b(run\w+)\(/g)]
      .map((match) => match[1])
      .filter((name) => name !== 'runIsolatedSweep' && !helpers.has(name))
  )
  // The same work under the name the self-hosted side calls it by.
  const selfHostedName: Record<string, string> = { runTunnelSweeps: 'runSelfHostedTunnelSweeps' }
  const server = readSource('./server.ts')
  const missing = [...hosted].filter((name) => !server.includes(`${selfHostedName[name] ?? name}(`))
  assert(hosted.size >= 10, `found only ${hosted.size} hosted sweeps; the parser is broken`)
  assertEquals(missing, [], 'hosted-only sweeps: add them to the self-hosted timers in server.ts')
})

test('the real tunnel sweeps run without throwing when the database fails', async () => {
  const touched: string[] = []
  const failingDb = new Proxy(
    {},
    {
      get(_target, property) {
        touched.push(String(property))
        throw new Error('database unavailable')
      },
    }
  ) as Db
  await runSelfHostedTunnelSweeps(failingDb, fakeDeps)
  // The status poll stops at the no-op queue; the four others reach the database.
  assert(touched.length >= 4, `only ${touched.length} sweeps reached the database`)
})
