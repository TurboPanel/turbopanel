/**
 * Cross-organization object-reference matrix (Road to 0.2.x row security-idor).
 *
 * Every parameterised route the client API registers is called as a signed-in
 * owner of organization A, with the path parameters replaced by the real ids of
 * organization B's resources. The rule, for all of them: never a 2xx/3xx,
 * never a byte of B's data in the body, and never a change to B's rows.
 *
 * Three variants per route: A's own organization header; B's organization
 * header (a spoofed active organization); and, for routes that carry both an
 * organization id and a child id, A's own organization id with B's child id
 * (right organization, wrong parent).
 *
 * Positive controls prove the harness is not simply being blocked before
 * authorization (CSRF, validation): the same calls with A's own ids succeed.
 *
 * Skips without TURBOPANEL_DATABASE_URL (like the other real-database suites).
 */

import { skipWithoutDatabase } from '../test-fixtures/require-service.test.support.ts'
import { assert, assertEquals } from '@std/assert'
import { sql } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AppEnv } from '../app/app.ts'
import { createDenoDb } from '../db/connection.ts'
import { getDatabaseUrl } from '../db/url.ts'
import {
  archive,
  backup,
  binding,
  bulwark,
  command,
  container,
  datacenter,
  deployment,
  edict,
  environment,
  forge,
  grant,
  hosting,
  hostname,
  ip,
  license,
  managed,
  mount,
  network,
  notificationChannel,
  organization,
  principal,
  project,
  repository,
  retention,
  secret,
  server,
  service,
  storage,
  storageCopy,
  tag,
  task,
  team,
  tls,
  user,
  variable,
  workspace,
} from '../db/schema.ts'
import { deriveEncryptionSecretsConfig, deriveSecretsConfig } from '../lib/secrets/secrets.ts'
import { forEachSequential } from '../lib/sequential.ts'
import { parseTestSecretsConfig } from '../test-fixtures/secrets.ts'
import { buildSignedCookie, HTTP_SESSION_COOKIE_NAME } from './authn/crypto.ts'
import { createSession } from './authn/session-store.ts'
import { ORG_ID_HEADER } from './org-context.ts'
import { registerClientRoutes } from './routes.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const dbUrl = getDatabaseUrl()

type Db = ReturnType<typeof createDenoDb>

/** Routes outside the matrix because their path parameters are not object ids. */
const NOT_OBJECT_ID_ROUTES: readonly RegExp[] = [
  /^\/api\/client\/v1\/auth\//, // tokens and provider names, not objects
  /^\/api\/client\/v1\/notification-channels\/verify\//, // an emailed one-time token, not an object id
]

/**
 * Routes that legitimately answer 2xx/3xx when given another organization's id,
 * each with the reason. Empty on purpose: add an entry only with a reason a
 * reviewer can check.
 */
const KNOWN_EXCEPTIONS: Record<string, string> = {}

type Ids = Record<string, string>

type Fixture = {
  db: Db
  app: Hono<AppEnv>
  nonce: string
  orgA: string
  orgB: string
  cookieA: string
  b: Ids
  aOwn: { tagId: string; serverId: string } & Ids
}

async function insertId(promise: Promise<{ id: string }[]>): Promise<string> {
  const rows = await promise
  return rows[0]!.id
}

