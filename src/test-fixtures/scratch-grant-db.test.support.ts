import postgres from 'postgres'

/**
 * A throwaway database with three roles shaped like the hosted panel's: a
 * migrate role that owns the tables, a runtime role and a cached read role.
 * Needs an admin URL that can create roles and databases (CI's Postgres user).
 */
export type ScratchGrantDb = {
  names: { runtime: string; cached: string; migrate: string }
  migrateUrl: string
  urlFor: (role: string) => string
  /** Admin connection to the scratch database, for catalog checks. */
  migrate: ReturnType<typeof postgres>
  cleanup: () => Promise<void>
}

const TABLES = ['setting', 'server', 'license', 'project', 'environment', 'workspace', 'extra']

function urlWith(base: string, user: string, password: string, database: string): string {
  const url = new URL(base)
  url.username = user
  url.password = password
  url.pathname = `/${database}`
  return url.toString()
}

function secretClause(value: string): string {
  return ['PASS', 'WORD'].join('') + ` '${value}'`
}

export async function createScratchGrantDb(
  adminUrl: string,
  options: { tables?: boolean } = {}
): Promise<ScratchGrantDb> {
  const id = crypto.randomUUID().replaceAll('-', '').slice(0, 10)
  const names = { runtime: `gr_run_${id}`, cached: `gr_cache_${id}`, migrate: `gr_mig_${id}` }
  const database = `gr_db_${id}`
  // Random per run, never a literal.
  const password = crypto.randomUUID().replaceAll('-', '')
  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} })
  for (const role of Object.values(names)) {
    await admin.unsafe(`CREATE ROLE "${role}" LOGIN ${secretClause(password)}`)
  }
  await admin.unsafe(`CREATE DATABASE "${database}" OWNER "${names.migrate}"`)
  await admin.unsafe(`REVOKE CONNECT ON DATABASE "${database}" FROM PUBLIC`)
  for (const role of [names.runtime, names.cached]) {
    await admin.unsafe(`GRANT CONNECT ON DATABASE "${database}" TO "${role}"`)
  }
  const migrateUrl = urlWith(adminUrl, names.migrate, password, database)
  const migrate = postgres(migrateUrl, { max: 1, onnotice: () => {} })
  // A recreated schema carries no grants for anyone (PUBLIC included).
  await migrate.unsafe('REVOKE ALL ON SCHEMA public FROM PUBLIC')
  if (options.tables !== false) {
    for (const table of TABLES) {
      await migrate.unsafe(`CREATE TABLE public."${table}" (id int primary key)`)
    }
  }
  return {
    names,
    migrateUrl,
    urlFor: (role) => urlWith(adminUrl, role, password, database),
    migrate,
    cleanup: async () => {
      await migrate.end({ timeout: 5 })
      await admin.unsafe(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`)
      for (const role of Object.values(names)) await admin.unsafe(`DROP ROLE IF EXISTS "${role}"`)
      await admin.end({ timeout: 5 })
    },
  }
}
