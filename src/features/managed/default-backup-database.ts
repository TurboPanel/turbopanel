/** MySQL-family system schemas that must never be chosen for a default backup. */
const MYSQL_FAMILY_SYSTEM_SCHEMAS = new Set([
  'mysql',
  'information_schema',
  'performance_schema',
  'sys',
])

/**
 * The database a backup dumps when none is named: the first configured
 * (initial) database, skipping MySQL-family system schemas. `null` when the
 * instance has no such database. Shared by manual backups and the scheduled
 * policy entry, so both dump the same database.
 */
export function defaultBackupDatabase(
  databases: readonly string[],
  engine?: string
): string | null {
  const skipSystem = engine === 'mysql' || engine === 'mariadb'
  for (const name of databases) {
    if (skipSystem && MYSQL_FAMILY_SYSTEM_SCHEMAS.has(name.toLowerCase())) continue
    return name
  }
  return null
}
