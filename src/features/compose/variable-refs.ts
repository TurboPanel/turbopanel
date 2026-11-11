/**
 * TurboPanel compose interpolation: `{$KEY}`, `{$scope.KEY}` or, for a database
 * binding of the service, `{$db.<binding>.<field>}`.
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

/**
 * Fields of a database binding a `{$db.<binding>.<field>}` reference can read.
 * Lowercase snake; the binding is the binding's key prefix as stored.
 */
export const DB_REF_FIELDS = [
  'host',
  'port',
  'name',
  'user',
  'password',
  'url',
  'ca_file',
  'ca_text',
  'ssl_mode',
  'driver',
  'read_split',
] as const

export type DbRefField = (typeof DB_REF_FIELDS)[number]

const DB_REF_SCOPE = 'db'

const KEY_RE = /^[A-Za-z_]\w*$/
const EXACT_REF_RE = /^\{\$(?:([A-Za-z_]\w*)\.)?(?:([A-Za-z_]\w*)\.)?([A-Za-z_]\w*)\}$/

export type ScopedVariableRef = {
  raw: string
  scope: VariableRefScope | null
  key: string
}

/** `{$db.<binding>.<field>}`: one field of a database binding of this service. */
export type DbVariableRef = {
  raw: string
  scope: 'db'
  binding: string
  field: DbRefField
  key: DbRefField
}

export type ParsedVariableRef = ScopedVariableRef | DbVariableRef

export function isDbRef(ref: ParsedVariableRef): ref is DbVariableRef {
  return ref.scope === DB_REF_SCOPE
}

export function isDbRefField(value: string): value is DbRefField {
  return (DB_REF_FIELDS as readonly string[]).includes(value)
}

/** The reference as written, for messages (never carries a value). */
export function formatVariableRef(ref: ParsedVariableRef): string {
  if (isDbRef(ref)) return `{$db.${ref.binding}.${ref.field}}`
  return ref.scope ? `{$${ref.scope}.${ref.key}}` : `{$${ref.key}}`
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
        'Invalid TurboPanel variable ref; use {$KEY}, {$scope.KEY} or {$db.<binding>.<field>} with a Compose-safe key',
    }
  }

  const [, first, second, key = ''] = match
  if (!KEY_RE.test(key)) {
    return {
      ok: false,
      error: 'invalid',
      message: `Invalid variable key "${key}"`,
    }
  }

  if (second !== undefined) return parseDbRef(trimmed, first, second, key)
  if (!first) {
    return { ok: true, ref: { raw: trimmed, scope: null, key } }
  }

  const scope = resolveVariableRefScope(first)
  if (!scope) {
    return {
      ok: false,
      error: 'invalid',
      message: `Unknown variable scope "${first}"`,
    }
  }

  return { ok: true, ref: { raw: trimmed, scope, key } }
}

function parseDbRef(
  raw: string,
  scopeToken: string | undefined,
  binding: string,
  field: string
): ParseVariableRefResult {
  if (scopeToken !== DB_REF_SCOPE) {
    return {
      ok: false,
      error: 'invalid',
      message: `Unknown variable scope "${scopeToken ?? ''}"`,
    }
  }
  if (!isDbRefField(field)) {
    return {
      ok: false,
      error: 'invalid',
      message: `Unknown database field "${field}"; use ${DB_REF_FIELDS.join(', ')}`,
    }
  }
  return { ok: true, ref: { raw, scope: DB_REF_SCOPE, binding, field, key: field } }
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
  for (let dots = 0; dots < 2 && text[i] === '.'; dots++) {
    const next = identEnd(text, i + 1)
    if (next === i + 1) return -1
    i = next
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
