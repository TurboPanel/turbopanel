/**
 * Types for the versioned privilege catalogue.
 *
 * The catalogue says, per engine and supported series, which privileges, roles
 * and role attributes exist, what each one means in plain words, and whether a
 * site owner's login may hold it. It is data only: nothing here reads or
 * writes a customer database.
 */

import type { ManagedEngineCode } from '../types.ts'

/**
 * Where a privilege is granted.
 *
 * `table` covers tables, views, materialized views, foreign tables and
 * partitioned tables (Postgres treats them alike). `routine` covers functions
 * and procedures (and MariaDB packages). `type` covers types and domains.
 * `global` is MySQL and MariaDB only: a privilege on `*.*`. The last five are
 * Postgres object kinds a site owner's login never gets (settings, tablespaces,
 * languages, foreign data wrappers and servers, large objects); they exist so
 * an observed grant on one can be recognised and refused.
 */
export const PRIVILEGE_LEVELS = [
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
export type PrivilegeLevel = (typeof PRIVILEGE_LEVELS)[number]

/**
 * Whether a login the panel manages may hold this.
 *
 * - `yes`: safe inside the databases and objects the login is placed on.
 * - `needs-admin`: reserved for a Database admin login (it can pass access on
 *   or reaches across databases). No product surface hands this out yet.
 * - `no`: never held by a site owner's login; it would let the holder escape
 *   its own databases or take over the server.
 */
export type PrivilegeAllowance = 'yes' | 'needs-admin' | 'no'

export type PrivilegeEntry = {
  /** Stable id, `<level>:<keyword>`, for example `table:SELECT`. */
  id: string
  level: PrivilegeLevel
  /** The word used in `GRANT`, in the engine's own spelling. */
  keyword: string
  /** Other spellings the engine reports for the same privilege. */
  aliases?: readonly string[]
  /** Short plain-words name. */
  label: string
  /** One plain sentence on what holding it allows. */
  explanation: string
  /** First catalogued series that has it (omitted: every catalogued series). */
  since?: string
  /** First series that no longer has it. */
  removedIn?: string
  allowed: PrivilegeAllowance
  /** Why a login may not hold it, in plain words. Present when `allowed` is not `yes`. */
  reason?: string
  /** Postgres access-list letter, for example `r` for SELECT on a table. */
  aclLetter?: string
  /** False for entries that never show as a grid cell, such as `USAGE` meaning "nothing". */
  grid: boolean
}

/** A Postgres predefined role a login can be made a member of. */
export type PrivilegeRoleEntry = {
  name: string
  label: string
  explanation: string
  since?: string
  removedIn?: string
  /** False when the role cannot be granted at all (`pg_database_owner`). */
  grantable: boolean
  allowed: PrivilegeAllowance
  reason?: string
}

/** A Postgres role attribute (`SUPERUSER`, `CREATEDB`, ...). */
export type PrivilegeAttributeEntry = {
  name: string
  /** The `pg_roles` column that reports it. */
  column: string
  label: string
  explanation: string
  allowed: PrivilegeAllowance
  reason?: string
}

/** One option on a Postgres role membership (16 and later). */
export type PrivilegeMembershipOption = {
  id: 'inherit' | 'set' | 'admin'
  keyword: string
  label: string
  explanation: string
  since?: string
  allowed: PrivilegeAllowance
  reason?: string
}

/** An object kind that default privileges can name (Postgres). */
export type PrivilegeDefaultObject = {
  id: string
  /** The `ALTER DEFAULT PRIVILEGES ... ON <keyword>` spelling. */
  keyword: string
  /** The `pg_default_acl.defaclobjtype` letter. */
  letter: string
  /** The grant level whose privileges apply to this kind. */
  level: PrivilegeLevel
  label: string
  since?: string
}

export type PrivilegeLevelInfo = {
  id: PrivilegeLevel
  label: string
  explanation: string
}

export type PrivilegeBlocked = {
  /** Databases (Postgres) or schemas (MySQL, MariaDB) a login can never be granted into. */
  databases: readonly string[]
  /** Schemas inside a Postgres database a login can never be granted on. */
  schemas: readonly string[]
  /** Name prefixes the panel reserves for its own roles and accounts. */
  reservedPrefixes: readonly string[]
  /** Exact names (compared in lower case) no login may be granted into or created as. */
  reservedNames: readonly string[]
}

/** The catalogue as it applies to one engine and one series. */
export type PrivilegeCatalogue = {
  engine: ManagedEngineCode
  series: string
  levels: readonly PrivilegeLevelInfo[]
  privileges: readonly PrivilegeEntry[]
  roles: readonly PrivilegeRoleEntry[]
  attributes: readonly PrivilegeAttributeEntry[]
  membershipOptions: readonly PrivilegeMembershipOption[]
  defaultPrivilegeObjects: readonly PrivilegeDefaultObject[]
  blocked: PrivilegeBlocked
}

/** What one engine's data module provides before it is narrowed to a series. */
export type EnginePrivilegeData = {
  engine: ManagedEngineCode
  /** Series the catalogue covers, oldest first. */
  series: readonly string[]
  levels: readonly PrivilegeLevelInfo[]
  privileges: readonly PrivilegeEntry[]
  roles: readonly PrivilegeRoleEntry[]
  attributes: readonly PrivilegeAttributeEntry[]
  membershipOptions: readonly PrivilegeMembershipOption[]
  defaultPrivilegeObjects: readonly PrivilegeDefaultObject[]
  blocked: PrivilegeBlocked
}
