/**
 * Real-Postgres coverage for the stored Let's Encrypt pair's lifecycle:
 * erase on revoke / Let's Encrypt off, and the 30-day removal sweep.
 */

import { skipWithoutDatabase } from '../../test-fixtures/require-service.test.support.ts'
import { assertEquals } from '@std/assert'
import { eq } from 'drizzle-orm'
import { createDenoDb } from '../../db/connection.ts'
import { getDatabaseUrl } from '../../db/url.ts'
import {
  audit,
  environment,
  hosting,
  organization,
  project,
  service,
  tls,
  workspace,
} from '../../db/schema.ts'
import {
  EMPTY_ENTRY_GRACE_MS,
  eraseStoredPairs,
  runStoredPairSweepTick,
  STORED_PAIR_KEEP_DAYS,
} from './stored-pair.ts'

const dbUrl = getDatabaseUrl()

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const DAY_MS = 86_400_000

type RowShape = {
  /** `tls.metadata.acme.createdFor`; `null` leaves the marker out (a row made before it). */
  createdFor?: 'hosting' | 'library' | null
  name?: string | null
  /** False: the row holds no issued pair yet. */
  pair?: boolean
}

async function setup(pin: boolean, shape: RowShape = {}) {
  const createdFor = shape.createdFor === undefined ? 'hosting' : shape.createdFor
  const pair = shape.pair !== false
  const db = createDenoDb()
  const now = new Date().toISOString()
  const [org] = await db
    .insert(organization)
    .values({ name: 'Pair Org' })
    .returning({ id: organization.id })
  const organizationId = org!.id
  const [row] = await db
    .insert(tls)
    .values({
      organizationId,
      name: shape.name === undefined ? 'Lets Encrypt pair' : shape.name,
      source: 'lets_encrypt',
      status: 'automatic',
      certificatePem: pair ? 'CHAIN' : null,
      privateKeyPem: pair ? 'tpsecret.v1.sealed' : null,
      notAfter: '2030-01-01T00:00:00.000Z',
      fingerprintSha256: `fp-${crypto.randomUUID()}`,
      metadata: {
        dnsNames: ['a.example.com'],
        extra: 'kept',
        acme: {
          storedNames: ['a.example.com'],
          notAfter: '2030-01-01T00:00:00.000Z',
          ...(createdFor === null ? {} : { createdFor }),
        },
      },
    })
    .returning({ id: tls.id })
  const [ws] = await db
    .insert(workspace)
    .values({ organizationId, name: 'WS', createdAt: now, updatedAt: now })
    .returning({ id: workspace.id })
  const [proj] = await db
    .insert(project)
    .values({
      workspaceId: ws!.id,
      organizationId,
      name: 'P',
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: project.id })
  const [env] = await db
    .insert(environment)
    .values({ projectId: proj!.id, name: 'e', createdAt: now, updatedAt: now })
    .returning({ id: environment.id })
  const [svc] = await db
    .insert(service)
    .values({
      environmentId: env!.id,
      name: 's',
      composeServiceName: 's',
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: service.id })
  const [host] = await db
    .insert(hosting)
    .values({
      serviceId: svc!.id,
      name: 'Site',
      tlsId: pin ? row!.id : null,
      options: { hostnames: ['a.example.com'] },
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: hosting.id })
  return {
    db,
    organizationId,
    tlsId: row!.id,
    hostingId: host!.id,
    read: async () => (await db.select().from(tls).where(eq(tls.id, row!.id)))[0],
    async cleanup() {
      await db.delete(audit).where(eq(audit.organizationId, organizationId))
      await db.delete(hosting).where(eq(hosting.id, host!.id))
      await db.delete(tls).where(eq(tls.organizationId, organizationId))
      await db.delete(service).where(eq(service.id, svc!.id))
      await db.delete(environment).where(eq(environment.id, env!.id))
      await db.delete(project).where(eq(project.id, proj!.id))
      await db.delete(workspace).where(eq(workspace.id, ws!.id))
      await db.delete(organization).where(eq(organization.id, organizationId))
    },
  }
}

test('eraseStoredPairs clears the key and chain but keeps the row', async () => {
  if (!dbUrl) return skipWithoutDatabase('stored pair lifecycle tests')
  const f = await setup(true)
  try {
    assertEquals(await eraseStoredPairs(f.db, f.organizationId), [f.tlsId])
    const row = await f.read()
    assertEquals(row?.privateKeyPem, null)
    assertEquals(row?.certificatePem, null)
    assertEquals(row?.status, 'automatic')
    assertEquals(row?.fingerprintSha256, null)
    assertEquals(new Date(row!.notAfter!).getTime(), 0)
    const acme = (row?.metadata as { acme: Record<string, unknown>; extra: string }).acme
    assertEquals('storedNames' in acme, false)
    assertEquals((row?.metadata as { extra: string }).extra, 'kept')
    assertEquals(await eraseStoredPairs(f.db, f.organizationId), [])
    const trail = await f.db.select().from(audit).where(eq(audit.organizationId, f.organizationId))
    assertEquals(
      trail.map((t) => t.action),
      ['tls.certificate.key_erase']
    )
  } finally {
    await f.cleanup()
  }
})

