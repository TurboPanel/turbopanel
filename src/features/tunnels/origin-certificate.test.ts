/**
 * Origin certificates against a real database with a faked provider: the
 * issued pair is stored with its key sealed, a refusal or a failed store
 * leaves nothing at the provider, a certificate a site pins cannot be
 * revoked, and renewal re-pins the site and keeps the old certificate until
 * it expires. Skips without TURBOPANEL_DATABASE_URL.
 */
import { skipWithoutDatabase } from '../../test-fixtures/require-service.test.support.ts'
import { assert, assertEquals, assertRejects } from '@std/assert'
import { eq } from 'drizzle-orm'
import { getDatabaseUrl } from '../../db/url.ts'
import { createDenoDb, endDbConnection } from '../../db/connection.ts'
import {
  badge,
  carrier,
  environment,
  hosting,
  organization,
  project,
  secret,
  service,
  tls,
  workspace,
} from '../../db/schema.ts'
import { deriveEncryptionSecretsConfig } from '../../lib/secrets/secrets.ts'
import { decryptSecret, encryptSecret } from '../../lib/secrets/data-encryption.ts'
import { mintSelfSignedCertificate } from '../../lib/tls/index.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import type { TunnelAdapter } from './adapter.ts'
import { TunnelProviderError } from './errors.ts'
import {
  countOriginCertificatesFrom,
  hostingsPinning,
  issueOriginCertificate,
  MAX_ORIGIN_CERTIFICATES_PER_ORG,
  OriginCertificateRefusal,
  readProviderOrigin,
  renewOriginCertificate,
  revokeOriginCertificate,
  sweepOriginCertificates,
} from './origin-certificate.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const dbUrl = getDatabaseUrl()
type Db = ReturnType<typeof createDenoDb>

const TOKEN = 'cf-api-token-0123456789abcdefghijklmnopqrstuv'

type Fake = {
  adapter: TunnelAdapter
  issued: { token: string; hostnames: readonly string[]; csrPem: string; validityDays: number }[]
  revoked: { token: string; externalId: string }[]
}

/** A provider that signs a fresh self-signed leaf for the requested names. */
function fakeAdapter(mode: 'good' | 'garbage' | 'gone' = 'good'): Fake {
  const issued: Fake['issued'] = []
  const revoked: Fake['revoked'] = []
  let counter = 0
  const adapter = {
    provider: 'cloudflare',
    issueOriginCertificate: async (
      token: string,
      input: { hostnames: readonly string[]; csrPem: string; validityDays: number }
    ) => {
      issued.push({ token, ...input })
      counter += 1
      const minted = await mintSelfSignedCertificate([...input.hostnames], { validDays: 365 })
      return {
        externalId: `ext-${counter}`,
        certificatePem: mode === 'garbage' ? 'not a certificate' : minted.certificatePem,
        notAfter: minted.parsed.notAfter.toISOString(),
      }
    },
    revokeOriginCertificate: (token: string, input: { externalId: string }) => {
      revoked.push({ token, externalId: input.externalId })
      return mode === 'gone'
        ? Promise.reject(new TunnelProviderError('not_found', 'no such certificate', 404))
        : Promise.resolve()
    },
  } as unknown as TunnelAdapter
  return { adapter, issued, revoked }
}

