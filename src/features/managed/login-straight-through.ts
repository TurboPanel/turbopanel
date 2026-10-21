/**
 * "Connect straight through (no connection sharing)": a PostgreSQL-only,
 * per-login switch. When on, the database front door passes that login's
 * connection straight to the server (one server connection per client
 * session, no connection reuse, no read split). It exists for drivers that
 * send a Flush message after preparing a query, which the shared path does not
 * support.
 *
 * Stored on `login.is_straight_through`: NULL means the owner never chose, so
 * the default applies (on for a Migration-level login, off for the rest). A
 * login limited to certain addresses never connects straight through, because
 * the front door enforces the limit on the shared path.
 */

export const STRAIGHT_THROUGH_CONFLICT_ERROR = 'straight_through_conflicts_with_source_limit'
export const STRAIGHT_THROUGH_CONFLICT_MESSAGE =
  'A login that connects straight through cannot be limited to certain addresses. Turn one off.'
export const STRAIGHT_THROUGH_ENGINE_ERROR = 'straight_through_postgres_only'
export const STRAIGHT_THROUGH_ENGINE_MESSAGE =
  'Connecting straight through is only available for PostgreSQL logins.'
export const STRAIGHT_THROUGH_ROLE_ERROR = 'straight_through_login_not_allowed'
export const STRAIGHT_THROUGH_ROLE_MESSAGE =
  'Connecting straight through can only be set on logins you created, not on the cluster administrator or replication logins.'
export const STRAIGHT_THROUGH_INVALID_MESSAGE = 'straightThrough must be true, false or null.'

/** The Migration-level privilege (`owner`), which switches the default on. */
const MIGRATION_PRIVILEGE = 'owner'

export type StraightThroughFacts = {
  engine: string
  role: string
  privileges: readonly string[]
  /** `read-write` (primary) or `read-only` (replicas); only read/write is ever on by default. */
  connectionRole: string
  /** `undefined` or empty means anywhere. */
  allowedSources: readonly string[] | undefined
  /** Stored choice; `undefined` means the owner never chose. */
  straightThrough?: boolean
}

export type StraightThroughResolved = {
  /** What the front door will do for this login. */
  value: boolean
  /** True when `value` comes from the default rather than a stored choice. */
  isDefault: boolean
}

const hasSourceLimit = (sources: readonly string[] | undefined): boolean =>
  sources !== undefined && sources.length > 0

/** The effective setting: the stored choice, else the default, and never on with a source limit. */
export function resolveStraightThrough(facts: StraightThroughFacts): StraightThroughResolved {
  if (facts.engine !== 'postgres' || facts.role !== 'user') {
    return { value: false, isDefault: false }
  }
  const isDefault = facts.straightThrough === undefined
  const wanted = isDefault
    ? facts.privileges.includes(MIGRATION_PRIVILEGE) && facts.connectionRole === 'read-write'
    : facts.straightThrough === true
  return { value: wanted && !hasSourceLimit(facts.allowedSources), isDefault }
}

export type StraightThroughRefusal = {
  status: 400
  error: string
  message: string
}

/** Type check of a request value: absent, a boolean, or `null` (back to the default). */
export function isStraightThroughValue(value: unknown): value is boolean | null | undefined {
  return value === undefined || value === null || typeof value === 'boolean'
}

/**
 * Refuses a login whose settings after the change would turn the switch on
 * for something it cannot apply to, or together with a source limit. `after`
 * is the state the login ends in (stored choice and source limit already
 * merged with the request); only an explicit `true` is ever refused.
 */
export function refuseStraightThrough(
  after: Pick<StraightThroughFacts, 'engine' | 'role' | 'allowedSources' | 'straightThrough'>
): StraightThroughRefusal | null {
  if (after.straightThrough !== true) return null
  if (after.engine !== 'postgres') {
    return {
      status: 400,
      error: STRAIGHT_THROUGH_ENGINE_ERROR,
      message: STRAIGHT_THROUGH_ENGINE_MESSAGE,
    }
  }
  if (after.role !== 'user') {
    return {
      status: 400,
      error: STRAIGHT_THROUGH_ROLE_ERROR,
      message: STRAIGHT_THROUGH_ROLE_MESSAGE,
    }
  }
  if (hasSourceLimit(after.allowedSources)) {
    return {
      status: 400,
      error: STRAIGHT_THROUGH_CONFLICT_ERROR,
      message: STRAIGHT_THROUGH_CONFLICT_MESSAGE,
    }
  }
  return null
}

/** The stored choice and source limit after a request (absent keys keep the stored value). */
export function straightThroughAfter(
  current: Pick<StraightThroughFacts, 'allowedSources' | 'straightThrough'>,
  input: { allowedSources?: string[] | null; straightThrough?: boolean | null }
): Pick<StraightThroughFacts, 'allowedSources' | 'straightThrough'> {
  return {
    allowedSources:
      input.allowedSources === undefined
        ? current.allowedSources
        : (input.allowedSources ?? undefined),
    straightThrough:
      input.straightThrough === undefined
        ? current.straightThrough
        : (input.straightThrough ?? undefined),
  }
}

type PatchSettings = Pick<
  StraightThroughFacts,
  'privileges' | 'connectionRole' | 'allowedSources'
> & {
  role: string
  straightThrough?: boolean
}

type PatchChange = {
  privileges?: string[]
  connectionRole?: string
  allowedSources?: string[] | null
  straightThrough?: boolean | null
}

/** Refusal for a PATCH, judged on the state after it (both halves merged with the stored ones). */
export function refuseStraightThroughPatch(
  engine: string,
  current: PatchSettings,
  input: PatchChange
): StraightThroughRefusal | null {
  return refuseStraightThrough({
    engine,
    role: current.role,
    ...straightThroughAfter(current, input),
  })
}

/** Dry-run lines for a PATCH: what changes in the effective setting, if anything. */
export function describeStraightThroughPatch(
  engine: string,
  current: PatchSettings,
  change: PatchChange
): string[] {
  const resolve = (settings: PatchSettings) => resolveStraightThrough({ engine, ...settings })
  return describeStraightThroughChange(
    resolve(current),
    resolve({
      role: current.role,
      privileges: change.privileges ?? current.privileges,
      connectionRole: change.connectionRole ?? current.connectionRole,
      ...straightThroughAfter(current, change),
    })
  )
}

/** Plain-words line for the dry-run preview when the effective setting changes. */
export function describeStraightThroughChange(
  before: StraightThroughResolved,
  after: StraightThroughResolved
): string[] {
  if (before.value === after.value) return []
  return [
    after.value
      ? 'Connect this login straight through the front door: one server connection per client session, no connection sharing and no read split'
      : 'Send this login back through the normal shared path of the front door',
  ]
}
