/**
 * A name that chose the Cloudflare origin certificate gets one: issued by an
 * API token of its own organization, pinned on the name, sent to the servers by
 * a hostings-only apply, and retried by the hourly tick with a back-off when it
 * fails. The provider is a fake. Skips without TURBOPANEL_DATABASE_URL.
 */
import { skipWithoutDatabase } from '../../test-fixtures/require-service.test.support.ts'
import { assert, assertEquals } from '@std/assert'
import { eq } from 'drizzle-orm'
import type { Context } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import { createDenoDb, endDbConnection } from '../../db/connection.ts'
import {
  audit,
  badge,
  carrier,
  deployment,
  environment,
  hosting,
  hostname,
  organization,
  project,
  secret,
  server,
  service,
  tls,
  workspace,
} from '../../db/schema.ts'
import { getDatabaseUrl } from '../../db/url.ts'
import { readNameOriginIssues } from '../../features/hostings/name-origin-issues.ts'
import { replaceHostingHostnames } from '../../features/servers/hostname-records.ts'
import type { TunnelAdapter } from '../../features/tunnels/adapter.ts'
import { TunnelProviderError } from '../../features/tunnels/errors.ts'
import type { TunnelAdapterRegistry } from '../../features/tunnels/registry.ts'
import { encryptSecret } from '../../lib/secrets/data-encryption.ts'
import { deriveEncryptionSecretsConfig } from '../../lib/secrets/secrets.ts'
import { mintSelfSignedCertificate } from '../../lib/tls/index.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import { runHostingLetsEncryptSweepTick } from './letsencrypt-sweep.ts'
import { loadHostingNameReads } from './name-certificates-routes.ts'
import {
  ensureNameOriginCertificates,
  issueNameOriginCertificates,
  NO_BADGE_RETRY_MS,
  sweepNameOriginCertificates,
} from './name-origin-certificates.ts'

/** Sonar only recognises `test()`; see the note in the other suites. */
const test = Deno.test.bind(Deno)

const dbUrl = getDatabaseUrl()
type Db = ReturnType<typeof createDenoDb>

const TOKEN = 'cf-api-token-0123456789abcdefghijklmnopqrstuv'
const ZONE = 'example.net'
const NAME = 'app.example.net'

type Fake = {
  registry: TunnelAdapterRegistry
  issued: { token: string; hostnames: readonly string[] }[]
  /** Make the next calls fail with this error until set back to null. */
  failWith: { error: Error | null }
}

function fakeProvider(): Fake {
  const issued: Fake['issued'] = []
  const failWith: Fake['failWith'] = { error: null }
  const adapter = {
    provider: 'cloudflare',
    issueOriginCertificate: async (
      token: string,
      input: { hostnames: readonly string[]; csrPem: string; validityDays: number }
    ) => {
      if (failWith.error) throw failWith.error
      issued.push({ token, hostnames: input.hostnames })
      const minted = await mintSelfSignedCertificate([...input.hostnames], { validDays: 365 })
      return {
        externalId: `ext-${issued.length}`,
        certificatePem: minted.certificatePem,
        notAfter: minted.parsed.notAfter.toISOString(),
      }
    },
    revokeOriginCertificate: () => Promise.resolve(),
  } as unknown as TunnelAdapter
  return { registry: () => adapter, issued, failWith }
}

type World = {
  db: Db
  secrets: Awaited<ReturnType<typeof deriveEncryptionSecretsConfig>>
  organizationId: string
  hostingId: string
  fake: Fake
  /** Runs the hostings-only apply the route would queue; counts the calls. */
  applies: { count: number }
  context: Context<AppEnv>
  applyDeps: NonNullable<Parameters<typeof issueNameOriginCertificates>[2]['applyDeps']>
}

async function addCarrier(
  db: Db,
  secrets: World['secrets'],
  organizationId: string,
  zones: { id: string; name: string }[]
) {
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
  await db.insert(badge).values({
    carrierId: c!.id,
    secretId: sec!.id,
    label: 'Main',
    lastFour: TOKEN.slice(-4),
    capabilities: { tunnels: true, dns: [], certificates: zones },
  })
}

async function removeOrganization(db: Db, organizationId: string): Promise<void> {
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
      await db.delete(deployment).where(eq(deployment.environmentId, e.id))
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
  await db.delete(server).where(eq(server.organizationId, organizationId))
  await db.delete(audit).where(eq(audit.organizationId, organizationId))
  await db.delete(organization).where(eq(organization.id, organizationId))
}

/**
 * An organization with a deployed site that serves `app.example.net` and chose
 * the origin certificate for it, plus a second organization whose token covers
 * the same zone. `zones` is what the first organization's token may certify.
 */
