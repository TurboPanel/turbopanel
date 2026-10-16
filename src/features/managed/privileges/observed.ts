/**
 * What a daemon reports when asked for a login's current permissions
 * (`managed-permissions-result`). It is the engine's own words: privilege
 * keywords as the engine spells them, no labels, no judgement. The control
 * plane classifies them against the catalogue (`effective.ts`).
 *
 * Twin of `turbopaneld/src/contracts/cell-messages.ts`
 * (`ManagedPermissionsObserved`). New fields are optional so either side can be
 * a release ahead of the other.
 */

export const OBSERVED_LEVELS = [
  'global',
  'database',
  'schema',
  'table',
  'column',
  'sequence',
  'routine',
  'type',
  'parameter',
  'tablespace',
  'language',
  'foreign',
  'largeobject',
] as const
export type ObservedLevel = (typeof OBSERVED_LEVELS)[number]

/** One grant a login holds, directly or through a role it belongs to. */
export type ObservedGrant = {
  level: ObservedLevel
  /** Postgres database, or MySQL / MariaDB schema. Absent at `global`. */
  database?: string
  /** Postgres schema inside `database`. */
  schema?: string
  /** Table, sequence, routine (with its argument types) or type name. */
  object?: string
  /** Column names, for a column grant. */
  columns?: string[]
  /** Privilege keywords, upper case, in the engine's spelling. */
  privileges: string[]
  /** Subset of `privileges` the holder may pass on (`WITH GRANT OPTION`). */
  grantable?: string[]
  /** The role the grant comes through; absent when granted to the login itself. */
  via?: string
  /** MySQL / MariaDB: the account host row the grant was read from. */
  host?: string
  /** MySQL / MariaDB: the schema name holds an unescaped `_` or `%`, so it is a wildcard pattern. */
  pattern?: boolean
  /** Postgres: the role that made the grant. */
  grantor?: string
}

/** A Postgres default privilege: applied to objects a creator role makes later. */
export type ObservedDefaultGrant = {
  database: string
  /** The role whose future objects get the privileges (`FOR ROLE`). */
  creator: string
  /** Absent: the default applies in every schema. */
  schema?: string
  /** `pg_default_acl.defaclobjtype`: r tables, S sequences, f routines, T types, n schemas. */
  objectType: string
  privileges: string[]
  grantable?: string[]
  via?: string
}

/** Membership of a role (Postgres) or a granted role (MySQL / MariaDB). */
export type ObservedMembership = {
  role: string
  /** Postgres 16 and later; absent on 15 or when not reported. */
  inherit?: boolean
  set?: boolean
  /** May pass the role on (`ADMIN OPTION`). */
  admin?: boolean
  /** The role this membership is held through, when not held directly. */
  via?: string
  grantor?: string
  host?: string
}

export type ObservedAttributes = {
  superuser?: boolean
  createdb?: boolean
  createrole?: boolean
  replication?: boolean
  bypassrls?: boolean
  canLogin?: boolean
  inherit?: boolean
  connectionLimit?: number
}

export type ObservedAccount = {
  host: string
  /** `true` when the account is locked. Absent when not reported. */
  locked?: boolean
}

export type ObservedLogin = {
  /** The engine account name the panel applied. */
  username: string
  /** False when the engine has no such login (nothing else is filled in). */
  exists: boolean
  attributes?: ObservedAttributes
  /** MySQL / MariaDB account rows (one per host). */
  accounts?: ObservedAccount[]
  memberships: ObservedMembership[]
  grants: ObservedGrant[]
  defaults: ObservedDefaultGrant[]
  /** True when a limit cut the lists short. */
  truncated?: boolean
}

export type ManagedPermissionsObserved = {
  engine: string
  /** The server's own version text, for example `18.1` or `9.7.0`. */
  serverVersion?: string
  observedAt: string
  /** Postgres: the databases whose objects were read. */
  databasesRead?: string[]
  /** Postgres: databases that could not be read (error or out of time); their grants are missing. */
  databasesFailed?: string[]
  logins: ObservedLogin[]
}

/** Hard bounds the daemon and the parser both apply. */
export const OBSERVED_MAX_LOGINS = 50
export const OBSERVED_MAX_GRANTS_PER_LOGIN = 2000
export const OBSERVED_MAX_NAME_CHARS = 256
export const OBSERVED_MAX_PRIVILEGES = 64
export const OBSERVED_MAX_COLUMNS = 256

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function name(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= OBSERVED_MAX_NAME_CHARS
    ? value
    : undefined
}

function names(value: unknown, max: number): string[] | undefined {
  if (!Array.isArray(value) || value.length > max) return undefined
  const out: string[] = []
  for (const entry of value) {
    const n = name(entry)
    if (n === undefined) return undefined
    out.push(n)
  }
  return out
}

function bool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function optionalName(target: Record<string, unknown>, key: string, value: unknown): void {
  const n = name(value)
  if (n !== undefined) target[key] = n
}

