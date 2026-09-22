/**
 * Convert a GitHub App `id` to the stored string form.
 *
 * GitHub sends a number; some payloads already stringify it. Objects (and
 * anything else) must not become `[object Object]`.
 */
export function stringifyGithubAppId(value: unknown): string | null {
  if (typeof value === 'string') {
    return value.length > 0 ? value : null
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value)
  }
  if (typeof value === 'bigint') {
    return String(value)
  }
  return null
}
