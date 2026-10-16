/**
 * Turn a daemon's raw permission report into the effective-permissions view:
 * every privilege joined to its catalogue entry (plain label, whether a site
 * owner's login may hold it), plus role memberships and role attributes.
 *
 * Read only. Everything is reported as `observed`; the panel keeps no ledger
 * of what it granted yet (see `DESIGN.md`, "Panel ledger"), so nothing here
 * can say "set by the panel" versus "set outside the panel" and nothing is
 * ever revoked because of this view.
 */

import { compareSeries } from './series.ts'
import type {
  PrivilegeAllowance,
  PrivilegeCatalogue,
  PrivilegeEntry,
  PrivilegeLevel,
} from './types.ts'
import type {
  ManagedPermissionsObserved,
  ObservedAttributes,
  ObservedDefaultGrant,
  ObservedGrant,
  ObservedLogin,
  ObservedMembership,
} from './observed.ts'

export type EffectivePrivilege = {
  keyword: string
  /** Catalogue id, or `null` when this series has no such privilege. */
  catalogueId: string | null
  label: string
  explanation: string
  /** `unknown`: not in the catalogue for this version, so the panel cannot judge it. */
  allowed: PrivilegeAllowance | 'unknown'
  reason?: string
  /** The holder may pass this privilege on. */
  grantable: boolean
}

export type EffectiveGrant = {
  level: PrivilegeLevel
  database?: string
  schema?: string
  object?: string
  columns?: string[]
  host?: string
  /** MySQL / MariaDB: the schema name is a wildcard pattern (`shop_%`); shown, never edited. */
  pattern?: boolean
  via?: string
  /** Plain name for a grant that applies to everyone (Postgres PUBLIC): `everyone`. */
  viaLabel?: string
  grantor?: string
  privileges: EffectivePrivilege[]
  /** Where the grant came from. Always `observed` until the panel keeps a ledger. */
  origin: 'observed'
}

export type EffectiveDefault = {
  database: string
  creator: string
  schema?: string
  /** Plain name of what the default covers, for example "New tables and views". */
  appliesTo: string
  objectType: string
  via?: string
  privileges: EffectivePrivilege[]
  origin: 'observed'
}

export type EffectiveMembership = {
  role: string
  label?: string
  explanation?: string
  /** `predefined`: built into Postgres. `panel`: a role the panel reserves. `other`: anything else. */
  kind: 'predefined' | 'panel' | 'other'
  allowed: PrivilegeAllowance | 'unknown'
  reason?: string
  inherit?: boolean
  set?: boolean
  admin?: boolean
  /** The role this membership is held through; absent when direct. */
  via?: string
  host?: string
  origin: 'observed'
}

export type EffectiveAttribute = {
  name: string
  label: string
  explanation: string
  value: boolean | number
  allowed: PrivilegeAllowance
  reason?: string
}

export type EffectivePermissions = {
  username: string
  exists: boolean
  engine: string
  series: string
  observedAt: string
  serverVersion?: string
  attributes: EffectiveAttribute[]
  accounts: { host: string; locked?: boolean }[]
  memberships: EffectiveMembership[]
  grants: EffectiveGrant[]
  defaults: EffectiveDefault[]
  /** True when the daemon cut a list short. */
  truncated: boolean
  /** Privileges and memberships that a site owner's login may not hold. */
  outsidePolicyCount: number
  /** Ledger state: the panel does not record its own grants yet. */
  ledger: { available: false }
}

const ALL = 'ALL PRIVILEGES'
const WHOLE_SERVER_REASON =
  'Granted on every database on the server, wider than any single database.'
const SYSTEM_TARGET_REASON = 'It targets a system database the panel keeps off limits.'

type Index = Map<string, PrivilegeEntry>

function indexCatalogue(catalogue: PrivilegeCatalogue): Index {
  const index: Index = new Map()
  for (const entry of catalogue.privileges) {
    index.set(`${entry.level}:${entry.keyword}`, entry)
    for (const alias of entry.aliases ?? []) index.set(`${entry.level}:${alias}`, entry)
  }
  return index
}

function fromEntry(entry: PrivilegeEntry, keyword: string, grantable: boolean): EffectivePrivilege {
  return {
    keyword,
    catalogueId: entry.id,
    label: entry.label,
    explanation: entry.explanation,
    allowed: entry.allowed,
    ...(entry.reason === undefined ? {} : { reason: entry.reason }),
    grantable,
  }
}

function unknownPrivilege(keyword: string, grantable: boolean): EffectivePrivilege {
  return {
    keyword,
    catalogueId: null,
    label: keyword,
    explanation: 'This version of the database does not list this privilege in the panel.',
    allowed: 'unknown',
    grantable,
  }
}

