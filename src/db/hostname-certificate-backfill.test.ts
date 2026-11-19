/**
 * Migration 0003 backfill: replays the migration's own UPDATE statements over
 * rows that carry no per-name choice (the state an upgrade finds) and checks
 * the choice each `tls.source` maps to, plus the locked-doorway case.
 * Skips without TURBOPANEL_DATABASE_URL.
 */
import { assertEquals } from '@std/assert'
import { eq, sql } from 'drizzle-orm'
import { hostname, hosting, tls } from './schema.ts'
import { withScenario, NAME } from '../features/tunnels/nudge-scenario.test.support.ts'
import { replaceHostingHostnames } from '../features/servers/hostname-records.ts'

/** Sonar only recognises `test()`; see the note in the other suites. */
const test = Deno.test.bind(Deno)

const MIGRATION = new URL('../../migrations/0003_hostname_certificate_choice.sql', import.meta.url)

async function backfillStatements(): Promise<string[]> {
  const text = await Deno.readTextFile(MIGRATION)
  return text
    .split('--> statement-breakpoint')
    .map((part) => part.trim())
    .filter((part) => part.startsWith('UPDATE "hostname"'))
}

type Scenario = Parameters<Parameters<typeof withScenario>[1]>[0]

async function replay(s: Scenario): Promise<void> {
  const statements = await backfillStatements()
  assertEquals(statements.length, 2)
  await s.db
    .update(hostname)
    .set({ certificate: null, tlsId: null })
    .where(eq(hostname.routingOrganizationId, s.organizationId))
  for (const statement of statements) await s.db.execute(sql.raw(statement.replace(/;$/, '')))
}

async function rowsOf(s: Scenario, hostingId: string) {
  return await s.db
    .select({ certificate: hostname.certificate, tlsId: hostname.tlsId })
    .from(hostname)
    .where(eq(hostname.hostingId, hostingId))
}

test('the backfill maps each certificate source to a choice for every name of the site', async () => {
  await withScenario({}, async (s) => {
    await replaceHostingHostnames(s.db, s.hostingBId, s.organizationId, [
      'one.example.net',
      'two.example.net',
    ])
    const expected: Array<[string, string]> = [
      ['provider_origin', 'cloudflare_origin'],
      ['lets_encrypt', 'letsencrypt_http'],
      ['upload', 'library'],
      ['self_signed', 'library'],
    ]
    for (const [source, certificate] of expected) {
      const [row] = await s.db
        .insert(tls)
        .values({ organizationId: s.organizationId, source, status: 'ready', name: source })
        .returning({ id: tls.id })
      try {
        await s.db.update(hosting).set({ tlsId: row!.id }).where(eq(hosting.id, s.hostingBId))
        await replay(s)
        assertEquals(await rowsOf(s, s.hostingBId), [
          { certificate, tlsId: row!.id },
          { certificate, tlsId: row!.id },
        ])
      } finally {
        await s.db.update(hosting).set({ tlsId: null }).where(eq(hosting.id, s.hostingBId))
        await s.db.delete(tls).where(eq(tls.id, row!.id))
      }
    }
  })
})

test('the backfill gives a site with no pin the self-signed choice', async () => {
  await withScenario({}, async (s) => {
    await replay(s)
    assertEquals(await rowsOf(s, s.hostingBId), [])
    await replaceHostingHostnames(s.db, s.hostingBId, s.organizationId, ['solo.example.net'])
    await replay(s)
    assertEquals(await rowsOf(s, s.hostingBId), [{ certificate: 'self_signed', tlsId: null }])
  })
})

test('the backfill takes a Let’s Encrypt name off the pin when a local-only doorway carries it', async () => {
  await withScenario({}, async (s) => {
    const [row] = await s.db
      .insert(tls)
      .values({ organizationId: s.organizationId, source: 'lets_encrypt', status: 'ready' })
      .returning({ id: tls.id })
    try {
      await s.db.update(hosting).set({ tlsId: row!.id }).where(eq(hosting.id, s.hostingAId))
      await replay(s)
      const rows = await s.db
        .select({
          hostname: hostname.hostname,
          certificate: hostname.certificate,
          tlsId: hostname.tlsId,
        })
        .from(hostname)
        .where(eq(hostname.hostingId, s.hostingAId))
      assertEquals(rows, [{ hostname: NAME, certificate: 'self_signed', tlsId: null }])
    } finally {
      await s.db.update(hosting).set({ tlsId: null }).where(eq(hosting.id, s.hostingAId))
      await s.db.delete(tls).where(eq(tls.id, row!.id))
    }
  })
})
