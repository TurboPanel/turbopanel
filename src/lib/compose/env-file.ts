/**
 * Encode a Compose project `.env` file (interpolation source next to compose.yaml).
 */

export type EnvFileEntry = {
  key: string
  value: string
  isLiteral: boolean
}

function escapeLiteralDollars(value: string): string {
  // String#replaceAll treats `$$` in the replacement as a literal `$`.
  return value.replaceAll('$', '$$$$')
}

function needsQuotes(value: string): boolean {
  if (value.length === 0) return true
  return /[\s#"\\]/.test(value)
}

function quoteEnvValue(value: string): string {
  const escaped = value.replaceAll('\\', String.raw`\\`).replaceAll('"', String.raw`\"`)
  return `"${escaped}"`
}

/**
 * Interpolation key unique to one compose service so per-service values
 * do not collide in a single project `.env`.
 */
export function serviceEnvInterpolationKey(
  composeServiceName: string,
  key: string,
): string {
  const slug = composeServiceName.replaceAll(/\W+/g, '_')
  const prefix = slug.length > 0 ? slug : 'svc'
  return `${prefix}__${key}`
}

export function composeInterpolationRef(envKey: string): string {
  return `\${${envKey}}`
}

export function encodeEnvFile(entries: readonly EnvFileEntry[]): string {
  const byKey = new Map<string, EnvFileEntry>()
  for (const entry of entries) {
    byKey.set(entry.key, entry)
  }
  const keys = [...byKey.keys()].sort((a, b) => a.localeCompare(b))
  if (keys.length === 0) return ''

  const lines: string[] = []
  for (const key of keys) {
    const entry = byKey.get(key)!
    const raw = entry.isLiteral ? escapeLiteralDollars(entry.value) : entry.value
    const rendered = needsQuotes(raw) ? quoteEnvValue(raw) : raw
    lines.push(`${key}=${rendered}`)
  }
  return `${lines.join('\n')}\n`
}
