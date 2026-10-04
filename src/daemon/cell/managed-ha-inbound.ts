/**
 * Workers (Durable Object) side of the daemon's `managed-ha-event` frame.
 *
 * The DO shares the Worker's bindings, so it can reach the same
 * `TURBOPANEL_COMMAND_QUEUE` producer that manual switchover and DR use.
 * Without passing it here, every accepted dead-primary event on Workers ended
 * as a terminal `no_command_queue` row and automatic failover never fenced or
 * promoted. Only a missing binding should produce that row.
 */

import type { Db } from '../../db/connection.ts'
import type { CommandQueue } from '../../features/commands/queue.ts'
import {
  type CommandQueueBinding,
  createWorkersCommandQueue,
} from '../../features/commands/workers-queue.ts'
import { handleManagedHaEvent } from '../../features/managed/ha-event.ts'
import {
  type AutoFailoverSetting,
  FRESH_STANDBY_MARGIN_ENV,
  resolveAutoFailover,
  resolveFreshStandbyMarginMs,
} from '../../features/managed/auto-failover-switch.ts'
import type { FreshStandbyProbe } from '../../features/managed/ha-fresh-standby.ts'
import type { DaemonMessage } from '../../contracts/cell-protocol.ts'

export type ManagedHaEventFrame = Extract<DaemonMessage, { type: 'managed-ha-event' }>

export type CellCommandQueueEnv = {
  TURBOPANEL_COMMAND_QUEUE?: CommandQueueBinding
}

export type CellAutoFailoverEnv = {
  TURBOPANEL_AUTO_FAILOVER?: string
  TURBOPANEL_ENVIRONMENT?: string
  TURBOPANEL_AUTO_FAILOVER_RECEIPT_MARGIN_SECONDS?: string
}

/** `TURBOPANEL_AUTO_FAILOVER` from the Worker's vars, read per event. */
export function cellAutoFailover(env: CellAutoFailoverEnv): AutoFailoverSetting {
  return resolveAutoFailover({
    TURBOPANEL_AUTO_FAILOVER: env.TURBOPANEL_AUTO_FAILOVER,
    TURBOPANEL_ENVIRONMENT: env.TURBOPANEL_ENVIRONMENT,
  })
}

/** Fresh-standby receipt margin from the Worker's vars, read per event. */
export function cellFreshStandbyMarginMs(env: CellAutoFailoverEnv): number {
  return resolveFreshStandbyMarginMs({
    [FRESH_STANDBY_MARGIN_ENV]: env.TURBOPANEL_AUTO_FAILOVER_RECEIPT_MARGIN_SECONDS,
  })
}

/** The Workers command queue when the producer binding exists, else undefined. */
export function cellCommandQueue(env: CellCommandQueueEnv): CommandQueue | undefined {
  const binding = env.TURBOPANEL_COMMAND_QUEUE
  return binding ? createWorkersCommandQueue(binding) : undefined
}

/**
 * `reporterServerId` must be the authenticated attachment's server id, never a
 * frame field (see `handleManagedHaEvent`).
 */
export async function handleCellManagedHaEvent(
  db: Db,
  frame: ManagedHaEventFrame,
  deps: {
    reporterServerId: string
    commandQueue: CommandQueue | undefined
    autoFailover: AutoFailoverSetting
    probeStandby?: FreshStandbyProbe
    freshStandbyMarginMs?: number
    handle?: typeof handleManagedHaEvent
  }
): Promise<void> {
  const handle = deps.handle ?? handleManagedHaEvent
  await handle(
    db,
    {
      managedId: frame.managedId,
      ...(frame.sourceMemberId ? { sourceMemberId: frame.sourceMemberId } : {}),
      ...(frame.detector ? { detector: frame.detector } : {}),
      ...(frame.instanceHost ? { instanceHost: frame.instanceHost } : {}),
      ...(frame.instancePort ? { instancePort: frame.instancePort } : {}),
      ...(frame.evidence ? { evidence: frame.evidence } : {}),
      at: frame.at,
    },
    {
      reporterServerId: deps.reporterServerId,
      ...(deps.commandQueue ? { commandQueue: deps.commandQueue } : {}),
      autoFailover: deps.autoFailover,
      ...(deps.probeStandby ? { probeStandby: deps.probeStandby } : {}),
      ...(deps.freshStandbyMarginMs === undefined
        ? {}
        : { freshStandbyMarginMs: deps.freshStandbyMarginMs }),
    }
  )
}