async function seedOrganizationB(
  db: Db,
  orgB: string,
  ownerB: string,
  nonce: string
): Promise<Ids> {
  const n = (suffix: string) => `idor-${nonce}-${suffix}`
  const ids: Ids = { organizationId: orgB, userId: ownerB }
  const ret = { id: sql`id` }
  void ret

  ids.serverId = await insertId(
    db
      .insert(server)
      .values({ organizationId: orgB, name: n('server') })
      .returning({ id: server.id })
  )
  ids.datacenterId = await insertId(
    db
      .insert(datacenter)
      .values({ organizationId: orgB, name: n('dc') })
      .returning({ id: datacenter.id })
  )
  ids.workspaceId = await insertId(
    db
      .insert(workspace)
      .values({ organizationId: orgB, name: n('ws') })
      .returning({ id: workspace.id })
  )
  ids.projectId = await insertId(
    db
      .insert(project)
      .values({ workspaceId: ids.workspaceId, organizationId: orgB, name: n('project') })
      .returning({ id: project.id })
  )
  ids.environmentId = await insertId(
    db
      .insert(environment)
      .values({ projectId: ids.projectId, name: n('env'), serverId: ids.serverId })
      .returning({ id: environment.id })
  )
  ids.serviceId = await insertId(
    db
      .insert(service)
      .values({ environmentId: ids.environmentId, composeServiceName: n('svc') })
      .returning({ id: service.id })
  )
  ids.storageId = await insertId(
    db
      .insert(storage)
      .values({
        organizationId: orgB,
        kind: 'volume',
        name: n('storage'),
        environmentId: ids.environmentId,
      })
      .returning({ id: storage.id })
  )
  ids.copyId = await insertId(
    db
      .insert(storageCopy)
      .values({ storageId: ids.storageId, serverId: ids.serverId, provider: 'docker' })
      .returning({ id: storageCopy.id })
  )
  ids.mountId = await insertId(
    db
      .insert(mount)
      .values({ storageId: ids.storageId, serviceId: ids.serviceId, destinationPath: '/data' })
      .returning({ id: mount.id })
  )
  ids.networkId = await insertId(
    db
      .insert(network)
      .values({
        organizationId: orgB,
        kind: 'datacenter',
        datacenterId: ids.datacenterId,
        cidr: '10.77.0.0/24',
        name: n('net'),
      })
      .returning({ id: network.id })
  )
  ids.ipId = await insertId(
    db
      .insert(ip)
      .values({
        organizationId: orgB,
        datacenterId: ids.datacenterId,
        address: '10.77.0.5',
        allocation: 'dedicated',
        scope: 'datacenter',
        description: n('ip'),
      })
      .returning({ id: ip.id })
  )
  ids.tagId = await insertId(
    db
      .insert(tag)
      .values({ organizationId: orgB, name: n('tag') })
      .returning({ id: tag.id })
  )
  ids.teamId = await insertId(
    db
      .insert(team)
      .values({ organizationId: orgB, name: n('team') })
      .returning({ id: team.id })
  )
  ids.repositoryId = await insertId(
    db
      .insert(repository)
      .values({
        organizationId: orgB,
        provider: 'github',
        repositoryUrl: `https://github.com/${n('repo')}`,
      })
      .returning({ id: repository.id })
  )
  ids.forgeId = await insertId(
    db
      .insert(forge)
      .values({
        organizationId: orgB,
        provider: 'github',
        name: n('forge'),
        baseUrl: 'https://github.com',
        externalAppId: n('app'),
        envelopes: {},
        webhookRef: n('hook'),
      })
      .returning({ id: forge.id })
  )
  ids.licenseId = await insertId(
    db
      .insert(license)
      .values({ organizationId: orgB, token: n('license') })
      .returning({ id: license.id })
  )
  ids.tlsId = await insertId(
    db
      .insert(tls)
      .values({ organizationId: orgB, source: 'upload', name: n('tls') })
      .returning({ id: tls.id })
  )
  ids.hostingId = await insertId(
    db.insert(hosting).values({ serviceId: ids.serviceId }).returning({ id: hosting.id })
  )
  await db.insert(hostname).values({
    hostingId: ids.hostingId,
    routingOrganizationId: orgB,
    hostname: `${n('host')}.example.test`,
  })
  ids.taskId = await insertId(
    db
      .insert(task)
      .values({ serviceId: ids.serviceId, name: n('task'), schedule: '0 3 * * *', command: 'true' })
      .returning({ id: task.id })
  )
  ids.containerId = await insertId(
    db
      .insert(container)
      .values({
        serviceId: ids.serviceId,
        serverId: ids.serverId,
        containerName: n('c'),
        composeServiceName: n('svc'),
      })
      .returning({ id: container.id })
  )
  ids.managedId = await insertId(
    db
      .insert(managed)
      .values({ environmentId: ids.environmentId, engine: 'postgres' })
      .returning({ id: managed.id })
  )
  ids.policyId = await insertId(
    db
      .insert(retention)
      .values({
        organizationId: orgB,
        targetKind: 'managed',
        managedId: ids.managedId,
        name: n('policy'),
        schedule: '0 3 * * *',
        retentionKeep: 7,
      })
      .returning({ id: retention.id })
  )
  ids.edictId = await insertId(
    db
      .insert(edict)
      .values({
        organizationId: orgB,
        label: n('edict'),
        scope: 'host',
        action: 'accept',
        proto: 'tcp',
        ports: '8080',
        sourceKind: 'any',
      })
      .returning({ id: edict.id })
  )
  await db.insert(bulwark).values({ serverId: ids.serverId })
  ids.principalId = await insertId(
    db
      .insert(principal)
      .values({
        organizationId: orgB,
        kind: 'database',
        provider: 'postgres',
        username: n('p'),
        appliedUsername: n('p'),
      })
      .returning({ id: principal.id })
  )
  await db.insert(binding).values({
    principalId: ids.principalId,
    serviceId: ids.serviceId,
    databaseName: n('db').replaceAll('-', '_').replace(/^\d/, 'x'),
  })
  ids.commandId = await insertId(
    db
      .insert(command)
      .values({ serverId: ids.serverId, actorType: 'user', actorId: ownerB, name: n('cmd') })
      .returning({ id: command.id })
  )
  ids.deploymentId = await insertId(
    db
      .insert(deployment)
      .values({ environmentId: ids.environmentId, serverId: ids.serverId })
      .returning({ id: deployment.id })
  )
  ids.channelId = await insertId(
    db
      .insert(notificationChannel)
      .values({
        scope: 'organization',
        organizationId: orgB,
        kind: 'email',
        label: n('chan'),
        address: `${n('chan')}@example.test`,
      })
      .returning({ id: notificationChannel.id })
  )
  ids.variableId = await insertId(
    db
      .insert(variable)
      .values({
        organizationId: orgB,
        key: 'IDOR_' + nonce.replaceAll('-', '_') + '_VAR',
        value: n('secret-value'),
      })
      .returning({ id: variable.id })
  )
  ids.managedBackupId = `bk_${n('mb').replaceAll('-', '')}`
  await db.insert(backup).values({
    managedId: ids.managedId,
    backupId: ids.managedBackupId,
    sizeBytes: 1,
    checksum: 'a'.repeat(64),
    path: `/backup/${ids.managedId}/${ids.managedBackupId}.sql`,
  })
  ids.archiveBackupId = `bk_${n('ab').replaceAll('-', '')}`
  await db.insert(archive).values({
    copyId: ids.copyId,
    backupId: ids.archiveBackupId,
    sizeBytes: 1,
    checksum: 'b'.repeat(64),
    path: `/backup/copies/${ids.copyId}/${ids.archiveBackupId}.tar.gz`,
  })
  await seedBodyReferences(db, orgB, ids, n)
  return ids
}

