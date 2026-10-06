import type { DeploymentOutcome } from './deployment-records.ts'
import type { DeployStrategyOutcome } from './deploy-outcome.ts'

/**
 * A deploy that failed or timed out, as the consumer settles it. Handed to
 * `CommandConsumerDeps.onDeployFailed` once per deploy (one per desired
 * generation of an environment, however many servers fail), never for a
 * cancelled deploy.
 */
export type DeployFailureNotice = {
  environmentId: string
  serverId: string
  commandId: string
  /** `failed` when the daemon reported it, `timed_out` when the wait expired. */
  outcome: DeploymentOutcome
  /** Set when a sequential deploy says how it ended (`rolled_back`, `needs_attention`). */
  strategyOutcome?: DeployStrategyOutcome
  /** What the daemon (or the consumer) said, with URL credentials removed. */
  error: string
}