function parseGrant(value: unknown): ObservedGrant | null {
  if (!isRecord(value)) return null
  const level = value.level
  if (typeof level !== 'string' || !(OBSERVED_LEVELS as readonly string[]).includes(level)) {
    return null
  }
  const privileges = names(value.privileges, OBSERVED_MAX_PRIVILEGES)
  if (!privileges) return null
  const grant: ObservedGrant = { level: level as ObservedLevel, privileges }
  const target = grant as Record<string, unknown>
  for (const key of ['database', 'schema', 'object', 'via', 'host', 'grantor'] as const) {
    optionalName(target, key, value[key])
  }
  const columns = names(value.columns, OBSERVED_MAX_COLUMNS)
  if (columns) grant.columns = columns
  if (value.pattern === true) grant.pattern = true
  const grantable = names(value.grantable, OBSERVED_MAX_PRIVILEGES)
  if (grantable) grant.grantable = grantable
  return grant
}

function parseDefault(value: unknown): ObservedDefaultGrant | null {
  if (!isRecord(value)) return null
  const database = name(value.database)
  const creator = name(value.creator)
  const objectType = typeof value.objectType === 'string' ? value.objectType : undefined
  const privileges = names(value.privileges, OBSERVED_MAX_PRIVILEGES)
  if (!database || !creator || !objectType || objectType.length !== 1 || !privileges) return null
  const out: ObservedDefaultGrant = { database, creator, objectType, privileges }
  const target = out as Record<string, unknown>
  optionalName(target, 'schema', value.schema)
  optionalName(target, 'via', value.via)
  const grantable = names(value.grantable, OBSERVED_MAX_PRIVILEGES)
  if (grantable) out.grantable = grantable
  return out
}

function parseMembership(value: unknown): ObservedMembership | null {
  if (!isRecord(value)) return null
  const role = name(value.role)
  if (!role) return null
  const out: ObservedMembership = { role }
  const inherit = bool(value.inherit)
  const set = bool(value.set)
  const admin = bool(value.admin)
  if (inherit !== undefined) out.inherit = inherit
  if (set !== undefined) out.set = set
  if (admin !== undefined) out.admin = admin
  const target = out as Record<string, unknown>
  optionalName(target, 'via', value.via)
  optionalName(target, 'grantor', value.grantor)
  optionalName(target, 'host', value.host)
  return out
}

const ATTRIBUTE_BOOLEANS = [
  'superuser',
  'createdb',
  'createrole',
  'replication',
  'bypassrls',
  'canLogin',
  'inherit',
] as const

function parseAttributes(value: unknown): ObservedAttributes | undefined {
  if (!isRecord(value)) return undefined
  const out: ObservedAttributes = {}
  for (const key of ATTRIBUTE_BOOLEANS) {
    const flag = bool(value[key])
    if (flag !== undefined) out[key] = flag
  }
  if (typeof value.connectionLimit === 'number' && Number.isInteger(value.connectionLimit)) {
    out.connectionLimit = value.connectionLimit
  }
  return out
}

function parseAccount(value: unknown): ObservedAccount | null {
  if (!isRecord(value)) return null
  const host = name(value.host)
  if (!host) return null
  const out: ObservedAccount = { host }
  const locked = bool(value.locked)
  if (locked !== undefined) out.locked = locked
  return out
}

function parseList<T>(value: unknown, parse: (entry: unknown) => T | null, max: number): T[] {
  if (!Array.isArray(value)) return []
  const out: T[] = []
  for (const entry of value.slice(0, max)) {
    const parsed = parse(entry)
    if (parsed) out.push(parsed)
  }
  return out
}

function parseLogin(value: unknown): ObservedLogin | null {
  if (!isRecord(value)) return null
  const username = name(value.username)
  if (!username || typeof value.exists !== 'boolean') return null
  const login: ObservedLogin = {
    username,
    exists: value.exists,
    memberships: parseList(value.memberships, parseMembership, OBSERVED_MAX_GRANTS_PER_LOGIN),
    grants: parseList(value.grants, parseGrant, OBSERVED_MAX_GRANTS_PER_LOGIN),
    defaults: parseList(value.defaults, parseDefault, OBSERVED_MAX_GRANTS_PER_LOGIN),
  }
  const attributes = parseAttributes(value.attributes)
  if (attributes) login.attributes = attributes
  const accounts = parseList(value.accounts, parseAccount, 256)
  if (accounts.length > 0) login.accounts = accounts
  if (value.truncated === true) login.truncated = true
  return login
}

/**
 * Parse a daemon report. Malformed entries are dropped, never repaired; a
 * report that is not an object with a timestamp and a login list is `null`.
 */
export function parseManagedPermissionsObserved(value: unknown): ManagedPermissionsObserved | null {
  if (!isRecord(value)) return null
  if (typeof value.engine !== 'string' || typeof value.observedAt !== 'string') return null
  if (!Number.isFinite(Date.parse(value.observedAt)) || !Array.isArray(value.logins)) return null
  const out: ManagedPermissionsObserved = {
    engine: value.engine,
    observedAt: value.observedAt,
    logins: parseList(value.logins, parseLogin, OBSERVED_MAX_LOGINS),
  }
  const version = name(value.serverVersion)
  if (version) out.serverVersion = version
  const databases = names(value.databasesRead, 1000)
  if (databases) out.databasesRead = databases
  const failed = names(value.databasesFailed, 1000)
  if (failed) out.databasesFailed = failed
  return out
}
