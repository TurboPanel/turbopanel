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
import { planRolloutBatches, resolveRolloutPolicy } from './rollout-policy.ts'
import {
  collectStrategyFacts,
  computeEffectiveStrategy,
  type FallbackReason,
  type StrategyFacts,
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
  /**
   * Servers updated at once when the deploy spans several: the compose
   * `deploy.update_config.parallelism` (default 1, `0` = all at once). An
   * `inplace` deploy keeps today's all-at-once fan-out, so it reports `0`.
   */
  rolloutParallelism: number
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
  return {
    requested,
    effectiveStrategy,
    fallbackReasons,
    migrations,
    payload: enginePayload(effectiveStrategy, migrations, resolved.healthTimeoutSeconds, facts),
    rolloutParallelism: rolloutParallelismFor(effectiveStrategy, input.composeData),
  }
}

function rolloutParallelismFor(
  effectiveStrategy: EngineStrategy,
  composeData: Record<string, unknown> | null | undefined
): number {
  if (effectiveStrategy !== 'sequential') return 0
  const services = composeData?.services
  const isMapping = typeof services === 'object' && services !== null && !Array.isArray(services)
  return resolveRolloutPolicy(isMapping ? (services as Record<string, unknown>) : undefined).policy
    .parallelism
}

/** The servers of a deploy split into the batches the rollout delivers in order. */
export function planDeployBatches<T>(plan: DeployEnginePlan, servers: readonly T[]): T[][] {
  return planRolloutBatches(servers, plan.rolloutParallelism)
}

/** The rollout block of a deploy or preview answer. */
export function rolloutSummary(
  plan: DeployEnginePlan,
  serverCount: number
): { parallelism: number; batches: number } {
  return {
    parallelism: plan.rolloutParallelism,
    batches: planDeployBatches(plan, Array.from({ length: serverCount })).length,
  }
}

function enginePayload(
  effectiveStrategy: EngineStrategy,
  migrations: MigrationStatus,
  healthTimeoutSeconds: number,
  facts: StrategyFacts
): DeployEnginePayloadFields {
  if (effectiveStrategy !== 'sequential') return {}
  const payload: DeployEnginePayloadFields = {
    deployStrategy: 'sequential',
    migrations,
    healthTimeoutSeconds,
  }
  if (facts.statefulWritableVolumes.length > 0) {
    payload.keepRunningServices = facts.statefulWritableVolumes
  }
  return payload
}
