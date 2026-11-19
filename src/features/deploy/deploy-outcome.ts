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

/**
 * A deploy whose post-deploy commands failed after the new release was already
 * switched in. The daemon's error text starts with this code and a colon (the
 * outcome carries no code field), so the consumer reads it back into
 * {@link DEPLOY_POST_DEPLOY_FAILED_ERROR_CODE}. An older daemon never sends it
 * and its text stays an ordinary failure.
 */
export const POST_DEPLOY_FAILED_AFTER_SWITCH = 'post_deploy_failed_after_switch'
const POST_DEPLOY_FAILED_PREFIX = `${POST_DEPLOY_FAILED_AFTER_SWITCH}: `

/** `command.error_code` of that failure. */
export const DEPLOY_POST_DEPLOY_FAILED_ERROR_CODE = `${ERROR_CODE_PREFIX}${POST_DEPLOY_FAILED_AFTER_SWITCH}`

/** Is this daemon error text the report of a post-deploy failure after the switch? */
export function isPostDeployFailedAfterSwitch(message: string | null | undefined): boolean {
  return typeof message === 'string' && message.startsWith(POST_DEPLOY_FAILED_PREFIX)
}

export type PostDeployFailure = {
  /** The failed program (a path, never an argument), or `null` when the daemon could not tell. */
  program: string | null
  /** How it ended (`exited with exit status 1`, `timed out`, ...), or `null`. */
  how: string | null
  /** The release that went live and then failed, and the one to roll back to (`null` when none). */
  failedReleaseId: string | null
  previousReleaseId: string | null
  /** A plain sentence for the screen; the program's own output is in the deploy log. */
  message: string
  /** The previous release is live-switched and can be rolled back to. */
  rollBackAvailable: boolean
}

const POST_DEPLOY_SENTENCE_RE =
  /after the new release (\S+) went live\.(?: (\S+) (exited with exit status \d+|timed out|was stopped by \S+|failed)\.)? Roll back to the previous release(?: (\S+))? from/

/**
 * Read the daemon's `post_deploy_failed_after_switch: ...` text. The program
 * and release ids are optional in it; a text that does not match still gives a
 * generic message, and a null result means the text is not this failure.
 */
export function classifyPostDeployFailure(
  message: string | null | undefined
): PostDeployFailure | null {
  if (typeof message !== 'string' || !isPostDeployFailedAfterSwitch(message)) return null
  const match = POST_DEPLOY_SENTENCE_RE.exec(message)
  const failedReleaseId = match?.[1] ?? null
  const program = match?.[2] ?? null
  const how = match?.[3] ?? null
  const previousReleaseId = match?.[4] ?? null
  const failed = program === null ? 'A post-deploy command' : `The post-deploy command ${program}`
  const ended = how ?? 'failed'
  const rollBack =
    previousReleaseId === null
      ? ''
      : ' The previous release is still available: roll back to it if the site is not working.'
  return {
    program,
    how,
    failedReleaseId,
    previousReleaseId,
    message: `${failed} ${ended} after the new release went live.${rollBack}`,
    rollBackAvailable: previousReleaseId !== null,
  }
}
