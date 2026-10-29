/**
 * The verified connection for a tunnel against a real database and a faked
 * provider: a site gets a certificate for exactly the names it serves, a site
 * that does not exist yet keeps the connector skipping verification, a site
 * that also serves other names is refused, a site that gains a name gets a new
 * certificate and the old one is retired, and turning it off retires what
 * nothing needs. Skips without TURBOPANEL_DATABASE_URL.
 */
import { skipWithoutDatabase } from '../../test-fixtures/require-service.test.support.ts'
import { assert, assertEquals, assertRejects } from '@std/assert'
import { eq, inArray } from 'drizzle-orm'
import { createDenoDb, endDbConnection } from '../../db/connection.ts'
import { getDatabaseUrl } from '../../db/url.ts'
import {
  badge,
  carrier,
  doorway,
  environment,
  hostname,
  hosting,
  organization,
  project,
  secret,
  service,
  tls,
  tunnel,
  workspace,
} from '../../db/schema.ts'
import { encryptSecret } from '../../lib/secrets/data-encryption.ts'
import { deriveEncryptionSecretsConfig } from '../../lib/secrets/secrets.ts'
import { mintSelfSignedCertificate } from '../../lib/tls/index.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import type { TunnelAdapter } from './adapter.ts'
import { readProviderOrigin } from './origin-certificate.ts'
import { MAX_CERTIFICATES_PER_VERIFY, setVerifyOrigin } from './verify-origin.ts'
import { tunnelVerifyState } from './verify-state.ts'
import { TunnelRefusal } from './lifecycle.ts'

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
  issued: { hostnames: readonly string[] }[]
  revoked: string[]
  routes: { hostnames: readonly string[]; verifyOrigin?: boolean }[]
}

/** A provider with two zones: example.com and other.org. */
function fakeAdapter(): Fake {
  const issued: Fake['issued'] = []
  const revoked: string[] = []
  const routes: Fake['routes'] = []
  let counter = 0
  const adapter = {
    provider: 'cloudflare',
    findZone: (_token: string, input: { hostname: string }) =>
      Promise.resolve(
        input.hostname.endsWith('other.org')
          ? { id: 'z2', name: 'other.org' }
          : { id: 'z1', name: 'example.com' }
      ),
    setRoutes: (
      _token: string,
      input: { hostnames: readonly string[]; verifyOrigin?: boolean }
    ) => {
      routes.push({ hostnames: input.hostnames, verifyOrigin: input.verifyOrigin })
      return Promise.resolve()
    },
    issueOriginCertificate: async (
      _token: string,
      input: { hostnames: readonly string[]; csrPem: string; validityDays: number }
    ) => {
      issued.push({ hostnames: input.hostnames })
      counter += 1
      const minted = await mintSelfSignedCertificate([...input.hostnames], { validDays: 365 })
      return {
        externalId: `ext-${counter}`,
        certificatePem: minted.certificatePem,
        notAfter: minted.parsed.notAfter.toISOString(),
      }
    },
    revokeOriginCertificate: (_token: string, input: { externalId: string }) => {
      revoked.push(input.externalId)
      return Promise.resolve()
    },
  } as unknown as TunnelAdapter
  return { adapter, issued, revoked, routes }
}

type World = {
  db: Db
  organizationId: string
  carrierRow: typeof carrier.$inferSelect
  badgeRow: typeof badge.$inferSelect
  tunnelId: string
  serviceId: string
  deps: Parameters<typeof setVerifyOrigin>[0]
  fake: Fake
}

