/**
 * Origin string helpers for Git provider URLs.
 *
 * Trailing slashes are stripped without a regex. The previous unanchored
 * one-or-more-slash-at-end pattern is flagged by Sonar typescript:S8786 as
 * super-linear backtracking when the engine retries at every position.
 */

/** Drop every trailing `/` so origins compare and concatenate predictably. */
export function stripTrailingSlashes(value: string): string {
  let end = value.length
  while (end > 0 && value.codePointAt(end - 1) === 0x2f) {
    end -= 1
  }
  return end === value.length ? value : value.slice(0, end)
}

/** Trim then strip trailing slashes — the stored `baseUrl` / origin form. */
export function normalizeOrigin(value: string): string {
  return stripTrailingSlashes(value.trim())
}
