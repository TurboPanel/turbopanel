/**
 * The one line of a failed command's error text that says what went wrong.
 *
 * A daemon's `command-outcome.error` is the **tail** of whatever the handler
 * threw (at most 4000 characters, with a leading `[...truncated]` marker when
 * the start was cut), because tools print the cause last. Screens, status
 * rows and alerts need that one line, not the whole block. It is derived here
 * at read time from the stored text, so it works for every existing row and
 * needs no extra column or wire field.
 *
 * Workers-bundle safe: pure string work.
 */

import { redactUrlSecrets } from '../upgrades/redact-url-secrets.ts'

/** Longest error line returned; a longer one keeps its end (the cause). */
export const ERROR_LINE_MAX_CHARS = 300

const TRUNCATION_MARKER = /^\[\.\.\.truncated\]\s*/

/** Lines that carry no cause: a bare exit code, a stack frame, a pointer to a log file. */
const NOISE_LINES: readonly RegExp[] = [
  /^(process )?exit(ed)?( code| status)?:? ?\d+\.?$/i,
  /^exit status \d+$/i,
  /^npm (ERR!|error) (A complete log of this run|code |path |errno |syscall )/i,
  /^npm notice\b/i,
  /^[\s\-=_*#~.]+$/,
]

const LINE_AND_COLUMN_END = /:\d+:\d+\)?$/

/** `at fn (file:1:2)` or `at file:1:2`; plain string checks keep the matching linear. */
function isStackFrame(line: string): boolean {
  if (!line.startsWith('at ') || !LINE_AND_COLUMN_END.test(line)) return false
  if (line.endsWith(')')) return line.includes('(')
  return !line.slice(3).includes(' ')
}

function isNoise(line: string): boolean {
  return isStackFrame(line) || NOISE_LINES.some((pattern) => pattern.test(line))
}

function clipKeepingEnd(text: string): string {
  if (text.length <= ERROR_LINE_MAX_CHARS) return text
  return `…${text.slice(text.length - ERROR_LINE_MAX_CHARS + 1)}`
}

/**
 * The last meaningful line of `errorMessage`, redacted for signed URLs and capped
 * at {@link ERROR_LINE_MAX_CHARS}; `null` when there is no error text.
 *
 * Skipped: blank lines, the daemon's truncation marker, a bare "exit N", stack
 * frames and log-file pointers. When every line is noise the last line is
 * returned anyway, so a failure never shows no line at all.
 */
export function lastErrorLine(errorMessage: string | null | undefined): string | null {
  if (!errorMessage) return null
  const lines = errorMessage
    .split(/\r?\n/)
    .map((line, index) => (index === 0 ? line.replace(TRUNCATION_MARKER, '') : line).trim())
    .filter((line) => line.length > 0)
  if (lines.length === 0) return null
  const pick = lines.findLast((line) => !isNoise(line)) ?? lines.at(-1) ?? ''
  return clipKeepingEnd(redactUrlSecrets(pick))
}
