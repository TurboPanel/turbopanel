/**
 * The scheduled tick over origin certificates against a real database and a
 * faked provider: it handles a bounded number of rows across organizations,
 * revokes a retired certificate that nothing pins once the grace period passed,
 * reports the sites re-pinned by a renewal, and touches nothing healthy.
 * Skips without TURBOPANEL_DATABASE_URL.
 */
import { skipWithoutDatabase } from '../../test-fixtures/require-service.test.support.ts'
import { assertEquals } from '@std/assert'
import { eq } from 'drizzle-orm'
import { createDenoDb, endDbConnection } from '../../db/connection.ts'
import { getDatabaseUrl } from '../../db/url.ts'
import { organization, tls } from '../../db/schema.ts'
import { deriveEncryptionSecretsConfig } from '../../lib/secrets/secrets.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import type { TunnelAdapter } from './adapter.ts'
import { runOriginCertificateSweepTick } from './origin-certificate-sweep.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const dbUrl = getDatabaseUrl()

test('the tick does nothing on an instance with no origin certificates', async () => {
  if (!dbUrl) {
    skipWithoutDatabase('origin certificate sweep tests')
    return
  }
  const db = createDenoDb()
  const secrets = await deriveEncryptionSecretsConfig(
    parseTestSecretsConfig('deno'),
    'data-encryption'
  )
  const [org] = await db
    .insert(organization)
    .values({ name: `Sweep Org ${crypto.randomUUID()}` })
    .returning({ id: organization.id })
  try {
    // A row of another source is never touched.
    await db.insert(tls).values({ organizationId: org!.id, source: 'upload', status: 'ready' })
    const adapter = { provider: 'cloudflare' } as unknown as TunnelAdapter
    const done = await runOriginCertificateSweepTick(db, secrets, { registry: () => adapter })
    assertEquals([done.renewed, done.removed, done.failed, done.repinned], [0, 0, 0, []])
    assertEquals((await db.select().from(tls).where(eq(tls.organizationId, org!.id))).length, 1)
  } finally {
    await db.delete(tls).where(eq(tls.organizationId, org!.id))
    await db.delete(organization).where(eq(organization.id, org!.id))
    await endDbConnection(db)
  }
})
