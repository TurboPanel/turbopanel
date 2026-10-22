/**
 * Optional managed-HA recovery hooks for the command consumer.
 *
 * The recovery journal still lives with the managed HTTP helpers until those
 * files move; the composition root registers this port so `features/commands`
 * never imports `client/`.
 */

import type { Db } from '../../db/connection.ts'
import type { CommandQueue } from '../../features/commands/queue.ts'
import type { DerivedSecretsConfig, SecretsConfig } from '../../lib/secrets/secrets.ts'

export type RecoveryFencePhase = 'drain' | 'stop'

export type RecoveryCommandActor = {
  actorType: 'user' | 'system'
  actorId: string
}

export type ManagedHaRecoveryHooks = {
  fencePhaseFromCommandMetadata: (
    metadata: Record<string, unknown> | null | undefined,
  ) => RecoveryFencePhase | null
  recoveryIdFromCommandMetadata: (
    metadata: Record<string, unknown> | null | undefined,
  ) => string | null
  onFenceCommandSucceeded: (
    db: Db,
    commandQueue: CommandQueue | undefined,
    params: {
      recoveryId: string
      commandId: string
      fencePhase: RecoveryFencePhase
      engine: string
      actor: RecoveryCommandActor
    },
  ) => Promise<void>
  onFenceCommandFailed: (
    db: Db,
    commandQueue: CommandQueue | undefined,
    params: {
      recoveryId: string
      commandId: string
      engine: string
      actor: RecoveryCommandActor
    },
  ) => Promise<void>
  onPromoteSucceeded: (
    db: Db,
    commandQueue: CommandQueue | undefined,
    secrets: {
      secretsConfig?: SecretsConfig
      dataEncryptionSecrets?: DerivedSecretsConfig
    },
    recoveryId: string,
    actorId: string,
  ) => Promise<void>
  onRecoveryCommandFailed: (db: Db, recoveryId: string) => Promise<void>
}

let hooks: ManagedHaRecoveryHooks | null = null

export function setManagedHaRecoveryHooks(next: ManagedHaRecoveryHooks | null): void {
  hooks = next
}

export function getManagedHaRecoveryHooks(): ManagedHaRecoveryHooks | null {
  return hooks
}