async function withWorld(
  options: { zones?: { id: string; name: string }[] },
  fn: (w: World & { otherOrganizationId: string }) => Promise<void>
): Promise<void> {
  if (!dbUrl) {
    skipWithoutDatabase('name origin certificate tests')
    return
  }
  const db = createDenoDb()
  const secrets = await deriveEncryptionSecretsConfig(
    parseTestSecretsConfig('deno'),
    'data-encryption'
  )
  const [org] = await db
    .insert(organization)
    .values({ name: `Name Origin ${crypto.randomUUID()}` })
    .returning({ id: organization.id })
  const [other] = await db
    .insert(organization)
    .values({ name: `Name Origin Other ${crypto.randomUUID()}` })
    .returning({ id: organization.id })
  const organizationId = org!.id
  try {
    await addCarrier(db, secrets, organizationId, options.zones ?? [{ id: 'z1', name: ZONE }])
    // Another organization holds a token for the same zone; it must never be used.
    await addCarrier(db, secrets, other!.id, [{ id: 'z9', name: ZONE }])
    const [ws] = await db
      .insert(workspace)
      .values({ organizationId, name: 'WS' })
      .returning({ id: workspace.id })
    const [proj] = await db
      .insert(project)
      .values({ workspaceId: ws!.id, organizationId, name: 'P' })
      .returning({ id: project.id })
    const [srv] = await db
      .insert(server)
      .values({ organizationId, name: 'Site', isConnected: true })
      .returning({ id: server.id })
    const [env] = await db
      .insert(environment)
      .values({ projectId: proj!.id, name: 'production', isPrimary: true, serverId: srv!.id })
      .returning({ id: environment.id })
    const [svc] = await db
      .insert(service)
      .values({ environmentId: env!.id, name: 'web', composeServiceName: 'web' })
      .returning({ id: service.id })
    const [site] = await db
      .insert(hosting)
      .values({ serviceId: svc!.id, name: 'site', options: { hostnames: [NAME] } })
      .returning({ id: hosting.id })
    await replaceHostingHostnames(
      db,
      site!.id,
      organizationId,
      [NAME],
      new Map([[NAME, { certificate: 'cloudflare_origin', tlsId: null }]])
    )
    // A finished deploy that is newer than every edit, so the apply is safe to queue.
    await db.insert(deployment).values({
      environmentId: env!.id,
      serverId: srv!.id,
      status: 'applied',
      finishedAt: new Date(Date.now() + 60_000).toISOString(),
    })
    const applies = { count: 0 }
    const context = {
      get: (key: string) => (key === 'dataEncryptionSecrets' ? secrets : undefined),
    } as unknown as Context<AppEnv>
    const applyDeps: World['applyDeps'] = {
      commandQueue: { enqueue: () => Promise.resolve() },
      runDeploy: () => {
        applies.count += 1
        return Promise.resolve(Response.json({ ok: true }))
      },
    }
    await fn({
      db,
      secrets,
      organizationId,
      otherOrganizationId: other!.id,
      hostingId: site!.id,
      fake: fakeProvider(),
      applies,
      context,
      applyDeps,
    })
  } finally {
    await removeOrganization(db, organizationId)
    await removeOrganization(db, other!.id)
    await endDbConnection(db)
  }
}

const actor = { userId: crypto.randomUUID(), email: null }

async function pinOf(db: Db, hostingId: string): Promise<string | null> {
  const [row] = await db
    .select({ tlsId: hostname.tlsId })
    .from(hostname)
    .where(eq(hostname.hostingId, hostingId))
  return row?.tlsId ?? null
}

async function issueOf(w: World) {
  const [site] = await w.db
    .select({ metadata: hosting.metadata })
    .from(hosting)
    .where(eq(hosting.id, w.hostingId))
  return readNameOriginIssues(site?.metadata)[NAME]
}

async function readIssue(w: World) {
  const [site] = await w.db
    .select({
      id: hosting.id,
      serviceId: hosting.serviceId,
      options: hosting.options,
      metadata: hosting.metadata,
    })
    .from(hosting)
    .where(eq(hosting.id, w.hostingId))
  const reads = await loadHostingNameReads(w.db, w.organizationId, [site!])
  return reads.get(w.hostingId)?.[0]?.originCertificateIssue ?? null
}

function route(w: World) {
  return issueNameOriginCertificates(w.context, w.db, {
    hostingId: w.hostingId,
    organizationId: w.organizationId,
    actor,
    registry: w.fake.registry,
    applyDeps: w.applyDeps,
  })
}

test('choosing the certificate issues it, pins it, audits it and queues the apply', async () => {
  await withWorld({}, async (w) => {
    const done = await route(w)
    assertEquals(done.pinned, [NAME])
    assertEquals(w.fake.issued.length, 1)
    assertEquals(w.fake.issued[0]!.hostnames, [NAME])
    const pin = await pinOf(w.db, w.hostingId)
    assert(pin !== null)
    const [row] = await w.db.select().from(tls).where(eq(tls.id, pin))
    assertEquals(row?.source, 'provider_origin')
    assertEquals(row?.organizationId, w.organizationId)
    assertEquals(w.applies.count, 1)
    const audits = await w.db.select().from(audit).where(eq(audit.organizationId, w.organizationId))
    assertEquals(audits.filter((a) => a.action === 'origin_certificate.issue').length, 1)
    assertEquals(await readIssue(w), null)
  })
})

