/**
 * Top-level **authored** `x-turbopanel` extension (Compose `x-turbopanel`).
 *
 * Two different objects share the `x-turbopanel` key and this module owns
 * exactly one of them:
 *
 * - **authored** ({@link TurbopanelRootExtension}) — what an operator writes and
 *   what is stored on the project / environment row. Today that is `principals`
 *   and nothing else.
 * - **runtime** (`TurbopanelRuntimeRootExtension` in `./placement.ts`) — what
 *   compile-time stamps onto a compiled snapshot for audit. That is `placement`
 *   and nothing else.
 *
 * They are deliberately *separate types with no shared base*: an authored root
 * has no `placement` key to make optional, and a runtime root is never
 * hand-written. Merging them into one all-optional type is what would let a
 * `placement`-bearing object pass where an authored root is expected, which is
 * the exact confusion `validateComposeDocument` exists to reject.
 *
 * ## No `schemaVersion`
 *
 * There is none, on purpose — modern Compose dropped `version:` for the same
 * reason. The evolution story is instead **unknown keys diagnose**: every
 * top-level key that is not `principals` is reported at save time, with a
 * redirect message for the ones operators plausibly reach for. A field that
 * silently does nothing is the failure a version stamp is usually invented to
 * paper over; refusing it outright removes the need for the stamp.
 */

import {
  isPrincipalAlias,
  SERVICE_DESCRIPTION_MAX_LENGTH,
  type ServiceTurbopanelValidationIssue,
} from './service-kind.ts'

/**
 * How a principal declared in compose reaches its account.
 *
 * `none` is the default when omitted: an alias that only *exists* (so a service
 * can be owned by it and files can be chowned to it) grants no login at all.
 * Naming the level in compose is a request; the account's real shell and group
 * membership are still resolved control-plane side from `principal.options`,
 * which stays the single source of truth for what the host actually does.
 */
/**
 * Top-level key the authored root block lives under. Spelled here rather than
 * imported from `./placement.ts`, which owns the *runtime* object under the
 * same key — see the module comment for why the two never share a type.
 */
export const TURBOPANEL_ROOT_EXTENSION_KEY = 'x-turbopanel'

export type PrincipalAccess = 'none' | 'sftp' | 'ssh'

export const PRINCIPAL_ACCESS_VALUES: readonly PrincipalAccess[] = [
  'none',
  'sftp',
  'ssh',
]

/** Default when `access` is omitted — existence without login. */
export const DEFAULT_PRINCIPAL_ACCESS: PrincipalAccess = 'none'

/**
 * One entry in `x-turbopanel.principals`.
 *
 * Deliberately tiny. A principal in compose is an **alias** — a document-local
 * name a service can point at — not the account record. Everything that decides
 * what the account *is* on the host (uid, gid, home, shell, keys, password)
 * lives on the `principal` row and its `options`, where it is a privilege
 * decision under `organization:manage` rather than a line of YAML anyone with
 * compose edit rights can write. {@link ROOT_KEY_REDIRECTS} says so out loud for
 * every one of those keys.
 */
export type PrincipalSpec = {
  /** Operator-facing note. TurboPanel-only metadata; Docker never sees it. */
  description?: string
  /** Requested access level. Omitted means {@link DEFAULT_PRINCIPAL_ACCESS}. */
  access?: PrincipalAccess
}

/**
 * The **authored** top-level `x-turbopanel` block.
 *
 * Has no `placement` key by construction. See the module comment.
 */
export type TurbopanelRootExtension = {
  principals?: Record<string, PrincipalSpec>
}

/** Top-level keys an author may write. Anything else is reported. */
export const AUTHORED_ROOT_EXTENSION_KEYS: ReadonlySet<string> = new Set([
  'principals',
])

/**
 * Document-local alias charset.
 *
 * Re-exported rather than declared: the canonical rule lives in
 * `./service-kind.ts` next to `x-turbopanel.principal`, the per-service field
 * that *references* an alias. This module already imports that one, so keeping
 * the regex here and importing it back is the direction that would close a
 * cycle. Every existing caller still reaches for it here.
 */
export { isPrincipalAlias }
export { PRINCIPAL_ALIAS_RE } from './service-kind.ts'

