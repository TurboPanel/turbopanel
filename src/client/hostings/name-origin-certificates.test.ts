/**
 * A name that chose the Cloudflare origin certificate gets one: issued by an
 * API token of its own organization, pinned on the name, sent to the servers by
 * a hostings-only apply, and retried by the hourly tick with a back-off when it
 * fails. The provider is a fake. Skips without TURBOPANEL_DATABASE_URL.
 */
import { skipWithoutDatabase } from '../../test-fixtures/require-service.test.support.ts'
import { assert, assertEquals, assertRejects } from '@std/assert'
import { and, eq } from 'drizzle-orm'
import { type Context, Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import { createDenoDb, endDbConnection } from '../../db/connection.ts'
import {
  audit,
  badge,
  carrier,
  deployment,
  environment,
  grant,
  hosting,
  hostname,
  organization,
  project,
  secret,
  server,
  service,
  tls,
  user,
  workspace,
} from '../../db/schema.ts'
import { getDatabaseUrl } from '../../db/url.ts'
import {
  readNameOriginIssues,
  saveNameOriginIssues,
} from '../../features/hostings/name-origin-issues.ts'
import { replaceHostingHostnames } from '../../features/servers/hostname-records.ts'
import type { TunnelAdapter } from '../../features/tunnels/adapter.ts'
import { TunnelProviderError } from '../../features/tunnels/errors.ts'
import { organizationOriginLock } from '../../features/tunnels/origin-certificate.ts'
import { CAPABILITY_PROBE_REVISION } from '../../features/tunnels/records.ts'
import { NO_CAPABILITIES } from '../../features/tunnels/vocabulary.ts'
import type { TunnelAdapterRegistry } from '../../features/tunnels/registry.ts'
import { encryptSecret } from '../../lib/secrets/data-encryption.ts'
import { deriveEncryptionSecretsConfig, deriveSecretsConfig } from '../../lib/secrets/secrets.ts'
import { mintSelfSignedCertificate } from '../../lib/tls/index.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import { buildSignedCookie, HTTP_SESSION_COOKIE_NAME } from '../authn/crypto.ts'
import { createSession } from '../authn/session-store.ts'
import { ORG_ID_HEADER } from '../org-context.ts'
import { registerHostingRoutes } from './routes.ts'
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
  /** The externalId of every certificate the panel revoked at the provider. */
  revoked: string[]
  /** Make the next calls fail with this error until set back to null. */
  failWith: { error: Error | null }
  /** Answer with a certificate the panel cannot read, so storing it fails. */
  brokenCertificate: { on: boolean }
  /** Hold the next issue call until `release` is called; `reached` resolves once it is held. */
  holdNext: () => { release: () => void; reached: Promise<void> }
  /** What a token check reports; counts the checks. */
  check: { count: number; certificates: { id: string; name: string }[] }
}

function fakeProvider(): Fake {
  const issued: Fake['issued'] = []
  const revoked: string[] = []
  const failWith: Fake['failWith'] = { error: null }
  const brokenCertificate = { on: false }
  const check: Fake['check'] = { count: 0, certificates: [] }
  let gate: Promise<void> | null = null
  let reach: () => void = () => {}
  const adapter = {
    provider: 'cloudflare',
    checkCredential: () => {
      check.count += 1
      return Promise.resolve({
        accountVisible: true,
        accounts: [],
        zones: [],
        capabilities: { ...NO_CAPABILITIES, certificates: check.certificates },
        missing: [],
        token: { kind: 'account', id: 'tok-fake', status: 'active', expiresAt: null },
      })
    },
    issueOriginCertificate: async (
      token: string,
      input: { hostnames: readonly string[]; csrPem: string; validityDays: number }
    ) => {
      if (failWith.error) throw failWith.error
      issued.push({ token, hostnames: input.hostnames })
      const externalId = `ext-${issued.length}`
      const waitFor = gate
      gate = null
      if (waitFor) {
        reach()
        await waitFor
      }
      const minted = await mintSelfSignedCertificate([...input.hostnames], { validDays: 365 })
      return {
        externalId,
        certificatePem: brokenCertificate.on ? 'not a certificate' : minted.certificatePem,
        notAfter: minted.parsed.notAfter.toISOString(),
      }
    },
    revokeOriginCertificate: (_token: string, input: { externalId: string }) => {
      revoked.push(input.externalId)
      return Promise.resolve()
    },
  } as unknown as TunnelAdapter
  return {
    registry: () => adapter,
    issued,
    revoked,
    failWith,
    brokenCertificate,
    check,
    holdNext: () => {
      let release: () => void = () => {}
      gate = new Promise<void>((resolve) => (release = resolve))
      const reached = new Promise<void>((resolve) => (reach = resolve))
      return { release, reached }
    },
  }
}