test('a second call issues nothing, and a certificate that covers the name is reused', async () => {
  await withWorld({}, async (w) => {
    await route(w)
    const again = await route(w)
    assertEquals(again.pinned, [])
    assertEquals(w.fake.issued.length, 1)
    // Unpin the name: the certificate it had still covers it, so it is pinned again, not reissued.
    const pin = await pinOf(w.db, w.hostingId)
    await w.db.update(hostname).set({ tlsId: null }).where(eq(hostname.hostingId, w.hostingId))
    const reused = await route(w)
    assertEquals(reused.pinned, [NAME])
    assertEquals(w.fake.issued.length, 1)
    assertEquals(await pinOf(w.db, w.hostingId), pin)
    assertEquals(w.applies.count, 2)
  })
})

test('no token with certificate rights records the reason on the name', async () => {
  await withWorld({ zones: [{ id: 'z2', name: 'other.example.net' }] }, async (w) => {
    const done = await route(w)
    assertEquals(done.pinned, [])
    assertEquals(done.failed, [NAME])
    assertEquals(await pinOf(w.db, w.hostingId), null)
    assertEquals(w.applies.count, 0)
    const issue = await readIssue(w)
    assertEquals(issue?.code, 'no_badge')
    assertEquals(issue?.attempts, 1)
    assertEquals(Date.parse(issue!.nextTryAt!) - Date.parse(issue!.failedAt), NO_BADGE_RETRY_MS)
  })
})

test('another organization token is never used, even when it covers the zone', async () => {
  await withWorld({ zones: [] }, async (w) => {
    await route(w)
    assertEquals(w.fake.issued.length, 0)
    assertEquals((await readIssue(w))?.code, 'no_badge')
    const other = await w.db.select().from(tls).where(eq(tls.organizationId, w.otherOrganizationId))
    assertEquals(other.length, 0)
  })
})

test('a provider failure is recorded and the tick retries it after the back-off', async () => {
  await withWorld({}, async (w) => {
    w.fake.failWith.error = new TunnelProviderError('provider_error', 'the provider is down', 500)
    const first = await route(w)
    assertEquals(first.failed, [NAME])
    const issue = await readIssue(w)
    assertEquals(issue?.code, 'provider_error')
    assertEquals(issue?.message, 'the provider is down')
    assertEquals(issue?.attempts, 1)
    // The provider is back, but the name still waits out its back-off: the tick leaves it alone.
    w.fake.failWith.error = null
    const early = await sweepNameOriginCertificates(w.db, {
      secrets: w.secrets,
      registry: w.fake.registry,
    })
    assertEquals(early.pinned, [])
    assertEquals(w.fake.issued.length, 0)
    // The whole tick, after the back-off, issues and sends the pair.
    const after = new Date(Date.now() + 2 * 3_600_000)
    const result = await runHostingLetsEncryptSweepTick(w.db, {
      now: () => after,
      registry: w.fake.registry,
      apply: {
        commandQueue: w.applyDeps.commandQueue!,
        secretsConfig: null,
        dataEncryptionSecrets: w.secrets,
        runDeploy: w.applyDeps.runDeploy!,
      },
    })
    assert(result.scanned >= 0)
    assertEquals(w.fake.issued.length, 1)
    assert((await pinOf(w.db, w.hostingId)) !== null)
    assertEquals(await readIssue(w), null)
    assertEquals(w.applies.count, 1)
  })
})

test('a refused request backs off longer on every failure', async () => {
  await withWorld({}, async (w) => {
    w.fake.failWith.error = new TunnelProviderError('provider_error', 'nope', 500)
    await route(w)
    const at = new Date(Date.now() + 2 * 3_600_000)
    await ensureNameOriginCertificates(w.db, w.hostingId, w.organizationId, {
      secrets: w.secrets,
      registry: w.fake.registry,
      respectBackoff: true,
      now: at,
    })
    const issue = await issueOf(w)
    assertEquals(issue?.attempts, 2)
    assertEquals(Date.parse(issue!.nextTryAt!) - at.getTime(), 2 * 3_600_000)
  })
})

test('two calls at once issue one certificate', async () => {
  await withWorld({}, async (w) => {
    const deps = { secrets: w.secrets, registry: w.fake.registry }
    const [a, b] = await Promise.all([
      ensureNameOriginCertificates(w.db, w.hostingId, w.organizationId, deps),
      ensureNameOriginCertificates(w.db, w.hostingId, w.organizationId, deps),
    ])
    assertEquals(w.fake.issued.length, 1)
    assertEquals(a.pinned.length + b.pinned.length, 1)
    assert((await pinOf(w.db, w.hostingId)) !== null)
  })
})

test('a name that left the choice loses its recorded reason', async () => {
  await withWorld({ zones: [] }, async (w) => {
    await route(w)
    assert((await readIssue(w)) !== null)
    await w.db
      .update(hostname)
      .set({ certificate: 'self_signed' })
      .where(eq(hostname.hostingId, w.hostingId))
    await route(w)
    assertEquals(await issueOf(w), undefined)
  })
})
