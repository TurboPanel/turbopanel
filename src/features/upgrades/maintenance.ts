/**
 * Maintenance-tick entry. Resolves channel manifests (cached), maybe starts
 * an automatic run, then advances the active run. Hello handlers do not
 * enqueue; this is the path that does.
 */
import type { DaemonCellRegistry } from '../../contracts/cell.ts'
import { resolveInstanceUpdateChannel } from '../../contracts/update-channel.ts'
import type { Db } from '../../db/connection.ts'
import { isExplicitDevelopmentMode } from '../../lib/dev-mode.ts'
import { createUpgradeCoordinator, type UpgradeTickDecision } from './coordinator.ts'
import { createDrizzleUpgradeStore } from './store.ts'
import type { UpgradeRuntime } from './planner.ts'

export async function runUpgradeMaintenance(input: {
  db: Db
  registry: DaemonCellRegistry | null
  runtime: UpgradeRuntime
  resolveManifests: boolean
  env?: Record<string, string | undefined>
  instanceInstalled: { version: string; commit: string | null }
  colocatedServerId: string | null
}): Promise<void> {
  const env = input.env ?? (typeof Deno === 'undefined' ? {} : Deno.env.toObject())
  const channel = resolveInstanceUpdateChannel(env)
  const coordinator = createUpgradeCoordinator({
    store: createDrizzleUpgradeStore(input.db, input.registry),
    enqueue: async (serverId, envelope) => {
      if (!input.registry) return
      await input.registry.getCell(serverId).enqueue(envelope)
    },
    runtime: input.runtime,
    channel,
    development: isExplicitDevelopmentMode(),
    now: () => new Date().toISOString(),
    colocatedServerId: input.colocatedServerId,
    instanceInstalled: input.instanceInstalled,
    trace: traceUpgradeTick,
  })
  await coordinator.tick({ resolveManifests: input.resolveManifests })
}

/** A repeated, unchanged decision is logged again at most this often. */
export const UPGRADE_TICK_LOG_REPEAT_MS = 60 * 60 * 1000

let lastTickLog: { key: string; at: number } | null = null

/** Forget the last logged decision — for tests only. */
export function resetUpgradeTickLogForTests(): void {
  lastTickLog = null
}

function short(commit: string | null | undefined): string {
  return commit ? commit.slice(0, 7) : '-'
}

/** One operator-readable line for a tick decision. */
export function formatUpgradeTickDecision(d: UpgradeTickDecision): string {
  const target = d.targetDaemon
    ? `${d.targetDaemon.version ?? '?'}@${short(d.targetDaemon.commit)}`
    : 'unresolved'
  const active = d.activeRun
    ? `${d.activeRun.id}:${d.activeRun.status}/${d.activeRun.phase ?? '-'}`
    : 'none'
  let auto: string
  switch (d.autoStart.decision) {
    case 'started': {
      const s = d.autoStart.steps
      auto =
        `started ${d.autoStart.runId} steps=${s.total} done=${s.done} skipped=${s.skipped} ` +
        `failed=${s.failed} attention=${s.needsAttention} inProgress=${s.inProgress}`
      break
    }
    case 'refused':
      auto =
        `refused ${d.autoStart.error}` +
        (d.autoStart.blockers.length > 1 ? ` (+${d.autoStart.blockers.length - 1} more)` : '')
      break
    default:
      auto = 'not-attempted'
  }
  return (
    `upgrade-tick decision channel=${d.channel} daemonTarget=${target} ` +
    `daemonDrift=${d.daemonDrift} targetDiffers=${d.targetDiffers} ` +
    `activeRun=${active} autoStart=${auto}`
  )
}

/**
 * Log a tick decision when it changes, and an unchanged one at most once an
 * hour, so a stuck or no-op rollout is visible in `wrangler tail` / the
 * journal without a line every tick.
 */
export function traceUpgradeTick(
  decision: UpgradeTickDecision,
  now: number = Date.now(),
  log: (line: string) => void = console.log
): void {
  const line = formatUpgradeTickDecision(decision)
  const key = line
  if (lastTickLog && lastTickLog.key === key && now - lastTickLog.at < UPGRADE_TICK_LOG_REPEAT_MS) {
    return
  }
  lastTickLog = { key, at: now }
  log(line)
}