type World = {
  db: Db
  secrets: Awaited<ReturnType<typeof deriveEncryptionSecretsConfig>>
  organizationId: string
  hostingId: string
  serviceId: string
  fake: Fake
  /** Runs the hostings-only apply the route would queue; counts the calls. */
  applies: { count: number }
  context: Context<AppEnv>
  /** Undone before the organizations are removed. */
  cleanup: (() => Promise<void>)[]
  applyDeps: NonNullable<Parameters<typeof issueNameOriginCertificates>[2]['applyDeps']>
}

async function addCarrier(
  db: Db,
  secrets: World['secrets'],
  organizationId: string,
  zones: { id: string; name: string }[],
  options: { token?: string; name?: string; stale?: boolean } = {}
) {
  const token = options.token ?? TOKEN
  const [c] = await db
    .insert(carrier)
    .values({
      organizationId,
      provider: 'cloudflare',
      name: options.name ?? 'Main',
      externalAccountId: `acct-${crypto.randomUUID()}`,
    })
    .returning()
  const [sec] = await db
    .insert(secret)
    .values({
      organizationId,
      provider: 'carrier_badge',
      name: 'token',
      secretEnvelope: await encryptSecret(secrets, token),
    })
    .returning({ id: secret.id })
  await db.insert(badge).values({
    carrierId: c!.id,
    secretId: sec!.id,
    label: options.name ?? 'Main',
    lastFour: token.slice(-4),
    capabilities: { tunnels: true, dns: [], certificates: zones },
    // A token checked since certificates were looked at; `stale` leaves that out.
    options: options.stale ? null : { capabilityProbe: CAPABILITY_PROBE_REVISION },
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
  const cleanup: World['cleanup'] = []
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
    // Everything was edited an hour ago and the environment was deployed since,
    // so the hostings-only apply is safe to queue.
    const hourAgo = new Date(Date.now() - 3_600_000).toISOString()
    await db.update(project).set({ updatedAt: hourAgo }).where(eq(project.id, proj!.id))
    await db.update(environment).set({ updatedAt: hourAgo }).where(eq(environment.id, env!.id))
    await db.update(service).set({ updatedAt: hourAgo }).where(eq(service.id, svc!.id))
    await db.update(hosting).set({ updatedAt: hourAgo }).where(eq(hosting.id, site!.id))
    await db.insert(deployment).values({
      environmentId: env!.id,
      serverId: srv!.id,
      status: 'applied',
      finishedAt: new Date().toISOString(),
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
      serviceId: svc!.id,
      fake: fakeProvider(),
      applies,
      context,
      cleanup,
      applyDeps,
    })
  } finally {
    for (const undo of cleanup.toReversed()) await undo()
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
      onlyHostingIds: [w.hostingId],
    })
    assertEquals(early.pinned, [])
    assertEquals(w.fake.issued.length, 0)
    // The whole tick, after the back-off, issues and sends the pair.
    const after = new Date(Date.now() + 2 * 3_600_000)
    const result = await runHostingLetsEncryptSweepTick(w.db, {
      now: () => after,
      registry: w.fake.registry,
      nameOriginHostingIds: [w.hostingId],
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

test('two calls at once keep one certificate', async () => {
  await withWorld({}, async (w) => {
    const deps = { secrets: w.secrets, registry: w.fake.registry }
    const [a, b] = await Promise.all([
      ensureNameOriginCertificates(w.db, w.hostingId, w.organizationId, deps),
      ensureNameOriginCertificates(w.db, w.hostingId, w.organizationId, deps),
    ])
    // The provider is not called under the lock, so both may issue; the loser is revoked.
    assertEquals(w.fake.issued.length - w.fake.revoked.length, 1)
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

const SECOND_TOKEN = 'cf-second-token-0123456789abcdefghijklmnopqrstuv'

/** Make the hosting serve one more name, set to the origin certificate. */
async function addName(w: World, name: string): Promise<void> {
  const names = (
    await w.db
      .select({ name: hostname.hostname })
      .from(hostname)
      .where(eq(hostname.hostingId, w.hostingId))
  ).map((row) => row.name)
  const all = [...names, name]
  await replaceHostingHostnames(
    w.db,
    w.hostingId,
    w.organizationId,
    all,
    new Map(all.map((n) => [n, { certificate: 'cloudflare_origin' as const, tlsId: null }]))
  )
}

async function pinsByName(w: World): Promise<Map<string, string | null>> {
  const rows = await w.db
    .select({ name: hostname.hostname, tlsId: hostname.tlsId })
    .from(hostname)
    .where(eq(hostname.hostingId, w.hostingId))
  return new Map(rows.map((row) => [row.name, row.tlsId]))
}

test('the longest zone that holds certificate rights issues for a name', async () => {
  await withWorld({}, async (w) => {
    // A second token of the organization is limited to the subdomain zone.
    await addCarrier(w.db, w.secrets, w.organizationId, [{ id: 'z3', name: NAME }], {
      token: SECOND_TOKEN,
      name: 'Narrow',
    })
    const done = await route(w)
    assertEquals(done.pinned, [NAME])
    assertEquals(w.fake.issued.length, 1)
    assertEquals(w.fake.issued[0]!.token, SECOND_TOKEN)
  })
})

test('names of different carriers each go to the token that covers their zone', async () => {
  await withWorld({}, async (w) => {
    await addCarrier(w.db, w.secrets, w.organizationId, [{ id: 'z4', name: 'example.org' }], {
      token: SECOND_TOKEN,
      name: 'Other account',
    })
    await addName(w, 'shop.example.org')
    const done = await route(w)
    assertEquals(done.pinned.toSorted(), [NAME, 'shop.example.org'])
    const byHost = new Map(w.fake.issued.map((i) => [i.hostnames.join(','), i.token]))
    assertEquals(byHost.get(NAME), TOKEN)
    assertEquals(byHost.get('shop.example.org'), SECOND_TOKEN)
    const pins = await pinsByName(w)
    assert(pins.get(NAME) !== null && pins.get('shop.example.org') !== null)
    assert(pins.get(NAME) !== pins.get('shop.example.org'))
  })
})

test('a token checked before certificates were looked at is checked once and then used', async () => {
  await withWorld({ zones: [] }, async (w) => {
    await addCarrier(w.db, w.secrets, w.organizationId, [], { token: SECOND_TOKEN, stale: true })
    w.fake.check.certificates = [{ id: 'z1', name: ZONE }]
    const done = await route(w)
    assertEquals(done.pinned, [NAME])
    assertEquals(w.fake.check.count, 1)
    assertEquals(w.fake.issued[0]!.token, SECOND_TOKEN)
  })
})

test('a token that has been checked is not checked again for a name nothing can place', async () => {
  await withWorld({ zones: [{ id: 'z2', name: 'other.example.net' }] }, async (w) => {
    await route(w)
    assertEquals(w.fake.check.count, 0)
    assertEquals((await readIssue(w))?.code, 'no_badge')
  })
})

test('the lock is free while the provider is being asked', async () => {
  await withWorld({}, async (w) => {
    const held = w.fake.holdNext()
    const running = route(w)
    await held.reached
    // The provider call is under way; the organization lock must not be held across it.
    const lock = organizationOriginLock(w.db, w.organizationId)
    const got = await Promise.race([
      lock(() => Promise.resolve('free')),
      new Promise<string>((resolve) => setTimeout(() => resolve('held'), 3000)),
    ])
    held.release()
    await running
    assertEquals(got, 'free')
    assert((await pinOf(w.db, w.hostingId)) !== null)
  })
})

test('a certificate another caller stored meanwhile is used and the extra one is revoked', async () => {
  await withWorld({}, async (w) => {
    const held = w.fake.holdNext()
    const slow = ensureNameOriginCertificates(w.db, w.hostingId, w.organizationId, {
      secrets: w.secrets,
      registry: w.fake.registry,
    })
    await held.reached
    // The second caller issues, stores and pins while the first waits for the provider.
    const fast = await ensureNameOriginCertificates(w.db, w.hostingId, w.organizationId, {
      secrets: w.secrets,
      registry: w.fake.registry,
    })
    assertEquals(fast.pinned, [NAME])
    held.release()
    const late = await slow
    assertEquals(late.pinned, [])
    assertEquals(w.fake.issued.length, 2)
    // The first call asked first, so its certificate (ext-1) is the extra one.
    assertEquals(w.fake.revoked, ['ext-1'])
    const rows = await w.db.select().from(tls).where(eq(tls.organizationId, w.organizationId))
    assertEquals(rows.length, 1)
    assertEquals(await pinOf(w.db, w.hostingId), rows[0]!.id)
  })
})

test('a certificate that cannot be stored is revoked at the provider', async () => {
  await withWorld({}, async (w) => {
    w.fake.brokenCertificate.on = true
    await assertRejects(() =>
      ensureNameOriginCertificates(w.db, w.hostingId, w.organizationId, {
        secrets: w.secrets,
        registry: w.fake.registry,
      })
    )
    assertEquals(w.fake.revoked, ['ext-1'])
    assertEquals(
      (await w.db.select().from(tls).where(eq(tls.organizationId, w.organizationId))).length,
      0
    )
    assertEquals(await pinOf(w.db, w.hostingId), null)
  })
})

/** A site in the world's service with one waiting name and, when given, a recorded reason. */
async function addSite(
  w: World,
  label: string,
  issue: { nextTryAt: string | null; failedAt: string } | null
): Promise<string> {
  const name = `${label}.example.net`
  const [site] = await w.db
    .insert(hosting)
    .values({ serviceId: w.serviceId, name: label, options: { hostnames: [name] } })
    .returning({ id: hosting.id })
  await replaceHostingHostnames(
    w.db,
    site!.id,
    w.organizationId,
    [name],
    new Map([[name, { certificate: 'cloudflare_origin' as const, tlsId: null }]])
  )
  if (issue) {
    await saveNameOriginIssues(w.db, site!.id, {
      [name]: { code: 'no_badge', message: 'seeded', attempts: 1, ...issue },
    })
  }
  return site!.id
}

async function attemptsOf(w: World, hostingId: string, label: string): Promise<number | null> {
  const [site] = await w.db
    .select({ metadata: hosting.metadata })
    .from(hosting)
    .where(eq(hosting.id, hostingId))
  return readNameOriginIssues(site?.metadata)[`${label}.example.net`]?.attempts ?? null
}

test('the retry goes to the most overdue name first, never the same few', async () => {
  await withWorld({ zones: [] }, async (w) => {
    const now = new Date()
    const ago = (hours: number) => new Date(now.getTime() - hours * 3_600_000).toISOString()
    // Our own site waits with a retry time two hours past; B's is one hour past; C was never tried.
    await saveNameOriginIssues(w.db, w.hostingId, {
      [NAME]: {
        code: 'no_badge',
        message: 'seeded',
        attempts: 1,
        failedAt: ago(3),
        nextTryAt: ago(2),
      },
    })
    const b = await addSite(w, 'b', { failedAt: ago(2), nextTryAt: ago(1) })
    const c = await addSite(w, 'c', null)
    const only = [w.hostingId, b, c]
    const pass = () =>
      sweepNameOriginCertificates(w.db, {
        secrets: w.secrets,
        registry: w.fake.registry,
        now,
        onlyHostingIds: only,
        batch: 1,
      })
    // Never tried first, then the earliest retry time, then the next; each pass moves on.
    assertEquals((await pass()).tried, 1)
    assertEquals(await attemptsOf(w, c, 'c'), 1)
    assertEquals((await issueOf(w))?.attempts, 1)
    assertEquals((await pass()).tried, 1)
    assertEquals((await issueOf(w))?.attempts, 2)
    assertEquals(await attemptsOf(w, b, 'b'), 1)
    assertEquals((await pass()).tried, 1)
    assertEquals(await attemptsOf(w, b, 'b'), 2)
    // Everyone now waits out a fresh back-off.
    assertEquals((await pass()).tried, 0)
    await w.db.delete(hosting).where(eq(hosting.id, b))
    await w.db.delete(hosting).where(eq(hosting.id, c))
  })
})

/** The hosting routes on a Hono app, signed in as a manager of the organization. */
async function routeApp(w: World) {
  const sessionSecrets = await deriveSecretsConfig(
    parseTestSecretsConfig('deno'),
    'session-signing'
  )
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', w.db)
    c.set('dataEncryptionSecrets', w.secrets)
    return next()
  })
  registerHostingRoutes(
    app,
    { secrets: sessionSecrets, runtime: 'deno', signupEnvOverride: undefined },
    { registry: w.fake.registry, applyDeps: w.applyDeps }
  )
  const [member] = await w.db
    .insert(user)
    .values({ email: `origin-${crypto.randomUUID()}@example.com`, isEmailVerified: true })
    .returning({ id: user.id })
  await w.db.insert(grant).values({
    entityType: 'organization',
    entityId: w.organizationId,
    actorType: 'user',
    actorId: member!.id,
    permission: 'organization:manage',
  })
  w.cleanup.push(async () => {
    await w.db.delete(grant).where(eq(grant.actorId, member!.id))
    await w.db.delete(user).where(eq(user.id, member!.id))
  })
  const { token } = await createSession(w.db, member!.id, {})
  const cookie = `${HTTP_SESSION_COOKIE_NAME}=${await buildSignedCookie(token, sessionSecrets)}`
  return async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, {
      method,
      headers: { cookie, [ORG_ID_HEADER]: w.organizationId, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return { status: res.status, body: (await res.json()) as Record<string, any> }
  }
}

const choose = (certificate: string) => ({ names: [{ hostname: NAME, certificate }] })

test('PATCH to the origin certificate issues it, answers with the name, and queues the apply', async () => {
  await withWorld({}, async (w) => {
    await w.db
      .update(hostname)
      .set({ certificate: 'self_signed' })
      .where(eq(hostname.hostingId, w.hostingId))
    const call = await routeApp(w)
    const patched = await call('PATCH', `/hostings/${w.hostingId}`, choose('cloudflare_origin'))
    assertEquals(patched.status, 200)
    assertEquals(w.fake.issued.length, 1)
    const pin = await pinOf(w.db, w.hostingId)
    assert(pin !== null)
    const [name] = patched.body.names as {
      hostname: string
      certificate: string
      tlsId: string | null
      originCertificateIssue: unknown
    }[]
    assertEquals(name?.hostname, NAME)
    assertEquals(name?.certificate, 'cloudflare_origin')
    assertEquals(name?.tlsId, pin)
    assertEquals(name?.originCertificateIssue, null)
    // The save changed the site's updated time; the apply is still queued right after it.
    assertEquals(w.applies.count, 1)
    const read = await call('GET', `/hostings/${w.hostingId}`)
    assertEquals(read.body.hosting.names[0].tlsId, pin)
  })
})

test('a PATCH that also changes what the servers get leaves the pair to the next deploy', async () => {
  await withWorld({}, async (w) => {
    await w.db
      .update(hostname)
      .set({ certificate: 'self_signed' })
      .where(eq(hostname.hostingId, w.hostingId))
    const call = await routeApp(w)
    const patched = await call('PATCH', `/hostings/${w.hostingId}`, {
      ...choose('cloudflare_origin'),
      options: { hostnames: [NAME], www: 'both' },
    })
    assertEquals(patched.status, 200)
    assert((await pinOf(w.db, w.hostingId)) !== null)
    assertEquals(w.applies.count, 0)
  })
})

test('PATCH to the origin certificate with no usable token shows why on the site', async () => {
  await withWorld({ zones: [] }, async (w) => {
    await w.db
      .update(hostname)
      .set({ certificate: 'self_signed' })
      .where(eq(hostname.hostingId, w.hostingId))
    const call = await routeApp(w)
    const patched = await call('PATCH', `/hostings/${w.hostingId}`, choose('cloudflare_origin'))
    assertEquals(patched.status, 200)
    assertEquals(patched.body.names[0].originCertificateIssue.code, 'no_badge')
    const read = await call('GET', `/hostings/${w.hostingId}`)
    assertEquals(read.body.hosting.names[0].originCertificateIssue.code, 'no_badge')
    const list = await call('GET', '/hostings')
    const listed = list.body.hostings.find((h: { id: string }) => h.id === w.hostingId)
    assertEquals(listed.names[0].originCertificateIssue.code, 'no_badge')
    assertEquals(w.applies.count, 0)
  })
})

test('POST of a site whose name chose the origin certificate pins it and answers with the name', async () => {
  await withWorld({}, async (w) => {
    const call = await routeApp(w)
    const made = await call('POST', '/hostings', {
      serviceId: w.serviceId,
      name: 'Second',
      options: { hostnames: ['new.example.net'] },
      names: [{ hostname: 'new.example.net', certificate: 'cloudflare_origin' }],
    })
    assertEquals(made.status, 200)
    assertEquals(made.body.names[0].hostname, 'new.example.net')
    assert(made.body.names[0].tlsId !== null)
    assertEquals(made.body.names[0].originCertificateIssue, null)
    await w.db.delete(hosting).where(eq(hosting.id, made.body.id))
  })
})