async function withWorld(fn: (w: World) => Promise<void>): Promise<void> {
  if (!dbUrl) {
    skipWithoutDatabase('verify origin tests')
    return
  }
  const db = createDenoDb()
  const secrets = await deriveEncryptionSecretsConfig(
    parseTestSecretsConfig('deno'),
    'data-encryption'
  )
  const [org] = await db
    .insert(organization)
    .values({ name: `Verify Org ${crypto.randomUUID()}` })
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
        capabilities: {
          tunnels: true,
          dns: [{ id: 'z1', name: 'example.com' }],
          certificates: [{ id: 'z1', name: 'example.com' }],
        },
      })
      .returning()
    const [t] = await db
      .insert(tunnel)
      .values({
        organizationId,
        routingOrganizationId: organizationId,
        provider: 'cloudflare',
        carrierId: c!.id,
        name: 'Verify',
        externalId: 'tun-1',
        placement: 'chosen',
        status: 'active',
      })
      .returning({ id: tunnel.id })
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
    const fake = fakeAdapter()
    await fn({
      db,
      organizationId,
      carrierRow: c!,
      badgeRow: b!,
      tunnelId: t!.id,
      serviceId: svc!.id,
      fake,
      deps: {
        db,
        secrets,
        adapter: fake.adapter,
        organizationId,
      },
    })
  } finally {
    const tunnels = await db
      .select({ id: tunnel.id })
      .from(tunnel)
      .where(eq(tunnel.organizationId, organizationId))
    if (tunnels.length > 0) {
      await db.delete(doorway).where(
        inArray(
          doorway.tunnelId,
          tunnels.map((t) => t.id)
        )
      )
    }
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
        for (const sv of svcs) {
          const sites = await db
            .select({ id: hosting.id })
            .from(hosting)
            .where(eq(hosting.serviceId, sv.id))
          for (const h of sites) await db.delete(hostname).where(eq(hostname.hostingId, h.id))
          await db.delete(hosting).where(eq(hosting.serviceId, sv.id))
        }
        await db.delete(service).where(eq(service.environmentId, e.id))
      }
      await db.delete(environment).where(eq(environment.projectId, p.id))
    }
    await db.delete(project).where(eq(project.organizationId, organizationId))
    await db.delete(workspace).where(eq(workspace.organizationId, organizationId))
    await db.delete(tunnel).where(eq(tunnel.organizationId, organizationId))
    await db.delete(tls).where(eq(tls.organizationId, organizationId))
    await db.delete(organization).where(eq(organization.id, organizationId))
    await endDbConnection(db)
  }
}

/** A site serving these names, with a tunnel name for each of them linked to it. */
async function addSite(w: World, names: string[], tunnelNames: string[] = names): Promise<string> {
  const [h] = await w.db
    .insert(hosting)
    .values({ serviceId: w.serviceId, options: { hostnames: names } })
    .returning({ id: hosting.id })
  for (const name of names) {
    await w.db
      .insert(hostname)
      .values({ hostingId: h!.id, routingOrganizationId: w.organizationId, hostname: name })
  }
  for (const name of tunnelNames) await addTunnelName(w, name, h!.id)
  return h!.id
}

async function addTunnelName(w: World, name: string, hostingId: string | null): Promise<void> {
  await w.db.insert(doorway).values({
    routingOrganizationId: w.organizationId,
    tunnelId: w.tunnelId,
    hostname: name,
    hostingId,
    status: 'live',
  })
}

async function tunnelRow(w: World) {
  const [row] = await w.db.select().from(tunnel).where(eq(tunnel.id, w.tunnelId))
  return row!
}

