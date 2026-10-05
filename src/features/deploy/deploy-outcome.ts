/**
 * How a sequential deploy that did not finish is reported.
 *
 * The daemon's command outcome carries only an error string, so the sequential
 * engine starts that string with the outcome (`rolled_back: ...` or
 * `needs_attention: ...`). The consumer reads the prefix back into
 * `command.error_code` and `deployment.metadata`, and deploy history reads it
 * from there. `deployment.outcome` is left at `failed`: its database check
 * only allows `applied`, `failed` and `timed_out`.
 */

export const DEPLOY_STRATEGY_OUTCOMES = ['rolled_back', 'needs_attention'] as const
export type DeployStrategyOutcome = (typeof DEPLOY_STRATEGY_OUTCOMES)[number]

export type DeployFailureClass = { outcome: DeployStrategyOutcome; reason: string }

const ERROR_CODE_PREFIX = 'deploy_'

/** `command.error_code` for a classified failure. */
export function deployOutcomeErrorCode(outcome: DeployStrategyOutcome): string {
  return `${ERROR_CODE_PREFIX}${outcome}`
}

/** The outcome a stored `error_code` names, or `null`. */
export function outcomeFromErrorCode(
  code: string | null | undefined
): DeployStrategyOutcome | null {
  if (typeof code !== 'string' || !code.startsWith(ERROR_CODE_PREFIX)) return null
  const outcome = code.slice(ERROR_CODE_PREFIX.length)
  return (DEPLOY_STRATEGY_OUTCOMES as readonly string[]).includes(outcome)
    ? (outcome as DeployStrategyOutcome)
    : null
}

/** Read the daemon's `rolled_back: ...` / `needs_attention: ...` error text. */
export function classifyDeployFailure(
  message: string | null | undefined
): DeployFailureClass | null {
  if (typeof message !== 'string') return null
  for (const outcome of DEPLOY_STRATEGY_OUTCOMES) {
    const prefix = `${outcome}: `
    if (message.startsWith(prefix)) return { outcome, reason: message.slice(prefix.length) }
  }
  return null
}

/** The reason without the outcome prefix, for a history row. */
export function deployOutcomeReason(
  outcome: DeployStrategyOutcome | null,
  message: string | null
): string | null {
  if (outcome === null || message === null) return null
  return classifyDeployFailure(message)?.reason ?? message
}

/**
 * A deploy the daemon stopped because someone asked it to. The daemon's error
 * text starts with `cancelled: `; the consumer reads it back into command status
 * `cancelled` (a terminal status the table already allows) and
 * {@link DEPLOY_CANCELLED_ERROR_CODE}, so no new status or migration is needed.
 * The previous version is still serving: the daemon only honours a cancel before
 * it switches anything over.
 */
export const CANCELLED_ERROR_PREFIX = 'cancelled: '

/** `command.error_code` of a cancelled deploy. */
export const DEPLOY_CANCELLED_ERROR_CODE = `${ERROR_CODE_PREFIX}cancelled`

/** Is this daemon error text the report of a cancelled deploy? */
export function isCancelledDeployError(message: string | null | undefined): boolean {
  return typeof message === 'string' && message.startsWith(CANCELLED_ERROR_PREFIX)
}
