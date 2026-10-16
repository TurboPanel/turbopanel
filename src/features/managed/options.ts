import type { ManagedEngineSpec } from './index.ts'
import type { ManagedSettings } from './settings.ts'

export type ManagedRowOptions = {
  settings: ManagedSettings
  databases: string[]
  /**
   * Postgres: databases made with an owner role (`tp_<db>_owner`, `_rw`,
   * `_ro`). Absent = none, which is every database made before this existed.
   * A subset of `databases`.
   */
  ownerRoleDatabases?: string[]
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

  return {
    settings,
    databases,
    ...(ownerRoleDatabases.length > 0 ? { ownerRoleDatabases } : {}),
  }
}

export function writeManagedRowOptions(options: ManagedRowOptions): Record<string, unknown> {
  return {
    settings: options.settings,
    databases: options.databases,
    ...(options.ownerRoleDatabases && options.ownerRoleDatabases.length > 0
      ? { ownerRoleDatabases: options.ownerRoleDatabases }
      : {}),
  }
}
