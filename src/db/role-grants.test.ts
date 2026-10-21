import { assertEquals } from '@std/assert'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { skipWithoutDatabase } from '../test-fixtures/require-service.test.support.ts'
import { createScratchGrantDb } from '../test-fixtures/scratch-grant-db.test.support.ts'
import { findMissingRuntimeGrants, resetGrantProbeCache } from './role-grants.ts'
import type { Db } from './connection.ts'

/** Alias so Sonar recognizes the suite (see check-deploy-env.test.ts). */
const test = Deno.test.bind(Deno)

const adminUrl = Deno.env.get('TURBOPANEL_DATABASE_URL')?.trim()

async function missingFor(url: string): Promise<string[]> {
  resetGrantProbeCache()
  const client = postgres(url, { max: 1, prepare: false })
  try {
    return await findMissingRuntimeGrants(drizzle(client) as unknown as Db)
  } finally {
    await client.end({ timeout: 5 })
  }
}

test('names the schema, then the table, then nothing once granted', async () => {
  if (!adminUrl) return skipWithoutDatabase('findMissingRuntimeGrants')
  const db = await createScratchGrantDb(adminUrl)
  try {
    const { runtime } = db.names
    const runtimeUrl = db.urlFor(runtime)
    assertEquals(await missingFor(runtimeUrl), [
      `role ${runtime} lacks USAGE on schema public`,
      `role ${runtime} lacks read/write on table public.setting`,
    ])
    await db.migrate.unsafe(`GRANT USAGE ON SCHEMA public TO "${runtime}"`)
    assertEquals(await missingFor(runtimeUrl), [
      `role ${runtime} lacks read/write on table public.setting`,
    ])
    await db.migrate.unsafe(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${runtime}"`
    )
    assertEquals(await missingFor(runtimeUrl), [])
  } finally {
    await db.cleanup()
  }
})

test('a fresh database without tables reports nothing missing', async () => {
  if (!adminUrl) return skipWithoutDatabase('findMissingRuntimeGrants fresh')
  const db = await createScratchGrantDb(adminUrl, { tables: false })
  try {
    await db.migrate.unsafe(`GRANT USAGE ON SCHEMA public TO "${db.names.runtime}"`)
    assertEquals(await missingFor(db.urlFor(db.names.runtime)), [])
  } finally {
    await db.cleanup()
  }
})

test('a runtime role with only SELECT is reported as lacking read/write', async () => {
  if (!adminUrl) return skipWithoutDatabase('findMissingRuntimeGrants select-only')
  const db = await createScratchGrantDb(adminUrl)
  try {
    const { runtime } = db.names
    await db.migrate.unsafe(`GRANT USAGE ON SCHEMA public TO "${runtime}"`)
    await db.migrate.unsafe(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO "${runtime}"`)
    assertEquals(await missingFor(db.urlFor(runtime)), [
      `role ${runtime} lacks read/write on table public.setting`,
    ])
  } finally {
    await db.cleanup()
  }
})