async function withWorld(
  fn: (w: {
    db: Db
    secrets: Awaited<ReturnType<typeof deriveEncryptionSecretsConfig>>
    organizationId: string
    carrierRow: typeof carrier.$inferSelect
    badgeRow: typeof badge.$inferSelect
    serviceId: string
  }) => Promise<void>
): Promise<void> {
  if (!dbUrl) {
    skipWithoutDatabase('origin certificate tests')
    return
  }
  const db = createDenoDb()
  const secrets = await deriveEncryptionSecretsConfig(
    parseTestSecretsConfig('deno'),
    'data-encryption'
  )
  const [org] = await db
    .insert(organization)
    .values({ name: `Origin Org ${crypto.randomUUID()}` })
    .returning({ id: organization.id })
  const organizationId = org!.id
  try {
    const [c] = await db
      .insert(carrier)
      .values({ organizationId, provider: 'cloudflare', name: 'Main', externalAccountId: 'acct' })
      .returning()
    const [sec] = await db
      .insert(secret)
      .values({
        organizationId,
        provider: 'carrier_badge',
        name: 'token',
        secretEnvelope: await encryptSecret(secrets, TOKEN),
      })
      .returning({ id: secret.id })
    const [b] = await db
      .insert(badge)
      .values({
        carrierId: c!.id,
        secretId: sec!.id,
        label: 'Main',
        lastFour: TOKEN.slice(-4),
        capabilities: { tunnels: true, dns: [], certificates: [{ id: 'z1', name: 'example.com' }] },
      })
      .returning()
    const [ws] = await db
      .insert(workspace)
      .values({ organizationId, name: 'WS' })
      .returning({ id: workspace.id })
    const [proj] = await db
      .insert(project)
      .values({ workspaceId: ws!.id, organizationId, name: 'P' })
      .returning({ id: project.id })
    const [env] = await db
      .insert(environment)
      .values({ projectId: proj!.id, name: 'production', isPrimary: true })
      .returning({ id: environment.id })
    const [svc] = await db
      .insert(service)
      .values({ environmentId: env!.id, name: 'web', composeServiceName: 'web' })
      .returning({ id: service.id })
    await fn({ db, secrets, organizationId, carrierRow: c!, badgeRow: b!, serviceId: svc!.id })
  } finally {
    // Sites, services, environments and projects restrict their parents; remove them first.
    const projects = await db
      .select({ id: project.id })
      .from(project)
      .where(eq(project.organizationId, organizationId))
    for (const p of projects) {
      const envs = await db
        .select({ id: environment.id })
        .from(environment)
        .where(eq(environment.projectId, p.id))
      for (const e of envs) {
        const svcs = await db
          .select({ id: service.id })
          .from(service)
          .where(eq(service.environmentId, e.id))
        for (const sv of svcs) await db.delete(hosting).where(eq(hosting.serviceId, sv.id))
        await db.delete(service).where(eq(service.environmentId, e.id))
      }
      await db.delete(environment).where(eq(environment.projectId, p.id))
    }
    await db.delete(project).where(eq(project.organizationId, organizationId))
    await db.delete(workspace).where(eq(workspace.organizationId, organizationId))
    await db.delete(organization).where(eq(organization.id, organizationId))
    await endDbConnection(db)
  }
}

async function pin(db: Db, serviceId: string, tlsId: string, name: string): Promise<string> {
  const [h] = await db
    .insert(hosting)
    .values({ serviceId, name, tlsId, options: { hostnames: [name] } })
    .returning({ id: hosting.id })
  return h!.id
}

test('an issued certificate is stored with its key sealed and the request is the only thing sent', async () => {
  await withWorld(async (w) => {
    const fake = fakeAdapter()
    const row = await issueOriginCertificate({
      ...w,
      adapter: fake.adapter,
      carrier: w.carrierRow,
      badge: w.badgeRow,
      zoneName: 'Example.com',
    })
    assertEquals(row.source, 'provider_origin')
    assertEquals(row.status, 'ready')
    assert(row.privateKeyPem?.startsWith('tpsecret.'), 'the key is a sealed envelope')
    assert(!row.privateKeyPem?.includes('BEGIN'))
    // The sealed key opens to a private key, and it never reached the provider.
    const opened = await decryptSecret(w.secrets, row.privateKeyPem!)
    assert(opened.startsWith('-----BEGIN PRIVATE KEY-----'))
    assertEquals(JSON.stringify(fake.issued).includes('PRIVATE KEY'), false)
    assertEquals(fake.issued.length, 1)
    assertEquals(fake.issued[0]!.token, TOKEN)
    assertEquals(fake.issued[0]!.hostnames, ['example.com', '*.example.com'])
    assert(fake.issued[0]!.csrPem.startsWith('-----BEGIN CERTIFICATE REQUEST-----'))
    const link = readProviderOrigin(row.metadata)
    assertEquals(link?.zoneName, 'example.com')
    assertEquals(link?.externalId, 'ext-1')
    assertEquals(link?.badgeId, w.badgeRow.id)
    assertEquals(
      await countOriginCertificatesFrom(w.db, w.organizationId, { badgeId: w.badgeRow.id }),
      1
    )
    assertEquals(
      await countOriginCertificatesFrom(w.db, w.organizationId, { carrierId: w.carrierRow.id }),
      1
    )
    assertEquals(
      await countOriginCertificatesFrom(w.db, w.organizationId, { badgeId: crypto.randomUUID() }),
      0
    )
  })
})

