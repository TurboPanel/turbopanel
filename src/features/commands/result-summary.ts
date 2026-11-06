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
 *
 * The rebuilt summary is then cleaned of text Postgres refuses inside `jsonb`
 * (see {@link storableJson}), so a stray character in, say, a deploy warning
 * cannot keep the result from being stored, whether it arrives on time or late.
 */
export function resultSummaryForPersist(type: string, result: unknown): unknown {
  if (!isCommandType(type)) return null
  try {
    return storableJson(parseCommandResult(type, result))
  } catch {
    return null
  }
}

/** A string `jsonb` accepts: NUL removed, lone surrogate halves replaced by U+FFFD. */
function storableText(text: string): string {
  return text.replaceAll('\u0000', '').toWellFormed()
}

/**
 * `value` with every string and object key made storable by
 * {@link storableText}. Postgres refuses the NUL character and unpaired UTF-16
 * surrogates in `jsonb` text, and refuses the whole value when one appears.
 */
function storableJson(value: unknown): unknown {
  if (typeof value === 'string') return storableText(value)
  if (Array.isArray(value)) return value.map(storableJson)
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [storableText(key), storableJson(entry)])
  )
}