/**
 * Objects only ever named in a request body: a credential and a project-bound
 * principal. Seeded for B (the foreign id) and for A (the positive control).
 */
async function seedBodyReferences(
  db: Db,
  org: string,
  ids: Ids,
  n: (suffix: string) => string
): Promise<void> {
  ids.secretId = await insertId(
    db
      .insert(secret)
      .values({ organizationId: org, provider: 'sftp', name: n('secret'), secretEnvelope: 'x' })
      .returning({ id: secret.id })
  )
  ids.projectPrincipalId = await insertId(
    db
      .insert(principal)
      .values({
        organizationId: org,
        projectId: ids.projectId,
        kind: 'database',
        provider: 'postgres',
        username: n('pp'),
        appliedUsername: n('pp'),
      })
      .returning({ id: principal.id })
  )
}

/** One md5 over every table that holds organization B's resources. */
const FINGERPRINT_TABLES = [
  'server',
  'datacenter',
  'workspace',
  'project',
  'environment',
  'service',
  'storage',
  'copy',
  'mount',
  'network',
  'ip',
  'tag',
  'team',
  'repository',
  'forge',
  'license',
  'tls',
  'hosting',
  'hostname',
  'task',
  'container',
  'managed',
  'retention',
  'edict',
  'bulwark',
  'principal',
  'binding',
  'variable',
  'channel',
  'rule',
  'notification',
  'snapshot',
  'upgrade',
  'backup',
  'archive',
  'organization',
] as const

