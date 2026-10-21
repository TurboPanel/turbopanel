/** MySQL-family system schemas that must never be chosen for a default backup. */
const MYSQL_FAMILY_SYSTEM_SCHEMAS = new Set([
  'mysql',
  'information_schema',
  'performance_schema',
  'sys',
])

/** The cluster's initial database from its parsed settings, when it names one. */
export function initialDatabaseOf(settings: unknown): string | undefined {
  if (typeof settings !== 'object' || settings === null) return undefined
  const initial = (settings as Record<string, unknown>).initialDatabase
  return typeof initial === 'string' && initial.length > 0 ? initial : undefined
}

/**
 * The database a backup dumps when none is named: the cluster's initial
 * (default) database when it still exists, otherwise the first configured
 * database, skipping MySQL-family system schemas. `null` when the instance has
 * no such database. Shared by manual backups and the scheduled policy entry,
 * so both dump the same database.
 */
export function defaultBackupDatabase(
  databases: readonly string[],
  engine?: string,
  initialDatabase?: string
): string | null {
  const skipSystem = engine === 'mysql' || engine === 'mariadb'
  const usable = databases.filter(
    (name) => !(skipSystem && MYSQL_FAMILY_SYSTEM_SCHEMAS.has(name.toLowerCase()))
  )
  if (initialDatabase !== undefined && usable.includes(initialDatabase)) return initialDatabase
  return usable[0] ?? null
}

/** Whether `name` is a MySQL-family system schema, which a backup never dumps. */
export function isSystemBackupDatabase(name: string, engine?: string): boolean {
  return (
    (engine === 'mysql' || engine === 'mariadb') &&
    MYSQL_FAMILY_SYSTEM_SCHEMAS.has(name.toLowerCase())
  )
}