/**
 * The one message for "placement is not a stored compose shape".
 *
 * Lives here rather than in `validate.ts` so the root-extension pass and the
 * placement rejection cannot drift into two different sentences for one rule.
 */
export const PLACEMENT_NOT_STORED_MESSAGE =
  'placement is not stored in compose; use environment.server_id'

/**
 * Keys that are refused with a pointer rather than a bare "unknown".
 *
 * Each of these is a real concept an author might reasonably expect to write
 * here; the message's job is to name where it actually lives so the answer is
 * "over there", not "no".
 */
export const ROOT_KEY_REDIRECTS: Readonly<Record<string, string>> = {
  placement: PLACEMENT_NOT_STORED_MESSAGE,
  server_id: PLACEMENT_NOT_STORED_MESSAGE,
  uid:
    'uid is not authored in compose; operator id overrides live on principal.options',
  gid:
    'gid is not authored in compose; operator id overrides live on principal.options',
  home:
    "home is not authored in compose; the daemon derives a principal's home directory (turbopaneld ensure-principal.ts)",
  shell:
    'shell is not authored in compose; the access level is encoded by principal.options.shell',
  password:
    'password is not authored in compose; principal credentials live on the ssh table',
  authorized_keys:
    'authorized_keys is not authored in compose; principal keys live on the ssh table',
  cgroup:
    'cgroup is not authored in compose; resource limits are org and server policy',
}

/** Keys a principal entry may carry. Anything else is reported. */
const PRINCIPAL_SPEC_KEYS: ReadonlySet<string> = new Set([
  'description',
  'access',
])

function isPlainMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isPrincipalAccess(value: unknown): value is PrincipalAccess {
  return typeof value === 'string' &&
    (PRINCIPAL_ACCESS_VALUES as readonly string[]).includes(value)
}

function readTrimmedString(
  value: unknown,
  maxLength: number,
): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > maxLength) return undefined
  return trimmed
}

/**
 * Permissive read, matching every other parser in this directory: anything
 * malformed is **dropped** rather than thrown, so a bad document still opens in
 * the editor. {@link collectRootExtensionValidationIssues} is the strict pass
 * that turns the same input into operator-facing messages at save time.
 *
 * Returns `null` when the value is present but not a mapping at all.
 */
export function parseRootExtension(
  value: unknown,
): TurbopanelRootExtension | null {
  if (value === null || value === undefined) return {}
  if (!isPlainMapping(value)) return null

  const principals = parsePrincipals(value.principals)
  return principals ? { principals } : {}
}

function parsePrincipalSpec(raw: unknown): PrincipalSpec | null {
  if (raw !== null && raw !== undefined && !isPlainMapping(raw)) return null

  const spec: PrincipalSpec = {}
  if (isPlainMapping(raw)) {
    const description = readTrimmedString(
      raw.description,
      SERVICE_DESCRIPTION_MAX_LENGTH,
    )
    if (description) spec.description = description
    if (isPrincipalAccess(raw.access)) spec.access = raw.access
  }
  return spec
}

function parsePrincipals(
  value: unknown,
): Record<string, PrincipalSpec> | undefined {
  if (!isPlainMapping(value)) return undefined

  const principals: Record<string, PrincipalSpec> = {}
  for (const [alias, raw] of Object.entries(value)) {
    if (!isPrincipalAlias(alias)) continue
    const spec = parsePrincipalSpec(raw)
    if (spec === null) continue
    principals[alias] = spec
  }

  return Object.keys(principals).length > 0 ? principals : undefined
}

/**
 * Every alias a compose document's **root** declares.
 *
 * Pure and DB-free, which is the whole point: the alias-resolution rules — the
 * linter's `knownPrincipalAliases`, the project/environment write boundary, and
 * deploy-prepare's materialization pass — all need the same answer, and any of
 * them recomputing it from raw keys is how the three drift.
 *
 * Takes the compose `data` mapping (not the document) so a caller holding
 * either a stored document or a merged one can ask without unwrapping first.
 * A malformed root yields an empty set rather than throwing: a bad document
 * still has to open in the editor.
 */
export function principalAliasesInComposeData(data: unknown): Set<string> {
  if (!isPlainMapping(data)) return new Set()
  const parsed = parseRootExtension(data[TURBOPANEL_ROOT_EXTENSION_KEY])
  return new Set(Object.keys(parsed?.principals ?? {}))
}