async function fingerprint(db: Db): Promise<string> {
  const parts = FINGERPRINT_TABLES.map(
    (table) =>
      `(select coalesce(md5(string_agg(t::text, '|' order by t::text)), '') from "${table}" t)`
  )
  const rows = await db.execute(sql.raw(`select md5(concat_ws('|', ${parts.join(', ')})) as fp`))
  return String((rows as unknown as { fp: string }[])[0]!.fp)
}

type RouteCall = {
  method: string
  template: string
  params: string[]
}

function listParameterisedRoutes(app: Hono<AppEnv>): RouteCall[] {
  const seen = new Set<string>()
  const calls: RouteCall[] = []
  for (const route of app.routes) {
    if (route.method === 'ALL') continue
    if (!route.path.includes(':')) continue
    if (NOT_OBJECT_ID_ROUTES.some((pattern) => pattern.test(route.path))) continue
    const key = `${route.method} ${route.path}`
    if (seen.has(key)) continue
    seen.add(key)
    const params = [...route.path.matchAll(/:([A-Za-z]+)/g)].map((match) => match[1]!)
    calls.push({ method: route.method, template: route.path, params })
  }
  return calls
}

/** The B-owned id a path parameter should carry, chosen from the segment before it. */
function foreignIdFor(template: string, param: string, previous: string, ids: Ids): string {
  const byParam: Record<string, string | undefined> = {
    copyId: ids.copyId,
    projectId: ids.projectId,
    policyId: ids.policyId,
    serverId: ids.serverId,
    memberId: ids.userId,
    networkId: ids.networkId,
    mountId: ids.mountId,
    edictId: ids.edictId,
    commandId: ids.commandId,
    deploymentId: ids.deploymentId,
    principalId: ids.principalId,
    databaseName: 'appdb',
    component: 'daemon',
    keyId: crypto.randomUUID(),
  }
  if (param === 'backupId') {
    return template.includes('/storage/') ? ids.archiveBackupId! : ids.managedBackupId!
  }
  const fromParam = byParam[param]
  if (fromParam !== undefined) return fromParam
  const bySegment: Record<string, string | undefined> = {
    organizations: ids.organizationId,
    environments: ids.environmentId,
    servers: ids.serverId,
    storage: ids.storageId,
    datacenters: ids.datacenterId,
    principals: ids.principalId,
    repositories: ids.repositoryId,
    projects: ids.projectId,
    containers: ids.containerId,
    forges: ids.forgeId,
    networks: ids.networkId,
    ips: ids.ipId,
    'notification-channels': ids.channelId,
    workspaces: ids.workspaceId,
    variables: ids.variableId,
    tags: ids.tagId,
    tasks: ids.taskId,
    services: ids.serviceId,
    hostings: ids.hostingId,
    tls: ids.tlsId,
    bindings: ids.principalId,
    licenses: ids.licenseId,
    teams: ids.teamId,
  }
  return bySegment[previous] ?? crypto.randomUUID()
}

