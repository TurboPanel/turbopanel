/**
 * What the daemon will actually be told to run for a deploy.
 *
 * Stage 3 of the deploy-strategy work: the daemon implements `inplace` and
 * `sequential`. `bluegreen` is a valid setting but has no engine yet, so it is
 * run as `sequential` and the answer says why (a visible fallback reason next
 * to any other reason blue-green would have been refused for).
 *
 * Pure: options and compose data in, the decision and the payload fields out.
 */

import {
  type DeployStrategy,
  type MigrationStatus,
  resolveDeployOptions,
} from './deploy-options.ts'
import {
  collectStrategyFacts,
  computeEffectiveStrategy,
  type FallbackReason,
} from './deploy-strategy.ts'

export type EngineStrategy = 'inplace' | 'sequential'

/** The daemon `environment.deploy` payload fields the strategy decides. */
export type DeployEnginePayloadFields = {
  deployStrategy?: 'sequential'
  migrations?: MigrationStatus
  healthTimeoutSeconds?: number
  keepRunningServices?: string[]
}

export type DeployEnginePlan = {
  requested: DeployStrategy
  /** What runs: never `bluegreen` until that engine exists. */
  effectiveStrategy: EngineStrategy
  fallbackReasons: FallbackReason[]
  migrations: MigrationStatus
  payload: DeployEnginePayloadFields
}

export const BLUEGREEN_UNAVAILABLE_REASON: FallbackReason = {
  code: 'bluegreen_unavailable',
  message: 'blue-green deploys are not available yet',
  services: [],
}

export function planDeployEngine(input: {
  environmentOptions: unknown
  projectOptions: unknown
  composeData: Record<string, unknown> | null | undefined
  override?: { strategy?: DeployStrategy | null; migration?: MigrationStatus | null }
}): DeployEnginePlan {
  const resolved = resolveDeployOptions(input.environmentOptions, input.projectOptions)
  const requested = input.override?.strategy ?? resolved.deployStrategy
  const migrations = input.override?.migration ?? resolved.migrations
  const facts = collectStrategyFacts(input.composeData)
  const decided = computeEffectiveStrategy({ requested, migrations, facts })
  const bluegreenRequested = requested === 'bluegreen'
  const effectiveStrategy: EngineStrategy =
    decided.effectiveStrategy === 'inplace' ? 'inplace' : 'sequential'
  const fallbackReasons = bluegreenRequested
    ? [...decided.fallbackReasons, BLUEGREEN_UNAVAILABLE_REASON]
    : decided.fallbackReasons
  const payload: DeployEnginePayloadFields =
    effectiveStrategy === 'sequential'
      ? {
          deployStrategy: 'sequential',
          migrations,
          healthTimeoutSeconds: resolved.healthTimeoutSeconds,
          ...(facts.statefulWritableVolumes.length > 0
            ? { keepRunningServices: facts.statefulWritableVolumes }
            : {}),
        }
      : {}
  return { requested, effectiveStrategy, fallbackReasons, migrations, payload }
}
