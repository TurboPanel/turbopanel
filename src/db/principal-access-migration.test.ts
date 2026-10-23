import { assertEquals } from '@std/assert'
import { sql } from 'drizzle-orm'
import { join } from 'node:path'
import { createDenoDb } from './connection.ts'
import { getDatabaseUrl } from './url.ts'
import { skipWithoutDatabase } from '../test-fixtures/require-service.test.support.ts'

const dbUrl = getDatabaseUrl()
const migrationsDir = join(import.meta.dirname ?? '.', '../../migrations')

class Rollback extends Error {}

/** The backfill statement of the access-column migration, read from its SQL file. */
async function backfillStatement(): Promise<string> {
  for await (const entry of Deno.readDir(migrationsDir)) {
    if (!entry.name.endsWith('_principal_access.sql')) continue
    const text = await Deno.readTextFile(join(migrationsDir, entry.name))
    const statement = text
      .split('--> statement-breakpoint')
      .find((part) => part.trimStart().startsWith('UPDATE "principal"'))
    if (statement) return statement.trim().replace(/;$/, '')
  }
  throw new Error('principal access migration backfill not found')
}

Deno.test('the access migration maps stored shells to access levels', async () => {
  if (!dbUrl) {
    skipWithoutDatabase('principal access migration test')
    return
  }
  const backfill = await backfillStatement()
  const cases: Array<[string, string | null, string]> = [
    ['bash', '{"shell": "/bin/bash"}', 'shell'],
    ['sh', '{"shell": "/bin/sh"}', 'shell'],
    ['false', '{"shell": "/bin/false"}', 'none'],
    ['usrbash', '{"shell": "/usr/bin/bash"}', 'sftp'],
    ['zsh', '{"shell": "/bin/zsh"}', 'sftp'],
    ['nologin', '{"shell": "/usr/sbin/nologin"}', 'sftp'],
    ['snologin', '{"shell": "/sbin/nologin"}', 'sftp'],
    ['nokey', '{"nameScheme": "plain"}', 'sftp'],
    ['nulloptions', null, 'sftp'],
  ]
  const db = createDenoDb()
  try {
    await db.transaction(async (tx) => {
      // A temp table shadows the real one for this transaction only.
      await tx.execute(
        sql.raw(
          `CREATE TEMP TABLE principal (username text, options jsonb, access text DEFAULT 'sftp' NOT NULL) ON COMMIT DROP`
        )
      )
      for (const [username, options] of cases) {
        await tx.execute(
          sql`INSERT INTO principal (username, options) VALUES (${username}, ${options}::jsonb)`
        )
      }
      await tx.execute(sql.raw(backfill))
      const rows = (await tx.execute(
        sql`SELECT username, access FROM principal`
      )) as unknown as Array<{ username: string; access: string }>
      const byName = new Map(rows.map((row) => [row.username, row.access]))
      for (const [username, , expected] of cases) {
        assertEquals(byName.get(username), expected, username)
      }
      throw new Rollback()
    })
  } catch (error) {
    if (!(error instanceof Rollback)) throw error
  }
})