function fillTemplate(call: RouteCall, ids: Ids, options: { ownOrgId?: string }): string {
  const segments = call.template.split('/')
  return segments
    .map((segment, index) => {
      if (!segment.startsWith(':')) return segment
      const param = /:([A-Za-z]+)/.exec(segment)![1]!
      const previous = segments[index - 1] ?? ''
      if (previous === 'organizations' && param === 'id' && options.ownOrgId !== undefined) {
        return options.ownOrgId
      }
      return foreignIdFor(call.template, param, previous, ids)
    })
    .join('/')
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function request(
  fixture: Fixture,
  method: string,
  path: string,
  organizationHeader: string | undefined
): Promise<{ status: number; body: string } | 'timeout'> {
  const headers: Record<string, string> = {
    cookie: fixture.cookieA,
    'content-type': 'application/json',
    origin: 'http://localhost',
  }
  if (organizationHeader !== undefined) headers[ORG_ID_HEADER] = organizationHeader
  const hasBody = method !== 'GET' && method !== 'DELETE' && method !== 'HEAD'
  const result = await withTimeout(
    Promise.resolve(
      fixture.app.request(path, { method, headers, body: hasBody ? '{}' : undefined })
    ).then(async (response) => ({ status: response.status, body: await response.text() })),
    15_000
  )
  return result
}

/** A's own objects for the body-id positive controls. */
async function seedBodyTargetsA(db: Db, orgA: string, nonce: string): Promise<Ids> {
  const n = (suffix: string) => `idor-a-${nonce}-${suffix}`
  const ids: Ids = {}
  ids.workspaceId = await insertId(
    db
      .insert(workspace)
      .values({ organizationId: orgA, name: n('workspace') })
      .returning({ id: workspace.id })
  )
  ids.projectId = await insertId(
    db
      .insert(project)
      .values({ workspaceId: ids.workspaceId, organizationId: orgA, name: n('project') })
      .returning({ id: project.id })
  )
  ids.storageId = await insertId(
    db
      .insert(storage)
      .values({ organizationId: orgA, kind: 'volume', name: n('storage') })
      .returning({ id: storage.id })
  )
  await seedBodyReferences(db, orgA, ids, n)
  return ids
}

async function withFixtureOn(db: Db, fn: (fixture: Fixture) => Promise<void>): Promise<void> {
  const secretsConfig = parseTestSecretsConfig('deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const dataEncryptionSecrets = await deriveEncryptionSecretsConfig(
    secretsConfig,
    'data-encryption'
  )
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    c.set('secretsConfig', secretsConfig)
    c.set('dataEncryptionSecrets', dataEncryptionSecrets)
    return next()
  })
  registerClientRoutes(app, { secrets, runtime: 'deno', signupEnvOverride: undefined })

  const nonce = crypto.randomUUID().slice(0, 8)
  const orgs = await db
    .insert(organization)
    .values([{ name: `IDOR A ${nonce}` }, { name: `IDOR B ${nonce}` }])
    .returning({ id: organization.id })
  const [orgA, orgB] = [orgs[0]!.id, orgs[1]!.id]
  const makeUser = async (org: string, permission: string, label: string) => {
    const id = await insertId(
      db
        .insert(user)
        .values({
          email: `idor-${label}-${crypto.randomUUID()}@example.com`,
          isEmailVerified: true,
          role: 'user',
        })
        .returning({ id: user.id })
    )
    await db.insert(grant).values({
      entityType: 'organization',
      entityId: org,
      actorType: 'user',
      actorId: id,
      permission,
    })
    return id
  }
  const ownerA = await makeUser(orgA, 'organization:own', 'a')
  const ownerB = await makeUser(orgB, 'organization:own', 'b')
  const { token } = await createSession(db, ownerA, {})
  const cookieA = `${HTTP_SESSION_COOKIE_NAME}=${await buildSignedCookie(token, secrets)}`

  const aOwn = {
    tagId: await insertId(
      db
        .insert(tag)
        .values({ organizationId: orgA, name: `idor-a-${nonce}-tag` })
        .returning({ id: tag.id })
    ),
    serverId: await insertId(
      db
        .insert(server)
        .values({ organizationId: orgA, name: `idor-a-${nonce}-server` })
        .returning({ id: server.id })
    ),
  }
  Object.assign(aOwn, await seedBodyTargetsA(db, orgA, nonce))
  const b = await seedOrganizationB(db, orgB, ownerB, nonce)
  await fn({ db, app, nonce, orgA, orgB, cookieA, b, aOwn })
}