/** The database-level privileges `ALL PRIVILEGES` stands for on a MySQL-family engine. */
function expandAll(catalogue: PrivilegeCatalogue, level: PrivilegeLevel): PrivilegeEntry[] {
  return catalogue.privileges.filter(
    (entry) => entry.level === level && entry.keyword !== 'GRANT OPTION' && entry.grid
  )
}

function classifyOne(
  index: Index,
  catalogue: PrivilegeCatalogue,
  level: PrivilegeLevel,
  keyword: string,
  grantable: boolean,
  wide: boolean
): EffectivePrivilege[] {
  if (keyword === ALL && catalogue.engine !== 'postgres') {
    if (level === 'global') {
      return [
        {
          keyword,
          catalogueId: null,
          label: 'Everything on the server',
          explanation: 'Every privilege the server has.',
          allowed: 'no',
          reason: WHOLE_SERVER_REASON,
          grantable,
        },
      ]
    }
    return expandAll(catalogue, level).map((entry) => fromEntry(entry, entry.keyword, grantable))
  }
  if (wide) {
    // A database-level privilege granted on `*.*` is wider than the panel ever grants.
    const entry = index.get(`database:${keyword}`) ?? index.get(`table:${keyword}`)
    if (entry) {
      return [
        { ...fromEntry(entry, keyword, grantable), allowed: 'no', reason: WHOLE_SERVER_REASON },
      ]
    }
  }
  const entry = index.get(`${level}:${keyword}`)
  return [entry ? fromEntry(entry, keyword, grantable) : unknownPrivilege(keyword, grantable)]
}

function classifyPrivileges(
  index: Index,
  catalogue: PrivilegeCatalogue,
  level: PrivilegeLevel,
  privileges: readonly string[],
  grantable: readonly string[] | undefined
): EffectivePrivilege[] {
  const grantableSet = new Set(grantable ?? [])
  const wide = catalogue.engine !== 'postgres' && level === 'global'
  const out: EffectivePrivilege[] = []
  for (const keyword of privileges) {
    // MySQL and MariaDB report GRANT OPTION as a privilege in its own right.
    const canPass = grantableSet.has(keyword) || privileges.includes('GRANT OPTION')
    out.push(
      ...classifyOne(index, catalogue, level, keyword, canPass && keyword !== 'GRANT OPTION', wide)
    )
  }
  return out
}

function isBlockedTarget(catalogue: PrivilegeCatalogue, grant: ObservedGrant): boolean {
  const blockedDatabases = catalogue.blocked.databases
  if (catalogue.engine === 'postgres') {
    return grant.schema !== undefined && catalogue.blocked.schemas.includes(grant.schema)
  }
  return grant.database !== undefined && blockedDatabases.includes(grant.database)
}

function classifyGrant(
  index: Index,
  catalogue: PrivilegeCatalogue,
  grant: ObservedGrant
): EffectiveGrant {
  const blocked = isBlockedTarget(catalogue, grant)
  const privileges = classifyPrivileges(
    index,
    catalogue,
    grant.level,
    grant.privileges,
    grant.grantable
  ).map((privilege) =>
    blocked ? { ...privilege, allowed: 'no' as const, reason: SYSTEM_TARGET_REASON } : privilege
  )
  const out: EffectiveGrant = { level: grant.level, privileges, origin: 'observed' }
  for (const key of ['database', 'schema', 'object', 'host', 'via', 'grantor'] as const) {
    const value = grant[key]
    if (value !== undefined) out[key] = value
  }
  if (grant.columns) out.columns = grant.columns
  if (grant.pattern === true) out.pattern = true
  if (grant.via === 'PUBLIC') out.viaLabel = 'everyone'
  return out
}

function defaultObjectInfo(catalogue: PrivilegeCatalogue, letter: string) {
  return catalogue.defaultPrivilegeObjects.find((object) => object.letter === letter)
}

function classifyDefault(
  index: Index,
  catalogue: PrivilegeCatalogue,
  item: ObservedDefaultGrant
): EffectiveDefault {
  const object = defaultObjectInfo(catalogue, item.objectType)
  const level = object?.level ?? 'table'
  const out: EffectiveDefault = {
    database: item.database,
    creator: item.creator,
    appliesTo: object?.label ?? `New objects (${item.objectType})`,
    objectType: item.objectType,
    privileges: classifyPrivileges(index, catalogue, level, item.privileges, item.grantable),
    origin: 'observed',
  }
  if (item.schema !== undefined) out.schema = item.schema
  if (item.via !== undefined) out.via = item.via
  return out
}

