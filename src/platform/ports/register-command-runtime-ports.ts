/**
 * Shared composition-root wiring for command-consumer ports.
 *
 * Port signatures stay boundary-safe (`engine: string`, `registry: unknown`).
 * This helper is the one place that narrows when registering the concrete
 * feature/daemon implementations, so Deno and Workers do not each repeat the
 * adapters (and so the adapters stay unit-testable).
 */

import type { DaemonCellRegistry } from '../../contracts/cell.ts'
import type { Db } from '../../db/connection.ts'
import type { CommandQueue } from '../../features/commands/queue.ts'
import type { ManagedEngineCode } from '../../features/managed/types.ts'
import { type FleetPresencePortSnapshot, setResolveFleetPresence } from './fleet-presence.ts'
import {
  type ServerStatusConnectedRecord,
  setLoadServerStatusRecords,
} from './load-server-status.ts'
import {
  type ManagedHaRecoveryHooks,
  type RecoveryCommandActor,
  type RecoveryFencePhase,
  setManagedHaRecoveryHooks,
} from './managed-ha-recovery.ts'

export type CommandRuntimePortImpls = {
  fencePhaseFromCommandMetadata: ManagedHaRecoveryHooks['fencePhaseFromCommandMetadata']
  recoveryIdFromCommandMetadata: ManagedHaRecoveryHooks['recoveryIdFromCommandMetadata']
  onFenceCommandSucceeded: (
    db: Db,
    commandQueue: CommandQueue | undefined,
    params: {
      recoveryId: string
      commandId: string
      fencePhase: RecoveryFencePhase
      engine: ManagedEngineCode
      actor: RecoveryCommandActor
    }
  ) => Promise<void>
  onFenceCommandFailed: (
    db: Db,
    commandQueue: CommandQueue | undefined,
    params: {
      recoveryId: string
      commandId: string
      engine: ManagedEngineCode
      actor: RecoveryCommandActor
    }
  ) => Promise<void>
  onPromoteSucceeded: ManagedHaRecoveryHooks['onPromoteSucceeded']
  onRecoveryCommandFailed: ManagedHaRecoveryHooks['onRecoveryCommandFailed']
  loadServerStatusRecords: (
    db: Db,
    registry: DaemonCellRegistry | undefined,
    serverIds: string[]
  ) => Promise<ServerStatusConnectedRecord[]>
  resolveFleetPresence: (
    db: Db,
    registry: DaemonCellRegistry | undefined,
    serverIds: string[]
  ) => Promise<Map<string, FleetPresencePortSnapshot>>
}

export function registerCommandRuntimePorts(impls: CommandRuntimePortImpls): void {
  setManagedHaRecoveryHooks({
    fencePhaseFromCommandMetadata: impls.fencePhaseFromCommandMetadata,
    recoveryIdFromCommandMetadata: impls.recoveryIdFromCommandMetadata,
    onFenceCommandSucceeded: (db, commandQueue, params) =>
      impls.onFenceCommandSucceeded(db, commandQueue, {
        ...params,
        engine: params.engine as ManagedEngineCode,
      }),
    onFenceCommandFailed: (db, commandQueue, params) =>
      impls.onFenceCommandFailed(db, commandQueue, {
        ...params,
        engine: params.engine as ManagedEngineCode,
      }),
    onPromoteSucceeded: impls.onPromoteSucceeded,
    onRecoveryCommandFailed: impls.onRecoveryCommandFailed,
  })
  setLoadServerStatusRecords((db, registry, serverIds) =>
    impls.loadServerStatusRecords(db, registry as DaemonCellRegistry | undefined, serverIds)
  )
  setResolveFleetPresence((db, registry, serverIds) =>
    impls.resolveFleetPresence(db, registry, serverIds)
  )
}
