/**
 * Per-name certificate storage against a database: a save keeps the choices
 * of the names that stay, names without a choice follow the site pin, and a
 * library row counts as in use while any one name pins it. Skips without
 * TURBOPANEL_DATABASE_URL.
 */
import { assertEquals } from '@std/assert'
import { eq, inArray } from 'drizzle-orm'
import { hostname, hosting, tls } from '../../db/schema.ts'
import { loadHostingNameReads } from '../../client/hostings/name-certificates-routes.ts'
import { replaceHostingHostnames } from '../servers/hostname-records.ts'
import { certificateIdsPinnedBy } from '../tls/unused-letsencrypt.ts'
import { withScenario, NAME } from '../tunnels/nudge-scenario.test.support.ts'
import {
  hostingsPinningName,
  loadNameCertificates,
  pinHostingNames,
  syncHostingPin,
} from './name-certificates.ts'

/** Sonar only recognises `test()`; see the note in the other suites. */
const test = Deno.test.bind(Deno)

async function newLibraryRow(
  s: Parameters<Parameters<typeof withScenario>[1]>[0],
  source: string
): Promise<string> {
  const [row] = await s.db
    .insert(tls)
    .values({ organizationId: s.organizationId, source, status: 'ready', name: `${source} row` })
    .returning({ id: tls.id })
  return row!.id
}

test('a save keeps the choice of a name that stays, drops gone names and gives new ones the default', async () => {
  await withScenario({}, async (s) => {
    const pin = await newLibraryRow(s, 'upload')
    try {
      await replaceHostingHostnames(
        s.db,
        s.hostingAId,
        s.organizationId,
        [NAME, 'b.example.com'],
        new Map([[NAME, { certificate: 'library', tlsId: pin }]])
      )
      await replaceHostingHostnames(s.db, s.hostingAId, s.organizationId, [NAME, 'c.example.com'])
      const names = (await loadNameCertificates(s.db, [s.hostingAId])).get(s.hostingAId) ?? []
      assertEquals(names.map((n) => n.hostname).toSorted(), ['c.example.com', NAME].toSorted())
      const kept = names.find((n) => n.hostname === NAME)
      assertEquals([kept?.certificate, kept?.tlsId], ['library', pin])
      const added = await s.db
        .select({ certificate: hostname.certificate, tlsId: hostname.tlsId })
        .from(hostname)
        .where(eq(hostname.hostname, 'c.example.com'))
      // A new name always gets a concrete choice (the default), never none.
      assertEquals(added, [{ certificate: 'self_signed', tlsId: null }])
    } finally {
      await s.db.update(hosting).set({ tlsId: null }).where(eq(hosting.id, s.hostingAId))
      await s.db.delete(hostname).where(eq(hostname.hostingId, s.hostingAId))
      await s.db.delete(tls).where(eq(tls.id, pin))
    }
  })
})

test('a name with no stored choice follows the site pin, and pinning the site sets every name', async () => {
  await withScenario({}, async (s) => {
    const pin = await newLibraryRow(s, 'lets_encrypt')
    try {
      await s.db.update(hosting).set({ tlsId: pin }).where(eq(hosting.id, s.hostingAId))
      // Rows from before the choice existed carry none.
      await s.db
        .update(hostname)
        .set({ certificate: null, tlsId: null })
        .where(eq(hostname.hostingId, s.hostingAId))
      const before = (await loadNameCertificates(s.db, [s.hostingAId])).get(s.hostingAId)
      assertEquals(
        before?.map((n) => [n.certificate, n.tlsId]),
        [['letsencrypt_http', pin]]
      )
      await pinHostingNames(s.db, s.hostingAId, null)
      const after = (await loadNameCertificates(s.db, [s.hostingAId])).get(s.hostingAId)
      assertEquals(
        after?.map((n) => [n.certificate, n.tlsId]),
        [['self_signed', null]]
      )
    } finally {
      await s.db.update(hosting).set({ tlsId: null }).where(eq(hosting.id, s.hostingAId))
      await s.db.delete(tls).where(eq(tls.id, pin))
    }
  })
})

test('a library row one name pins is in use, and the site pin follows only while every name agrees', async () => {
  await withScenario({}, async (s) => {
    const pin = await newLibraryRow(s, 'upload')
    try {
      await replaceHostingHostnames(
        s.db,
        s.hostingAId,
        s.organizationId,
        [NAME, 'b.example.com'],
        new Map([[NAME, { certificate: 'library', tlsId: pin }]])
      )
      assertEquals(await certificateIdsPinnedBy(s.db, [s.hostingAId]), [pin])
      assertEquals(await hostingsPinningName(s.db, pin), [s.hostingAId])
      await syncHostingPin(s.db, s.hostingAId)
      const [mixed] = await s.db
        .select({ tlsId: hosting.tlsId })
        .from(hosting)
        .where(eq(hosting.id, s.hostingAId))
      assertEquals(mixed?.tlsId, null)
      await replaceHostingHostnames(
        s.db,
        s.hostingAId,
        s.organizationId,
        [NAME, 'b.example.com'],
        new Map([['b.example.com', { certificate: 'library', tlsId: pin }]])
      )
      await syncHostingPin(s.db, s.hostingAId)
      const [same] = await s.db
        .select({ tlsId: hosting.tlsId })
        .from(hosting)
        .where(eq(hosting.id, s.hostingAId))
      assertEquals(same?.tlsId, pin)
    } finally {
      await s.db.update(hosting).set({ tlsId: null }).where(eq(hosting.id, s.hostingAId))
      await s.db.delete(hostname).where(eq(hostname.hostingId, s.hostingAId))
      await s.db.delete(tls).where(eq(tls.id, pin))
    }
  })
})

test('the per-name read lists each name with options, the doorway reach and covering library rows', async () => {
  await withScenario({}, async (s) => {
    const covering = await newLibraryRow(s, 'upload')
    const staging = await newLibraryRow(s, 'upload')
    const empty = await newLibraryRow(s, 'upload')
    try {
      await s.db
        .update(tls)
        .set({ metadata: { dnsNames: [NAME, 'b.example.com'] } })
        .where(eq(tls.id, covering))
      await s.db
        .update(tls)
        .set({ metadata: { dnsNames: [NAME], acme: { staging: true } } })
        .where(eq(tls.id, staging))
      await s.db
        .update(tls)
        .set({ metadata: { dnsNames: [] } })
        .where(eq(tls.id, empty))
      await replaceHostingHostnames(s.db, s.hostingAId, s.organizationId, [NAME, 'b.example.com'])
      const reads = await loadHostingNameReads(s.db, s.organizationId, [
        { id: s.hostingAId, options: null },
        { id: s.hostingBId, options: null },
      ])
      const names = reads.get(s.hostingAId) ?? []
      assertEquals(
        names.map((n) => n.hostname),
        ['b.example.com', NAME].toSorted()
      )
      assertEquals(reads.get(s.hostingBId), [])
      for (const name of names) {
        assertEquals(
          name.certificateOptions.options
            .filter((o) => o.certificate === 'library')
            .map((o) => o.tlsId),
          [covering]
        )
      }
    } finally {
      await s.db.delete(hostname).where(eq(hostname.hostingId, s.hostingAId))
      await s.db.delete(tls).where(inArray(tls.id, [covering, staging, empty]))
    }
  })
})

test('the per-name read of no hostings is empty', async () => {
  await withScenario({}, async (s) => {
    assertEquals((await loadHostingNameReads(s.db, s.organizationId, [])).size, 0)
  })
})