function classifyMembership(
  catalogue: PrivilegeCatalogue,
  item: ObservedMembership
): EffectiveMembership {
  const base = { role: item.role, origin: 'observed' as const }
  const flags: Partial<EffectiveMembership> = {}
  if (item.inherit !== undefined) flags.inherit = item.inherit
  if (item.set !== undefined) flags.set = item.set
  if (item.admin !== undefined) flags.admin = item.admin
  if (item.via !== undefined) flags.via = item.via
  if (item.host !== undefined) flags.host = item.host
  const role = catalogue.roles.find((entry) => entry.name === item.role)
  if (role) {
    return {
      ...base,
      ...flags,
      kind: 'predefined',
      label: role.label,
      explanation: role.explanation,
      allowed: role.allowed,
      ...(role.reason === undefined ? {} : { reason: role.reason }),
    }
  }
  const panel = catalogue.blocked.reservedPrefixes.some((prefix) => item.role.startsWith(prefix))
  return { ...base, ...flags, kind: panel ? 'panel' : 'other', allowed: panel ? 'yes' : 'unknown' }
}

const ATTRIBUTE_KEYS: Readonly<Record<string, keyof ObservedAttributes>> = {
  rolsuper: 'superuser',
  rolcreatedb: 'createdb',
  rolcreaterole: 'createrole',
  rolreplication: 'replication',
  rolbypassrls: 'bypassrls',
  rolcanlogin: 'canLogin',
  rolinherit: 'inherit',
  rolconnlimit: 'connectionLimit',
}

function classifyAttributes(
  catalogue: PrivilegeCatalogue,
  attributes: ObservedAttributes | undefined
): EffectiveAttribute[] {
  if (!attributes) return []
  const out: EffectiveAttribute[] = []
  for (const entry of catalogue.attributes) {
    const key = ATTRIBUTE_KEYS[entry.column]
    const value = key === undefined ? undefined : attributes[key]
    if (value === undefined) continue
    out.push({
      name: entry.name,
      label: entry.label,
      explanation: entry.explanation,
      value,
      allowed: entry.allowed,
      ...(entry.reason === undefined ? {} : { reason: entry.reason }),
    })
  }
  return out
}

function countOutsidePolicy(
  grants: readonly { privileges: readonly EffectivePrivilege[] }[],
  memberships: readonly EffectiveMembership[],
  attributes: readonly EffectiveAttribute[]
): number {
  let count = 0
  for (const grant of grants) {
    count += grant.privileges.filter((privilege) => privilege.allowed === 'no').length
  }
  count += memberships.filter((membership) => membership.allowed === 'no').length
  // An attribute only counts when it is switched on and the panel forbids it.
  count += attributes.filter(
    (attribute) => attribute.allowed === 'no' && attribute.value === true
  ).length
  return count
}

/** One login's effective permissions against the catalogue of its cluster. */
export function buildEffectivePermissions(
  catalogue: PrivilegeCatalogue,
  report: ManagedPermissionsObserved,
  login: ObservedLogin
): EffectivePermissions {
  const index = indexCatalogue(catalogue)
  // MySQL and MariaDB show role names only; a role's own grants are not expanded.
  const shown =
    catalogue.engine === 'postgres'
      ? login.grants
      : login.grants.filter((grant) => grant.via === undefined)
  const grants = shown.map((grant) => classifyGrant(index, catalogue, grant))
  const defaults = login.defaults.map((item) => classifyDefault(index, catalogue, item))
  const memberships = login.memberships.map((item) => classifyMembership(catalogue, item))
  const attributes = classifyAttributes(catalogue, login.attributes)
  return {
    username: login.username,
    exists: login.exists,
    engine: catalogue.engine,
    series: catalogue.series,
    observedAt: report.observedAt,
    ...(report.serverVersion === undefined ? {} : { serverVersion: report.serverVersion }),
    attributes,
    accounts: login.accounts ?? [],
    memberships,
    grants,
    defaults,
    truncated: login.truncated === true,
    outsidePolicyCount: countOutsidePolicy([...grants, ...defaults], memberships, attributes),
    ledger: { available: false },
  }
}

/** Whether a daemon-reported version string belongs to the cluster's catalogued series. */
export function reportMatchesSeries(serverVersion: string | undefined, series: string): boolean {
  if (!serverVersion) return true
  const match = /^(\d+)(?:\.(\d+))?/.exec(serverVersion.trim())
  if (!match) return true
  const major = match[1]!
  const reported = series.includes('.') ? `${major}.${match[2] ?? '0'}` : major
  return compareSeries(reported, series) === 0
}
