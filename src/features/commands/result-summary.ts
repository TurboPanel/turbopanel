import { parseCommandResult } from '../../contracts/commands/schemas.ts'
import { isCommandType } from './types.ts'

/**
 * The value stored in `command.result_summary` for a command that succeeded.
 *
 * `result_summary` is a small, bounded, typed summary, never a pass-through of
 * whatever the daemon sent. Each command type has a result parser that rebuilds
 * the result from a fixed list of fields, so running the daemon's report through
 * it drops every key that is not on that type's list. A report that does not fit
 * the type at all stores `null`: the command still succeeded, and nothing
 * unvetted is kept.
 */
export function resultSummaryForPersist(type: string, result: unknown): unknown {
  if (!isCommandType(type)) return null
  try {
    return parseCommandResult(type, result)
  } catch {
    return null
  }
}
