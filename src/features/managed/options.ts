import type { ManagedEngineSpec } from './index.ts'
import type { ManagedSettings } from './settings.ts'

/** A login the customer chose as a Postgres database's owner. */
export type DatabaseOwnerLogin = {
  /** The login's id (`loginId` in the users API; the users routes accept it too). */
  loginId: string
  /** Its applied username on the engine; fixed for the life of the login. */
  username: string
}

export type ManagedRowOptions = {
  settings: ManagedSettings
  databases: string[]
  /**
   * Postgres: databases made with an owner role (`tp_<db>_owner`, `_rw`,
   * `_ro`). Absent = none, which is every database made before this existed.
   * A subset of `databases`.
   */
  ownerRoleDatabases?: string[]
  /**
   * Postgres: databases whose owner is a login the customer chose, not the
   * default no-login owner role. A subset of `ownerRoleDatabases`; absent =
   * every owner-role database is owned by its default owner role.
   */
  databaseOwners?: Record<string, DatabaseOwnerLogin>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validateDatabaseNames(spec: ManagedEngineSpec, names: unknown): string[] | null {
  if (!Array.isArray(names)) return null
  const { pattern, maxLength } = spec.userOperations.identifier
  const validated: string[] = []
  for (const entry of names) {
    if (typeof entry !== 'string') return null
    const trimmed = entry.trim()
    if (trimmed.length === 0 || trimmed.length > maxLength || !pattern.test(trimmed)) {
      return null
    }
    validated.push(trimmed)
  }
  return validated
}

export function parseManagedRowOptions(
  spec: ManagedEngineSpec,
  value: unknown
): ManagedRowOptions | null {
  if (!isRecord(value)) return null

  const settings = spec.parseSettings(value.settings)
  if (settings === null) return null

  const databases = validateDatabaseNames(spec, value.databases)
  if (databases === null) return null

  // Optional and lenient: a name that is not a listed database is ignored.
  const ownerRoleDatabases = Array.isArray(value.ownerRoleDatabases)
    ? value.ownerRoleDatabases.filter(
        (name): name is string => typeof name === 'string' && databases.includes(name)
      )
    : []

  const databaseOwners: Record<string, DatabaseOwnerLogin> = {}
  if (isRecord(value.databaseOwners)) {
    for (const [name, owner] of Object.entries(value.databaseOwners)) {
      if (
        ownerRoleDatabases.includes(name) &&
        isRecord(owner) &&
        typeof owner.loginId === 'string' &&
        typeof owner.username === 'string'
      ) {
        databaseOwners[name] = {
          loginId: owner.loginId,
          username: owner.username,
        }
      }
    }
  }

  return {
    settings,
    databases,
    ...(ownerRoleDatabases.length > 0 ? { ownerRoleDatabases } : {}),
    ...(Object.keys(databaseOwners).length > 0 ? { databaseOwners } : {}),
  }
}

export function writeManagedRowOptions(options: ManagedRowOptions): Record<string, unknown> {
  return {
    settings: options.settings,
    databases: options.databases,
    ...(options.ownerRoleDatabases && options.ownerRoleDatabases.length > 0
      ? { ownerRoleDatabases: options.ownerRoleDatabases }
      : {}),
    ...(options.databaseOwners && Object.keys(options.databaseOwners).length > 0
      ? { databaseOwners: options.databaseOwners }
      : {}),
  }
}