/** The access an entry asks for, resolving the omitted case. */
export function principalAccessOf(spec: PrincipalSpec): PrincipalAccess {
  return spec.access ?? DEFAULT_PRINCIPAL_ACCESS
}

/**
 * Strict, save-time validation of the top-level `x-turbopanel` block.
 *
 * `basePath` is the dotted path of the extension itself (`x-turbopanel`), so
 * issue paths read `x-turbopanel.principals.<alias>.access`.
 *
 * The caller has already established that the value is a mapping and reported
 * it otherwise; passing a non-mapping here yields no issues rather than a
 * duplicate message.
 */
export function collectRootExtensionValidationIssues(
  basePath: string,
  value: unknown,
): ServiceTurbopanelValidationIssue[] {
  if (!isPlainMapping(value)) return []

  const issues: ServiceTurbopanelValidationIssue[] = []
  for (const key of Object.keys(value)) {
    if (AUTHORED_ROOT_EXTENSION_KEYS.has(key)) continue
    issues.push({
      path: `${basePath}.${key}`,
      message: ROOT_KEY_REDIRECTS[key] ?? unknownRootKeyMessage(key),
    })
  }

  if ('principals' in value) {
    issues.push(...validatePrincipals(`${basePath}.principals`, value.principals))
  }

  return issues
}

function unknownRootKeyMessage(key: string): string {
  const known = [...AUTHORED_ROOT_EXTENSION_KEYS].sort((a, b) =>
    a.localeCompare(b)
  )
  return `unknown x-turbopanel key "${key}"; supported: ${known.join(', ')}`
}

function validatePrincipals(
  basePath: string,
  value: unknown,
): ServiceTurbopanelValidationIssue[] {
  if (!isPlainMapping(value)) {
    return [{
      path: basePath,
      message: 'principals must be a mapping of alias to principal',
    }]
  }

  const issues: ServiceTurbopanelValidationIssue[] = []
  for (const [alias, raw] of Object.entries(value)) {
    const path = `${basePath}.${alias}`
    if (!isPrincipalAlias(alias)) {
      issues.push({
        path,
        // It is a document-local reference, so the charset is about being
        // referable and quotable, not about the eventual Unix account name.
        message:
          'principal alias must start with a letter and contain only letters, digits, "-", and "_" (at most 64 characters)',
      })
      continue
    }
    issues.push(...validatePrincipalSpec(path, raw))
  }
  return issues
}

function validatePrincipalSpec(
  basePath: string,
  value: unknown,
): ServiceTurbopanelValidationIssue[] {
  // `alias:` with nothing under it is the minimum useful declaration — an alias
  // that exists and grants no login — so an empty body is valid, not missing.
  if (value === null || value === undefined) return []
  if (!isPlainMapping(value)) {
    return [{ path: basePath, message: 'principal must be a mapping' }]
  }

  const issues: ServiceTurbopanelValidationIssue[] = []
  for (const key of Object.keys(value)) {
    if (PRINCIPAL_SPEC_KEYS.has(key)) continue
    issues.push({
      path: `${basePath}.${key}`,
      message: ROOT_KEY_REDIRECTS[key] ?? unknownPrincipalKeyMessage(key),
    })
  }

  if ('description' in value) {
    const description = value.description
    if (typeof description !== 'string') {
      issues.push({
        path: `${basePath}.description`,
        message: 'description must be a string',
      })
    } else if (description.trim().length > SERVICE_DESCRIPTION_MAX_LENGTH) {
      issues.push({
        path: `${basePath}.description`,
        message:
          `description must be at most ${SERVICE_DESCRIPTION_MAX_LENGTH} characters`,
      })
    }
  }

  if ('access' in value && !isPrincipalAccess(value.access)) {
    issues.push({
      path: `${basePath}.access`,
      message: 'access must be "none", "sftp", or "ssh"',
    })
  }

  return issues
}

function unknownPrincipalKeyMessage(key: string): string {
  const known = [...PRINCIPAL_SPEC_KEYS].sort((a, b) => a.localeCompare(b))
  return `unknown principal key "${key}"; supported: ${known.join(', ')}`
}