class RollbackFixture extends Error {}

/**
 * Everything the fixture seeds is rolled back at the end, so the shared test
 * database is left exactly as found (other suites scan whole tables).
 */
async function withFixture(fn: (fixture: Fixture) => Promise<void>): Promise<void> {
  if (!dbUrl) {
    skipWithoutDatabase('IDOR matrix')
    return
  }
  try {
    await createDenoDb().transaction(async (tx) => {
      await withFixtureOn(tx as unknown as Db, fn)
      throw new RollbackFixture()
    })
  } catch (error) {
    if (!(error instanceof RollbackFixture)) throw error
  }
}

test('positive controls: A can use A’s own objects through the same harness', async () => {
  await withFixture(async (fixture) => {
    const own = await request(
      fixture,
      'GET',
      `/api/client/v1/servers/${fixture.aOwn.serverId}`,
      fixture.orgA
    )
    assert(own !== 'timeout')
    assertEquals(own.status, 200, `own server read: ${own.body}`)
    const patched = await request(
      fixture,
      'PATCH',
      `/api/client/v1/tags/${fixture.aOwn.tagId}`,
      fixture.orgA
    )
    assert(patched !== 'timeout')
    // `{}` is a valid empty patch or a 400 validation answer; what it must not be is a block
    // before authorization (401/403/404) on an object the caller owns.
    assert(
      ![401, 403, 404].includes(patched.status),
      `own tag patch blocked: ${patched.status} ${patched.body}`
    )
    const orgRead = await request(
      fixture,
      'GET',
      `/api/client/v1/organizations/${fixture.orgA}/firewall`,
      fixture.orgA
    )
    assert(orgRead !== 'timeout')
    assertEquals(orgRead.status, 200, `own org firewall read: ${orgRead.body}`)
  })
})

test('every parameterised client route refuses another organization’s ids, leaks nothing, changes nothing', async () => {
  await withFixture(async (fixture) => {
    const calls = listParameterisedRoutes(fixture.app)
    assert(calls.length > 150, `expected the full client route list, found ${calls.length}`)
    const failures: string[] = []
    let requests = 0

    const check = async (
      call: RouteCall,
      variant: string,
      path: string,
      organizationHeader: string | undefined
    ) => {
      const label = `${call.method} ${call.template} [${variant}]`
      if (KNOWN_EXCEPTIONS[`${call.method} ${call.template}`] !== undefined) return
      const before = await fingerprint(fixture.db)
      const result = await request(fixture, call.method, path, organizationHeader)
      requests++
      const after = await fingerprint(fixture.db)
      if (result === 'timeout') {
        failures.push(`${label}: no answer within 15 s`)
        return
      }
      if (result.status < 400) failures.push(`${label}: answered ${result.status}`)
      if (result.status >= 500) failures.push(`${label}: server error ${result.status}`)
      if (result.body.includes(fixture.nonce))
        failures.push(`${label}: body contains organization B's data`)
      if (before !== after) failures.push(`${label}: organization B's rows changed`)
    }

    for (const call of calls) {
      await check(call, 'A header', fillTemplate(call, fixture.b, {}), fixture.orgA)
      await check(call, 'B header', fillTemplate(call, fixture.b, {}), fixture.orgB)
      if (call.template.includes('/organizations/:id/') && call.params.length > 1) {
        await check(
          call,
          'own org, foreign child',
          fillTemplate(call, fixture.b, { ownOrgId: fixture.orgA }),
          fixture.orgA
        )
      }
    }
    assert(requests > 300, `expected hundreds of requests, ran ${requests}`)
    assertEquals(
      failures,
      [],
      `IDOR matrix failures (${failures.length} of ${requests} requests):\n${failures.join('\n')}`
    )
  })
})

