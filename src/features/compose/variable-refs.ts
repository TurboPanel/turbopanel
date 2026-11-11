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

export function resolveVariableRefScope(token: string): VariableRefScope | null {
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

/** One piece of text split around embedded `{$…}` references. */
export type EmbeddedRefPart =
  | { kind: 'text'; text: string }
  | { kind: 'ref'; ref: ParsedVariableRef }
  | { kind: 'invalid'; raw: string; message: string }

function isIdentStart(ch: string | undefined): boolean {
  return ch !== undefined && (ch === '_' || (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z'))
}

function isIdentChar(ch: string | undefined): boolean {
  return isIdentStart(ch) || (ch !== undefined && ch >= '0' && ch <= '9')
}

/** End index (exclusive) of an identifier starting at `from`, or `from` when none. */
function identEnd(text: string, from: number): number {
  if (!isIdentStart(text[from])) return from
  let end = from + 1
  while (isIdentChar(text[end])) end++
  return end
}

/**
 * End index (exclusive, past the closing brace) of a reference-shaped token
 * that starts with `{$` at `start`, or -1 when the text there is not shaped
 * like one. `{$$` is never a token: it is how a literal `{$` is written.
 */
function embeddedRefEnd(text: string, start: number): number {
  let i = start + 2
  const first = identEnd(text, i)
  if (first === i) return -1
  i = first
  if (text[i] === '.') {
    const second = identEnd(text, i + 1)
    if (second === i + 1) return -1
    i = second
  }
  return text[i] === '}' ? i + 1 : -1
}

/**
 * Split `text` into literal text and `{$KEY}` / `{$scope.KEY}` references
 * anywhere in it (the same token shape {@link parseExactVariableRef} takes as a
 * whole value). Linear scan. `{$$name}` and any `{$` that is not a complete
 * token stay literal text. Bundle code that widens the reference grammar does
 * it here, in one place.
 */
export function splitEmbeddedRefs(text: string): EmbeddedRefPart[] {
  const parts: EmbeddedRefPart[] = []
  let literalFrom = 0
  let from = 0
  for (;;) {
    const start = text.indexOf('{$', from)
    if (start < 0) break
    const end = embeddedRefEnd(text, start)
    if (end < 0) {
      from = start + 2
      continue
    }
    if (start > literalFrom) parts.push({ kind: 'text', text: text.slice(literalFrom, start) })
    const raw = text.slice(start, end)
    const parsed = parseExactVariableRef(raw)
    if (parsed.ok) parts.push({ kind: 'ref', ref: parsed.ref })
    else if (parsed.error === 'invalid') {
      parts.push({ kind: 'invalid', raw, message: parsed.message })
    } else parts.push({ kind: 'text', text: raw })
    literalFrom = end
    from = end
  }
  if (literalFrom < text.length) parts.push({ kind: 'text', text: text.slice(literalFrom) })
  return parts
}

/** True when `text` holds at least one reference-shaped token. */
export function hasEmbeddedRefToken(text: string): boolean {
  return splitEmbeddedRefs(text).some((part) => part.kind !== 'text')
}

/**
 * True when literal text (references already split out) holds a Compose
 * `${X}` / `$X` interpolation, after `$$` pairs are set aside.
 */
export function hasComposeInterpolation(text: string): boolean {
  return collectComposeInterpolationKeys(text.replaceAll('$$', '')).length > 0
}
