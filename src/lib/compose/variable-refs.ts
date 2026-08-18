/**
 * TurboPanel compose interpolation: `{$KEY}` or `{$scope.KEY}`.
 *
 * Parsed before Docker Compose `${VAR}` interpolation. Compiled YAML never
 * contains `{$…}`.
 */

export const VARIABLE_REF_SCOPES = [
  'organization',
  'workspace',
  'project',
  'environment',
  'service',
  'hosting',
  'server',
] as const

export type VariableRefScope = (typeof VARIABLE_REF_SCOPES)[number]

const SCOPE_ALIASES: Record<string, VariableRefScope> = {
  org: 'organization',
  env: 'environment',
}

const KEY_RE = /^[A-Za-z_]\w*$/
const EXACT_REF_RE = /^\{\$(?:([A-Za-z_]\w*)\.)?([A-Za-z_]\w*)\}$/

export type ParsedVariableRef = {
  raw: string
  scope: VariableRefScope | null
  key: string
}

export type ParseVariableRefResult =
  | { ok: true; ref: ParsedVariableRef }
  | { ok: false; error: 'not_a_ref' }
  | { ok: false; error: 'invalid'; message: string }

export function isVariableRefScope(value: string): value is VariableRefScope {
  return (VARIABLE_REF_SCOPES as readonly string[]).includes(value)
}

export function resolveVariableRefScope(
  token: string,
): VariableRefScope | null {
  if (isVariableRefScope(token)) return token
  return SCOPE_ALIASES[token] ?? null
}

/** True when the string contains a TurboPanel `{$` opener. */
export function containsVariableRefOpener(value: string): boolean {
  return value.includes('{$')
}

/**
 * Parse a compose env/build value that must be exactly one `{$…}` ref.
 * Embedded refs (`prefix-{$KEY}`) are invalid.
 */
export function parseExactVariableRef(value: string): ParseVariableRefResult {
  const trimmed = value.trim()
  if (!trimmed.startsWith('{$')) {
    if (containsVariableRefOpener(trimmed)) {
      return {
        ok: false,
        error: 'invalid',
        message:
          'TurboPanel variable refs must be the entire value (e.g. {$KEY} or {$project.KEY})',
      }
    }
    return { ok: false, error: 'not_a_ref' }
  }

  const match = EXACT_REF_RE.exec(trimmed)
  if (!match) {
    return {
      ok: false,
      error: 'invalid',
      message:
        'Invalid TurboPanel variable ref; use {$KEY} or {$scope.KEY} with a Compose-safe key',
    }
  }

  const scopeToken = match[1]
  const key = match[2] ?? ''
  if (!KEY_RE.test(key)) {
    return {
      ok: false,
      error: 'invalid',
      message: `Invalid variable key "${key}"`,
    }
  }

  if (!scopeToken) {
    return { ok: true, ref: { raw: trimmed, scope: null, key } }
  }

  const scope = resolveVariableRefScope(scopeToken)
  if (!scope) {
    return {
      ok: false,
      error: 'invalid',
      message: `Unknown variable scope "${scopeToken}"`,
    }
  }

  return { ok: true, ref: { raw: trimmed, scope, key } }
}

/** Compose-native `${KEY}` / `$KEY` capture for secret-interpolation guards. */
const COMPOSE_INTERPOLATION_RE = /\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)/g

export function collectComposeInterpolationKeys(value: string): string[] {
  const keys: string[] = []
  const seen = new Set<string>()
  for (const match of value.matchAll(COMPOSE_INTERPOLATION_RE)) {
    const key = match[1] ?? match[2]
    if (!key || seen.has(key)) continue
    seen.add(key)
    keys.push(key)
  }
  return keys
}
