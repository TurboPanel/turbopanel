/**
 * The `cache` table's CHECKs, unique keys and foreign keys, against a real
 * database. Every attempt runs in a transaction that is rolled back, so the
 * test leaves nothing behind. Runs where a database is configured (CI);
 * skipped elsewhere.
 */
import { skipWithoutDatabase } from '../test-fixtures/require-service.test.support.ts'
import { assert, assertEquals } from '@std/assert'
import { sql } from 'drizzle-orm'
import { createDenoDb } from './connection.ts'
import {
  cache,
  environment,
  organization,
  principal,
  project,
  server,
  workspace,
} from './schema.ts'
import { getDatabaseUrl } from './url.ts'
import { CACHE_ACCESS } from '../features/caches/vocabulary.ts'

const test = Deno.test.bind(Deno)

const constraintOf = (err: unknown) =>
  String((err as { cause?: { constraint_name?: string } }).cause?.constraint_name ?? err)

test('cache rows are held to the name, access, memory and uniqueness rules', async () => {
  if (!getDatabaseUrl()) {
    skipWithoutDatabase('cache check tests')
    return
  }
  assertEquals([...CACHE_ACCESS], ['socket', 'port'])
  const db = createDenoDb()
  const rollback = new Error('rollback')
  try {
    await db.transaction(async (tx) => {
      const [org] = await tx
        .insert(organization)
        .values({ name: 'Cache Check Org' })
        .returning({ id: organization.id })
      const organizationId = org!.id
      const [ws] = await tx
        .insert(workspace)
        .values({ name: 'ws', organizationId })
        .returning({ id: workspace.id })
      const [proj] = await tx
        .insert(project)
        .values({ name: 'p', workspaceId: ws!.id, organizationId })
        .returning({ id: project.id })
      const [env] = await tx
        .insert(environment)
        .values({ projectId: proj!.id, name: 'production' })
        .returning({ id: environment.id })
      const now = new Date().toISOString()
      const [srv] = await tx
        .insert(server)
        .values({ organizationId, name: 'S', createdAt: now, updatedAt: now })
        .returning({ id: server.id })
      const [owner] = await tx
        .insert(principal)
        .values({ organizationId, username: 'cachecheck', appliedUsername: 'cachecheck' })
        .returning({ id: principal.id })

      const base = {
        environmentId: env!.id,
        serverId: srv!.id,
        principalId: owner!.id,
        name: 'app-cache',
        version: '8.1',
        password: 'sealed-envelope-fixture',
      }
      // Each attempt runs in its own savepoint so a refusal does not abort the transaction.
      const attempt = async (values: Partial<typeof cache.$inferInsert>): Promise<string> => {
        try {
          await tx.transaction(async (inner) => {
            await inner.insert(cache).values({ ...base, ...values })
            throw rollback
          })
        } catch (err) {
          return err === rollback ? '' : constraintOf(err)
        }
        return ''
      }
      const refuses = async (name: string, values: Partial<typeof cache.$inferInsert>) => {
        const got = await attempt(values)
        assert(got.includes(name), `${name}: got "${got}"`)
      }

      // The defaults are a Valkey process on a private socket with 64 MiB and the REDIS prefix.
      assertEquals(await attempt({}), '')
      const [row] = await tx.insert(cache).values(base).returning()
      assertEquals(
        [row!.engine, row!.status, row!.access, row!.port, row!.maxMemoryMb, row!.keyPrefix],
        ['valkey', 'pending', 'socket', null, 64, 'REDIS']
      )

      await refuses('uniq_cache_environment_name', {})
      await refuses('uniq_cache_environment_principal_prefix', { name: 'other' })
      await refuses('cache_name_check', { name: 'App' })
      await refuses('cache_name_check', { name: '1app' })
      await refuses('cache_engine_check', { name: 'e', keyPrefix: 'E', engine: 'memcached' })
      await refuses('cache_status_check', { name: 's', keyPrefix: 'S', status: 'gone' })
      await refuses('cache_version_check', { name: 'v', keyPrefix: 'V', version: '8' })
      await refuses('cache_version_check', { name: 'v', keyPrefix: 'V', version: '8.1.11' })
      await refuses('cache_access_check', { name: 'a1', keyPrefix: 'A1', access: 'port' })
      await refuses('cache_access_check', { name: 'a2', keyPrefix: 'A2', port: 18080 })
      await refuses('cache_access_check', { name: 'a3', keyPrefix: 'A3', access: 'port', port: 80 })
      await refuses('cache_access_check', { name: 'a4', keyPrefix: 'A4', access: 'other' })
      await refuses('cache_max_memory_mb_check', { name: 'm1', keyPrefix: 'M1', maxMemoryMb: 15 })
      await refuses('cache_max_memory_mb_check', {
        name: 'm2',
        keyPrefix: 'M2',
        maxMemoryMb: 65537,
      })
      await refuses('cache_key_prefix_check', { name: 'k1', keyPrefix: '1REDIS' })
      await refuses('cache_key_prefix_check', { name: 'k2', keyPrefix: 'RE-DIS' })

      // A port is unique per server, and only for rows that have one.
      await tx
        .insert(cache)
        .values({ ...base, name: 'queue', keyPrefix: 'QUEUE', access: 'port', port: 18080 })
      await refuses('uniq_cache_server_port', {
        name: 'queue2',
        keyPrefix: 'QUEUE2',
        access: 'port',
        port: 18080,
      })
      assertEquals(await attempt({ name: 'free', keyPrefix: 'FREE' }), '')

      // Deleting the environment removes its caches; a server or account with caches is kept.
      let held = ''
      try {
        await tx.transaction(async (inner) => {
          await inner.execute(sql`DELETE FROM "server" WHERE id = ${srv!.id}`)
        })
      } catch (err) {
        held = constraintOf(err)
      }
      assert(held.includes('cache_server_id_server_id_fk'), held)
      await tx.execute(sql`DELETE FROM "environment" WHERE id = ${env!.id}`)
      const left = await tx.execute(sql`SELECT 1 FROM "cache" WHERE server_id = ${srv!.id}`)
      assertEquals(left.length, 0)
      throw rollback
    })
  } catch (err) {
    if (err !== rollback) throw err
  }
})