test('a zone the token was not found to reach is refused before the provider is asked', async () => {
  await withWorld(async (w) => {
    const fake = fakeAdapter()
    const err = await assertRejects(
      () =>
        issueOriginCertificate({
          ...w,
          adapter: fake.adapter,
          carrier: w.carrierRow,
          badge: w.badgeRow,
          zoneName: 'other.org',
        }),
      OriginCertificateRefusal
    )
    assertEquals(err.error, 'badge_cannot_certify')
    assertEquals(fake.issued.length, 0)
  })
})

test('a provider that does not issue certificates is refused', async () => {
  await withWorld(async (w) => {
    const adapter = { provider: 'cloudflare' } as unknown as TunnelAdapter
    const err = await assertRejects(
      () =>
        issueOriginCertificate({
          ...w,
          adapter,
          carrier: w.carrierRow,
          badge: w.badgeRow,
          zoneName: 'example.com',
        }),
      OriginCertificateRefusal
    )
    assertEquals(err.error, 'unsupported_provider')
  })
})

test('a certificate that cannot be stored is revoked again at the provider', async () => {
  await withWorld(async (w) => {
    const fake = fakeAdapter('garbage')
    await assertRejects(() =>
      issueOriginCertificate({
        ...w,
        adapter: fake.adapter,
        carrier: w.carrierRow,
        badge: w.badgeRow,
        zoneName: 'example.com',
      })
    )
    assertEquals(
      fake.revoked.map((r) => r.externalId),
      ['ext-1']
    )
    assertEquals(fake.revoked[0]!.token, TOKEN)
    const rows = await w.db.select().from(tls).where(eq(tls.organizationId, w.organizationId))
    assertEquals(rows.length, 0)
  })
})

test('an organization at its limit gets no more certificates', async () => {
  await withWorld(async (w) => {
    await w.db.insert(tls).values(
      Array.from({ length: MAX_ORIGIN_CERTIFICATES_PER_ORG }, () => ({
        organizationId: w.organizationId,
        source: 'provider_origin',
        status: 'ready',
        metadata: {},
      }))
    )
    const fake = fakeAdapter()
    const err = await assertRejects(
      () =>
        issueOriginCertificate({
          ...w,
          adapter: fake.adapter,
          carrier: w.carrierRow,
          badge: w.badgeRow,
          zoneName: 'example.com',
        }),
      OriginCertificateRefusal
    )
    assertEquals(err.error, 'origin_certificate_limit')
    assertEquals(fake.issued.length, 0)
  })
})

test('a certificate a site pins cannot be revoked; once free it is revoked and removed', async () => {
  await withWorld(async (w) => {
    const fake = fakeAdapter()
    const row = await issueOriginCertificate({
      ...w,
      adapter: fake.adapter,
      carrier: w.carrierRow,
      badge: w.badgeRow,
      zoneName: 'example.com',
    })
    const hostingId = await pin(w.db, w.serviceId, row.id, 'app.example.com')
    assertEquals(await hostingsPinning(w.db, row.id), [hostingId])
    const err = await assertRejects(
      () => revokeOriginCertificate({ db: w.db, secrets: w.secrets, adapter: fake.adapter, row }),
      OriginCertificateRefusal
    )
    assertEquals(err.error, 'tls_in_use')
    assertEquals(fake.revoked.length, 0)
    await w.db.delete(hosting).where(eq(hosting.id, hostingId))
    await revokeOriginCertificate({ db: w.db, secrets: w.secrets, adapter: fake.adapter, row })
    assertEquals(
      fake.revoked.map((r) => r.externalId),
      ['ext-1']
    )
    assertEquals((await w.db.select().from(tls).where(eq(tls.id, row.id))).length, 0)
  })
})

test('a certificate the provider already forgot is simply removed', async () => {
  await withWorld(async (w) => {
    const fake = fakeAdapter('gone')
    const row = await issueOriginCertificate({
      ...w,
      adapter: fake.adapter,
      carrier: w.carrierRow,
      badge: w.badgeRow,
      zoneName: 'example.com',
    })
    await revokeOriginCertificate({ db: w.db, secrets: w.secrets, adapter: fake.adapter, row })
    assertEquals((await w.db.select().from(tls).where(eq(tls.id, row.id))).length, 0)
  })
})