test('a pinned row is left alone by the sweep', async () => {
  if (!dbUrl) return skipWithoutDatabase('stored pair lifecycle tests')
  const f = await setup(true)
  try {
    const far = () => new Date(Date.now() + 90 * DAY_MS)
    await runStoredPairSweepTick(f.db, { now: far })
    assertEquals((await f.read())?.privateKeyPem, 'tpsecret.v1.sealed')
  } finally {
    await f.cleanup()
  }
})

test('an unpinned row is stamped, kept for 30 days, then deleted with its key', async () => {
  if (!dbUrl) return skipWithoutDatabase('stored pair lifecycle tests')
  const f = await setup(false)
  try {
    const start = Date.now()
    const first = await runStoredPairSweepTick(f.db, {
      now: () => new Date(start),
    })
    assertEquals(first.stamped, 1)
    const soon = await runStoredPairSweepTick(f.db, {
      now: () => new Date(start + (STORED_PAIR_KEEP_DAYS - 1) * DAY_MS),
    })
    assertEquals(soon.deleted, 0)
    assertEquals((await f.read())?.privateKeyPem, 'tpsecret.v1.sealed')
    const late = await runStoredPairSweepTick(f.db, {
      now: () => new Date(start + (STORED_PAIR_KEEP_DAYS + 1) * DAY_MS),
    })
    assertEquals(late.deleted, 1)
    assertEquals(await f.read(), undefined)
  } finally {
    await f.cleanup()
  }
})

test('pinning the row again before the 30 days are up cancels the removal', async () => {
  if (!dbUrl) return skipWithoutDatabase('stored pair lifecycle tests')
  const f = await setup(false)
  try {
    const start = Date.now()
    await runStoredPairSweepTick(f.db, { now: () => new Date(start) })
    await f.db.update(hosting).set({ tlsId: f.tlsId }).where(eq(hosting.id, f.hostingId))
    const back = await runStoredPairSweepTick(f.db, {
      now: () => new Date(start + 10 * DAY_MS),
    })
    assertEquals(back.cleared, 1)
    await f.db.update(hosting).set({ tlsId: null }).where(eq(hosting.id, f.hostingId))
    const again = await runStoredPairSweepTick(f.db, {
      now: () => new Date(start + (STORED_PAIR_KEEP_DAYS + 5) * DAY_MS),
    })
    assertEquals(again.deleted, 0, 'the 30 days start over')
    assertEquals(again.stamped, 1)
  } finally {
    await f.cleanup()
  }
})

test('stamping an unpinned row keeps every other metadata key', async () => {
  if (!dbUrl) return skipWithoutDatabase('stored pair lifecycle tests')
  const f = await setup(false)
  try {
    await runStoredPairSweepTick(f.db, { now: () => new Date() })
    const metadata = (await f.read())?.metadata as Record<string, unknown>
    assertEquals(metadata.extra, 'kept')
    assertEquals(typeof metadata.unpinnedAt, 'string')
    assertEquals(Array.isArray(metadata.dnsNames), true)
  } finally {
    await f.cleanup()
  }
})

test('an unused entry that never got a certificate goes once it has been left alone', async () => {
  if (!dbUrl) return skipWithoutDatabase('stored pair lifecycle tests')
  const f = await setup(false, { pair: false })
  try {
    const fresh = await runStoredPairSweepTick(f.db, { now: () => new Date() })
    assertEquals(fresh.stamped, 0)
    assertEquals((await f.read())?.id, f.tlsId, 'a row just made may still be pinned')
    await runStoredPairSweepTick(f.db, {
      now: () => new Date(Date.now() + EMPTY_ENTRY_GRACE_MS + 60_000),
    })
    assertEquals(await f.read(), undefined)
    const trail = await f.db.select().from(audit).where(eq(audit.organizationId, f.organizationId))
    assertEquals(
      trail.map((t) => t.action),
      ['tls.certificate.delete']
    )
  } finally {
    await f.cleanup()
  }
})

test('an entry made before the marker, with no name, is swept like one made for a site', async () => {
  if (!dbUrl) return skipWithoutDatabase('stored pair lifecycle tests')
  const f = await setup(false, { pair: false, createdFor: null, name: null })
  try {
    await runStoredPairSweepTick(f.db, {
      now: () => new Date(Date.now() + EMPTY_ENTRY_GRACE_MS + 60_000),
    })
    assertEquals(await f.read(), undefined)
  } finally {
    await f.cleanup()
  }
})

test("a Let's Encrypt entry a person added to the library is never swept", async () => {
  if (!dbUrl) return skipWithoutDatabase('stored pair lifecycle tests')
  const library = await setup(false, { pair: false, createdFor: 'library', name: null })
  const named = await setup(false, { pair: false, createdFor: null, name: 'Mine' })
  try {
    const far = () => new Date(Date.now() + 90 * DAY_MS)
    await runStoredPairSweepTick(library.db, { now: far })
    await runStoredPairSweepTick(library.db, { now: far })
    assertEquals((await library.read())?.id, library.tlsId)
    assertEquals((await named.read())?.id, named.tlsId)
  } finally {
    await library.cleanup()
    await named.cleanup()
  }
})
