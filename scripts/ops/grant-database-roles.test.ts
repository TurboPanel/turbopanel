import postgres from 'postgres'
import { assertEquals, assertRejects } from '@std/assert'
import { skipWithoutDatabase } from '../../src/test-fixtures/require-service.test.support.ts'
import { createScratchGrantDb } from '../../src/test-fixtures/scratch-grant-db.test.support.ts'
import { grantDatabaseRoles } from './grant-database-roles.mjs'

/** Alias so Sonar recognizes the suite (see check-deploy-env.test.ts). */
const test = Deno.test.bind(Deno)

const adminUrl = Deno.env.get('TURBOPANEL_DATABASE_URL')?.trim()

test('grants are missing, then applied, idempotent, and inherited by new tables', async () => {
  if (!adminUrl) return skipWithoutDatabase('grant-database-roles')
  const db = await createScratchGrantDb(adminUrl)
  try {
    const { runtime, cached } = db.names
    const before = await grantDatabaseRoles(db.migrate, { runtime, cached }, { checkOnly: true })
    assertEquals(before.ok, false)
    assertEquals(
      before.lines.some((line) => line.startsWith('MISSING')),
      true
    )

    const first = await grantDatabaseRoles(db.migrate, { runtime, cached })
    assertEquals(first.ok, true, first.lines.join('\n'))
    const second = await grantDatabaseRoles(db.migrate, { runtime, cached })
    assertEquals(second.ok, true)

    await db.migrate.unsafe('CREATE TABLE public.later (id int primary key)')
    const [row] = await db.migrate.unsafe(
      `select has_table_privilege('${runtime}', 'public.later', 'INSERT') as ok,
              has_table_privilege('${cached}', 'public.later', 'SELECT') as cached_ok`
    )
    assertEquals(row.ok, true)
    assertEquals(row.cached_ok, false)
  } finally {
    await db.cleanup()
  }
})

test('refuses when the connected account does not own the tables', async () => {
  if (!adminUrl) return skipWithoutDatabase('grant-database-roles owner check')
  const db = await createScratchGrantDb(adminUrl)
  try {
    const { runtime, cached } = db.names
    await db.migrate.unsafe(`GRANT USAGE, CREATE ON SCHEMA public TO "${cached}"`)
    const other = (await import('postgres')).default(db.urlFor(cached), { max: 1 })
    try {
      await other.unsafe('CREATE TABLE public.foreign_owned (id int)')
      await assertRejects(
        () => grantDatabaseRoles(db.migrate, { runtime, cached: null }),
        Error,
        'not owned by'
      )
    } finally {
      await other.end({ timeout: 5 })
    }
  } finally {
    await db.cleanup()
  }
})

test('refuses a role that does not exist', async () => {
  if (!adminUrl) return skipWithoutDatabase('grant-database-roles missing role')
  const db = await createScratchGrantDb(adminUrl)
  try {
    await assertRejects(
      () => grantDatabaseRoles(db.migrate, { runtime: 'no_such_role_xyz', cached: null }),
      Error,
      'do not exist'
    )
  } finally {
    await db.cleanup()
  }
})

test('default privileges for a similarly named role do not count', async () => {
  if (!adminUrl) return skipWithoutDatabase('grant-database-roles near-miss role')
  const db = await createScratchGrantDb(adminUrl)
  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} })
  const lookalike = `my_${db.names.runtime}`
  try {
    await admin.unsafe(`CREATE ROLE "${lookalike}"`)
    await db.migrate.unsafe(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT ON TABLES TO "${lookalike}"`
    )
    const result = await grantDatabaseRoles(
      db.migrate,
      { runtime: db.names.runtime, cached: null },
      { checkOnly: true }
    )
    const line = result.lines.find((l) => l.includes('new tables inherit'))
    assertEquals(line?.startsWith('MISSING'), true, result.lines.join('\n'))
  } finally {
    await db.cleanup()
    await admin.unsafe(`DROP ROLE IF EXISTS "${lookalike}"`)
    await admin.end({ timeout: 5 })
  }
})