test('a site gets a certificate for exactly the names it serves, is pointed at it, and the connector verifies', async () => {
  await withWorld(async (w) => {
    const hostingId = await addSite(w, ['app.example.com'])
    const result = await setVerifyOrigin(w.deps, w.carrierRow, await tunnelRow(w), true)
    assertEquals(
      w.fake.issued.map((i) => i.hostnames),
      [['app.example.com']]
    )
    assertEquals(result.pinnedHostingIds, [hostingId])
    const [site] = await w.db.select().from(hosting).where(eq(hosting.id, hostingId))
    const [cert] = await w.db.select().from(tls).where(eq(tls.id, site!.tlsId!))
    assertEquals(cert!.source, 'provider_origin')
    assertEquals(readProviderOrigin(cert!.metadata)?.hostnames, ['app.example.com'])
    assertEquals(result.state, { enabled: true, active: true, pendingNames: [] })
    assertEquals(w.fake.routes.at(-1), { hostnames: ['app.example.com'], verifyOrigin: true })
    assertEquals((await tunnelRow(w)).options, { verifyOrigin: true })
    // Applying it again changes nothing and issues nothing.
    const again = await setVerifyOrigin(w.deps, w.carrierRow, await tunnelRow(w), true)
    assertEquals(again.pinnedHostingIds, [])
    assertEquals(again.issuedCertificateIds, [])
    assertEquals(w.fake.issued.length, 1)
  })
})

test('a name whose site does not exist yet keeps the connector skipping verification for the whole tunnel', async () => {
  await withWorld(async (w) => {
    await addSite(w, ['app.example.com'])
    await addTunnelName(w, 'later.example.com', null)
    const result = await setVerifyOrigin(w.deps, w.carrierRow, await tunnelRow(w), true)
    assertEquals(result.state.enabled, true)
    assertEquals(result.state.active, false)
    assertEquals(result.state.pendingNames, ['later.example.com'])
    assertEquals(w.fake.routes.at(-1)?.verifyOrigin, false)
    // The choice is kept, so it is applied once the site exists.
    assertEquals((await tunnelRow(w)).options, { verifyOrigin: true })
    assertEquals((await tunnelVerifyState(w.db, await tunnelRow(w))).pendingNames, [
      'later.example.com',
    ])
  })
})

test('a site that also serves a name that is not a verified tunnel name is refused and nothing changes', async () => {
  await withWorld(async (w) => {
    await addSite(w, ['app.example.com', 'public.example.com'], ['app.example.com'])
    const err = await assertRejects(
      async () => setVerifyOrigin(w.deps, w.carrierRow, await tunnelRow(w), true),
      TunnelRefusal
    )
    assertEquals(err.code, 'verify_origin_public_names')
    assertEquals(w.fake.issued.length, 0)
    assertEquals((await tunnelRow(w)).options, null)
    assertEquals(w.fake.routes.length, 0)
  })
})

test('a site with names in more than one zone is refused', async () => {
  await withWorld(async (w) => {
    await addSite(w, ['app.example.com', 'app.other.org'])
    const err = await assertRejects(
      async () => setVerifyOrigin(w.deps, w.carrierRow, await tunnelRow(w), true),
      TunnelRefusal
    )
    assertEquals(err.code, 'verify_origin_zones')
    assertEquals(w.fake.issued.length, 0)
  })
})

test('when the site gains a name a new certificate lists both, the site moves to it and the old one is retired', async () => {
  await withWorld(async (w) => {
    const hostingId = await addSite(w, ['a.example.com'])
    await setVerifyOrigin(w.deps, w.carrierRow, await tunnelRow(w), true)
    await w.db.insert(hostname).values({
      hostingId,
      routingOrganizationId: w.organizationId,
      hostname: 'b.example.com',
    })
    await addTunnelName(w, 'b.example.com', hostingId)
    const result = await setVerifyOrigin(w.deps, w.carrierRow, await tunnelRow(w), true)
    assertEquals(
      w.fake.issued.map((i) => i.hostnames),
      [['a.example.com'], ['a.example.com', 'b.example.com']]
    )
    assertEquals(result.pinnedHostingIds, [hostingId])
    const [site] = await w.db.select().from(hosting).where(eq(hosting.id, hostingId))
    assertEquals(site!.tlsId, result.issuedCertificateIds[0])
    const certs = await w.db.select().from(tls).where(eq(tls.organizationId, w.organizationId))
    const retired = certs.filter((c) => readProviderOrigin(c.metadata)?.retiredAt !== null)
    assertEquals(retired.length, 1)
    assertEquals(readProviderOrigin(retired[0]!.metadata)?.hostnames, ['a.example.com'])
    // The old certificate is not revoked while a server could still be using it.
    assertEquals(w.fake.revoked, [])
    assertEquals(result.state.active, true)
  })
})