/**
 * Ids named in a request body or query rather than the path (audit P2-16: the
 * path-only matrix is why a foreign `defaultServerId` on create went unnoticed).
 * Each case is sent twice with the same body: once carrying B's id, which must
 * be refused as 404, and once carrying A's own id, which must succeed. The
 * positive control is what keeps the 404 from passing on a validation error.
 */
type BodyCase = {
  method: string
  path: (own: Ids) => string
  body: (own: Ids, ref: Ids, nonce: string) => Record<string, unknown>
}

const BODY_ID_CASES: Record<string, BodyCase> = {
  'POST /projects options.defaultServerId': {
    method: 'POST',
    path: () => '/api/client/v1/projects',
    body: (own, ref, nonce) => ({
      workspaceId: own.workspaceId,
      name: `idor-body-${nonce}-${crypto.randomUUID().slice(0, 8)}`,
      type: 'empty',
      options: { defaultServerId: ref.serverId },
    }),
  },
  'POST /storage principalId': {
    method: 'POST',
    path: () => '/api/client/v1/storage',
    body: (_own, ref, nonce) => ({
      kind: 'volume',
      name: `idor-body-${nonce}-${crypto.randomUUID().slice(0, 8)}`,
      principalId: ref.projectPrincipalId,
    }),
  },
  'PATCH /storage/:id principalId': {
    method: 'PATCH',
    path: (own) => `/api/client/v1/storage/${own.storageId}`,
    body: (_own, ref) => ({ principalId: ref.projectPrincipalId }),
  },
  'POST /storage/:id/copies secretId': {
    method: 'POST',
    path: (own) => `/api/client/v1/storage/${own.storageId}/copies`,
    body: (own, ref) => ({
      provider: 'docker',
      serverId: own.serverId,
      path: `/idor/${crypto.randomUUID()}`,
      secretId: ref.secretId,
    }),
  },
}

async function sendJson(
  fixture: Fixture,
  method: string,
  path: string,
  body: Record<string, unknown>
): Promise<{ status: number; text: string }> {
  const response = await fixture.app.request(path, {
    method,
    headers: {
      cookie: fixture.cookieA,
      'content-type': 'application/json',
      origin: 'http://localhost',
      [ORG_ID_HEADER]: fixture.orgA,
    },
    body: JSON.stringify(body),
  })
  return { status: response.status, text: await response.text() }
}

for (const [name, entry] of Object.entries(BODY_ID_CASES)) {
  test(`body ids: ${name} refuses B's id and accepts A's own`, async () => {
    await withFixture(async (fixture) => {
      const path = entry.path(fixture.aOwn)
      const foreign = await sendJson(
        fixture,
        entry.method,
        path,
        entry.body(fixture.aOwn, fixture.b, fixture.nonce)
      )
      assertEquals(foreign.status, 404, `foreign id: ${foreign.text}`)
      const own = await sendJson(
        fixture,
        entry.method,
        path,
        entry.body(fixture.aOwn, fixture.aOwn, fixture.nonce)
      )
      assert(own.status >= 200 && own.status < 300, `own id: ${own.status} ${own.text}`)
    })
  })
}

/** Every id field name a create, update or list filter takes, set to B's object. */
function foreignReferenceFields(ids: Ids): Record<string, string> {
  return {
    serverId: ids.serverId!,
    defaultServerId: ids.serverId!,
    sourceServerId: ids.serverId!,
    datacenterId: ids.datacenterId!,
    workspaceId: ids.workspaceId!,
    projectId: ids.projectId!,
    environmentId: ids.environmentId!,
    serviceId: ids.serviceId!,
    storageId: ids.storageId!,
    networkId: ids.networkId!,
    ipId: ids.ipId!,
    tlsId: ids.tlsId!,
    hostingId: ids.hostingId!,
    principalId: ids.projectPrincipalId!,
    repositoryId: ids.repositoryId!,
    secretId: ids.secretId!,
    managedId: ids.managedId!,
    teamId: ids.teamId!,
    tagId: ids.tagId!,
    forgeId: ids.forgeId!,
    containerId: ids.containerId!,
    taskId: ids.taskId!,
  }
}