test('with the issuing token gone a certificate is kept unless removal is forced', async () => {
  await withWorld(async (w) => {
    const fake = fakeAdapter()
    const row = await issueOriginCertificate({
      ...w,
      adapter: fake.adapter,
      carrier: w.carrierRow,
      badge: w.badgeRow,
      zoneName: 'example.com',
    })
    await w.db
      .update(tls)
      .set({
        metadata: {
          ...(row.metadata as object),
          providerOrigin: { ...readProviderOrigin(row.metadata)!, badgeId: crypto.randomUUID() },
        },
      })
      .where(eq(tls.id, row.id))
    const [changed] = await w.db.select().from(tls).where(eq(tls.id, row.id))
    const err = await assertRejects(
      () =>
        revokeOriginCertificate({
          db: w.db,
          secrets: w.secrets,
          adapter: fake.adapter,
          row: changed!,
        }),
      OriginCertificateRefusal
    )
    assertEquals(err.error, 'badge_missing')
    assertEquals((await w.db.select().from(tls).where(eq(tls.id, row.id))).length, 1)
    await revokeOriginCertificate({
      db: w.db,
      secrets: w.secrets,
      adapter: fake.adapter,
      row: changed!,
      force: true,
    })
    assertEquals((await w.db.select().from(tls).where(eq(tls.id, row.id))).length, 0)
    assertEquals(fake.revoked.length, 0)
  })
})

test('renewal issues a replacement, re-pins the sites and keeps the old row until it expires', async () => {
  await withWorld(async (w) => {
    const fake = fakeAdapter()
    const old = await issueOriginCertificate({
      ...w,
      adapter: fake.adapter,
      carrier: w.carrierRow,
      badge: w.badgeRow,
      zoneName: 'example.com',
    })
    const hostingId = await pin(w.db, w.serviceId, old.id, 'app.example.com')
    const renewed = await renewOriginCertificate({
      db: w.db,
      secrets: w.secrets,
      adapter: fake.adapter,
      organizationId: w.organizationId,
      row: old,
    })
    assert(renewed)
    assert(renewed.replacement.id !== old.id)
    assertEquals(renewed.repinnedHostingIds, [hostingId])
    assertEquals(await hostingsPinning(w.db, renewed.replacement.id), [hostingId])
    assertEquals(await hostingsPinning(w.db, old.id), [])
    // The old certificate is still there and still valid, and nothing was revoked.
    assertEquals((await w.db.select().from(tls).where(eq(tls.id, old.id))).length, 1)
    assertEquals(fake.revoked.length, 0)
  })
})

test('the sweep renews a pinned certificate that is close to expiry and removes a replaced one only after it expired', async () => {
  await withWorld(async (w) => {
    const fake = fakeAdapter()
    const old = await issueOriginCertificate({
      ...w,
      adapter: fake.adapter,
      carrier: w.carrierRow,
      badge: w.badgeRow,
      zoneName: 'example.com',
    })
    await pin(w.db, w.serviceId, old.id, 'app.example.com')
    const registry = () => fake.adapter
    const base = { db: w.db, secrets: w.secrets, registry, organizationId: w.organizationId }
    // Healthy and pinned: nothing to do.
    let result = await sweepOriginCertificates(base)
    assertEquals([result.renewed, result.removed, result.failed], [[], [], []])
    // Ten days from expiry: renewed, and the site is reported for a push.
    await w.db
      .update(tls)
      .set({ notAfter: new Date(Date.now() + 10 * 86_400_000).toISOString() })
      .where(eq(tls.id, old.id))
    result = await sweepOriginCertificates(base)
    assertEquals(result.renewed.length, 1)
    assertEquals(result.repinnedHostingIds.length, 1)
    // Replaced but not yet expired: kept.
    result = await sweepOriginCertificates(base)
    assertEquals(result.removed, [])
    // Past its own expiry: removed with no revoke call.
    await w.db
      .update(tls)
      .set({ notAfter: new Date(Date.now() - 86_400_000).toISOString() })
      .where(eq(tls.id, old.id))
    result = await sweepOriginCertificates(base)
    assertEquals(result.removed, [old.id])
    assertEquals(fake.revoked.length, 0)
  })
})
