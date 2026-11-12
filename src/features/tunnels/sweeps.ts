/**
 * The periodic tunnel sweeps, in the order they run. Both schedulers walk this
 * one list: the hosted cron (`runQueuedCronSweeps` in
 * `daemon/cell/offline-sweep.ts`) and the self-hosted minute timer
 * (`platform/deno/server.ts`), so a sweep added here runs on both.
 *
 * Each sweep decides for itself, from the database, whether there is work: an
 * unchanged table or connector list is not sent again, a removal waits out its
 * own back-off, a token is checked once a day and a server is asked for its
 * connector status at most every ten minutes. Calling them every minute is
 * therefore cheap.
 */
import type { Db } from '../../db/connection.ts'
import type { DerivedSecretsConfig, SecretsConfig } from '../../lib/secrets/secrets.ts'
import { forEachSequential } from '../../lib/sequential.ts'
import type { CommandQueue } from '../commands/queue.ts'
import { runBadgeRecheckSweepTick } from './badge-recheck.ts'
import { runTunnelConnectorsSweepTick } from './connector-sync.ts'
import { runTunnelRemovalSweepTick } from './removal.ts'
import { runRunTokenRotationSweepTick } from './run-token-rotation.ts'
import { runTunnelStatusPollTick } from './status-poll.ts'
import { runTunnelRoutesSweepTick } from './sync.ts'

export type TunnelSweepDeps = Readonly<{
  commandQueue: CommandQueue
  secretsConfig: SecretsConfig
  dataEncryptionSecrets: DerivedSecretsConfig
}>

export type TunnelSweep = Readonly<{
  /** Logged when the sweep throws; the others still run. */
  failureLabel: string
  run: (db: Db, deps: TunnelSweepDeps) => Promise<unknown>
}>

export const TUNNEL_SWEEPS: readonly TunnelSweep[] = [
  // Tunnel forwarding tables: a changed table, or one a server missed while
  // offline, goes out again. An unchanged table is a no-op on the daemon.
  {
    failureLabel: 'tunnel-routes-sweep-failed',
    run: (db, deps) => runTunnelRoutesSweepTick(db, deps),
  },
  // Tunnel connectors: each carrying server is told to run its tunnels, and to
  // drop the ones that moved away. A resend leaves a running connector alone.
  {
    failureLabel: 'tunnel-connectors-sweep-failed',
    run: (db, deps) => runTunnelConnectorsSweepTick(db, deps),
  },
  // Run-token rotations under way: move the next server to the new token once
  // the one before it reports its connector connected, then drop old connections.
  {
    failureLabel: 'tunnel-run-token-rotation-failed',
    run: (db, deps) => runRunTokenRotationSweepTick(db, deps),
  },
  // Tunnels being removed: once their connectors have stopped the provider
  // lets go of them; tried again after a growing wait until it does.
  {
    failureLabel: 'tunnel-removal-sweep-failed',
    run: (db, deps) => runTunnelRemovalSweepTick(db, { secrets: deps.dataEncryptionSecrets }),
  },
  // API Tokens of provider accounts: a daily look at what each still reaches,
  // so a rolled or removed token is found before a write fails.
  {
    failureLabel: 'tunnel-token-recheck-failed',
    run: (db, deps) => runBadgeRecheckSweepTick(db, { secrets: deps.dataEncryptionSecrets }),
  },
  // Connector versions per server: record the last answer, ask again when due.
  {
    failureLabel: 'tunnel-status-poll-failed',
    run: (db, deps) => runTunnelStatusPollTick(db, deps.commandQueue),
  },
]

/**
 * Run every tunnel sweep in order. `isolate` is the caller's own wrapper that
 * catches and logs a failure, so one sweep that throws never stops the rest.
 */
export async function runTunnelSweeps(
  db: Db,
  deps: TunnelSweepDeps,
  isolate: (failureLabel: string, sweep: () => Promise<unknown>) => Promise<void>,
  sweeps: readonly TunnelSweep[] = TUNNEL_SWEEPS
): Promise<void> {
  await forEachSequential(sweeps, (sweep) => isolate(sweep.failureLabel, () => sweep.run(db, deps)))
}