/**
 * md5 over every row, in any fingerprinted table, whose text names one of B's
 * ids. Changes when one of B's rows changes and when any other row starts
 * referencing B (the stored-foreign-reference class); rows A creates for itself
 * do not move it.
 */
async function rowsNamingB(db: Db, ids: Ids): Promise<string> {
  const uuids = Object.values(ids).filter((id) => /^[0-9a-f-]{36}$/.test(id))
  const pattern = uuids.join('|')
  const parts = FINGERPRINT_TABLES.map(
    (table) =>
      `(select coalesce(md5(string_agg(t::text, '|' order by t::text)), '') from "${table}" t where t::text ~ '${pattern}')`
  )
  const rows = await db.execute(sql.raw(`select md5(concat_ws('|', ${parts.join(', ')})) as fp`))
  return String((rows as unknown as { fp: string }[])[0]!.fp)
}

/** Markers only B's seeded rows carry (A's are `idor-a-<nonce>-…`, `IDOR A <nonce>`). */
function revealsB(body: string, nonce: string): boolean {
  return body.includes(`idor-${nonce}-`) || body.includes(`IDOR B ${nonce}`)
}

function isUnparameterised(route: { method: string; path: string }): boolean {
  return (
    route.method !== 'ALL' &&
    !route.path.includes(':') &&
    !route.path.includes('*') &&
    !NOT_OBJECT_ID_ROUTES.some((pattern) => pattern.test(route.path))
  )
}

/**
 * One unparameterised route, called as A with B's ids in the query (reads) or
 * the body (writes). Returns what went wrong, if anything.
 */
async function probeWithForeignReferences(
  fixture: Fixture,
  route: { method: string; path: string },
  query: string,
  body: Record<string, unknown>
): Promise<string[]> {
  const before = await rowsNamingB(fixture.db, fixture.b)
  const result =
    route.method === 'GET'
      ? await request(fixture, 'GET', `${route.path}?${query}`, fixture.orgA)
      : await sendJson(fixture, route.method, route.path, body).then((r) => ({
          status: r.status,
          body: r.text,
        }))
  const after = await rowsNamingB(fixture.db, fixture.b)
  if (result === 'timeout') return ['no answer within 15 s']
  const problems: string[] = []
  // A 401 means A's session stopped working: every later route would then pass
  // vacuously, so it is a harness failure, never a pass.
  if (result.status === 401) problems.push('answered 401 to a signed-in owner')
  // 503 is a feature the harness leaves unconfigured (upgrade channel, public URL).
  if (result.status >= 500 && result.status !== 503) {
    problems.push(`server error ${result.status}`)
  }
  if (revealsB(result.body, fixture.nonce)) problems.push("body contains B's data")
  if (before !== after) problems.push('stored or changed a reference to B')
  return problems
}

test('unparameterised client routes never act on or reveal B through body or query ids', async () => {
  await withFixture(async (fixture) => {
    const fields = foreignReferenceFields(fixture.b)
    const query = new URLSearchParams(fields).toString()
    const body = { ...fields, options: { defaultServerId: fixture.b.serverId } }
    const routes = new Map(
      fixture.app.routes
        .filter(isUnparameterised)
        .map((route) => [`${route.method} ${route.path}`, route])
    )
    assert(routes.size > 30, `expected the unparameterised routes, found ${routes.size}`)
    const failures: string[] = []
    await forEachSequential(routes, async ([key, route]) => {
      const problems = await probeWithForeignReferences(fixture, route, query, body)
      failures.push(...problems.map((problem) => `${key}: ${problem}`))
    })
    assertEquals(failures, [], failures.join('\n'))
  })
})