test('turning it off makes the connector skip verification again and retires the certificates nothing needs', async () => {
  await withWorld(async (w) => {
    const hostingId = await addSite(w, ['app.example.com'])
    await setVerifyOrigin(w.deps, w.carrierRow, await tunnelRow(w), true)
    const result = await setVerifyOrigin(w.deps, w.carrierRow, await tunnelRow(w), false)
    assertEquals(result.state, { enabled: false, active: false, pendingNames: [] })
    assertEquals(w.fake.routes.at(-1)?.verifyOrigin, false)
    assertEquals((await tunnelRow(w)).options, { verifyOrigin: false })
    const certs = await w.db.select().from(tls).where(eq(tls.organizationId, w.organizationId))
    assert(readProviderOrigin(certs[0]!.metadata)!.retiredAt !== null)
    // The site keeps its certificate; only the sweep revokes it, once it is unpinned.
    const [site] = await w.db.select().from(hosting).where(eq(hosting.id, hostingId))
    assertEquals(site!.tlsId, certs[0]!.id)
    assertEquals(w.fake.revoked, [])
  })
})

test('the wildcard is used only when chosen, covers one label, and refuses a deeper name', async () => {
  await withWorld(async (w) => {
    await addSite(w, ['app.example.com'])
    await setVerifyOrigin(w.deps, w.carrierRow, await tunnelRow(w), true, 'wildcard')
    assertEquals(
      w.fake.issued.map((i) => i.hostnames),
      [['example.com', '*.example.com']]
    )
    assertEquals(w.fake.routes.at(-1)?.verifyOrigin, true)
  })
  await withWorld(async (w) => {
    await addSite(w, ['a.b.example.com'])
    const err = await assertRejects(
      async () => setVerifyOrigin(w.deps, w.carrierRow, await tunnelRow(w), true, 'wildcard'),
      TunnelRefusal
    )
    assertEquals(err.code, 'verify_origin_names')
    // Refused before anything was issued.
    assertEquals(w.fake.issued.length, 0)
  })
})

test('a wildcard request refuses before issuing for any site when another site has a deeper name', async () => {
  await withWorld(async (w) => {
    await addSite(w, ['app.example.com'])
    await addSite(w, ['a.b.example.com'])
    await assertRejects(
      async () => setVerifyOrigin(w.deps, w.carrierRow, await tunnelRow(w), true, 'wildcard'),
      TunnelRefusal
    )
    assertEquals(w.fake.issued.length, 0)
  })
})

test('one request issues at most the cap and defers the rest; applying again finishes, issuing nothing twice', async () => {
  await withWorld(async (w) => {
    const total = MAX_CERTIFICATES_PER_VERIFY + 2
    for (let i = 0; i < total; i += 1) await addSite(w, [`s${i}.example.com`])
    const first = await setVerifyOrigin(w.deps, w.carrierRow, await tunnelRow(w), true)
    assertEquals(first.issuedCertificateIds.length, MAX_CERTIFICATES_PER_VERIFY)
    assertEquals(first.deferredHostingIds.length, 2)
    assertEquals(first.state.active, false)
    const second = await setVerifyOrigin(w.deps, w.carrierRow, await tunnelRow(w), true)
    assertEquals(second.issuedCertificateIds.length, 2)
    assertEquals(second.reusedCertificateIds.length, MAX_CERTIFICATES_PER_VERIFY)
    assertEquals(second.deferredHostingIds, [])
    assertEquals(second.state.active, true)
    assertEquals(w.fake.issued.length, total)
  })
})
