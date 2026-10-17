/**
 * DB-backed coverage for the SSL minimum under external access: which servers
 * count as fronting a cluster (members, bound consumers, granted placements),
 * and what each refusal names.
 */

import { skipWithoutDatabase } from '../../test-fixtures/require-service.test.support.ts'
import { assertEquals, assertStringIncludes } from '@std/assert'
import { eq, inArray } from 'drizzle-orm'
import { getDatabaseUrl } from '../../db/url.ts'
import { createDenoDb, endDbConnection } from '../../db/connection.ts'
import {
  binding,
  environment,
  managed,
  organization,
  login,
  managedDatabase,
  project,
  replica,
  server,
  service,
  workspace,
} from '../../db/schema.ts'
import {
  checkExternalAccessForWeakSslModes,
  checkManagedSslModeForExternalAccess,
  checkOrgDefaultSslModeForExternalAccess,
  resolveEffectiveManagedSsl,
} from './external-access-tls.ts'
import { loadManagedFrontendServerIds } from './external-access.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const dbUrl = getDatabaseUrl()

type Db = ReturnType<typeof createDenoDb>

/** Inserts rows and remembers them, so `cleanup` removes exactly what a test made. */
function fixture(db: Db) {
  const made = {
    organizations: [] as string[],
    workspaces: [] as string[],
    servers: [] as string[],
    projects: [] as string[],
    environments: [] as string[],
    managed: [] as string[],
    services: [] as string[],
  }

  async function org(name: string): Promise<{ organizationId: string; workspaceId: string }> {
    const [orgRow] = await db
      .insert(organization)
      .values({ name })
      .returning({ id: organization.id })
    const [ws] = await db
      .insert(workspace)
      .values({ name: `${name} workspace`, organizationId: orgRow!.id })
      .returning({ id: workspace.id })
    made.organizations.push(orgRow!.id)
    made.workspaces.push(ws!.id)
    return { organizationId: orgRow!.id, workspaceId: ws!.id }
  }

  async function host(organizationId: string, name: string, external: boolean): Promise<string> {
    const now = new Date().toISOString()
    const [row] = await db
      .insert(server)
      .values({
        organizationId,
        name,
        createdAt: now,
        updatedAt: now,
        isConnected: true,
        statusChangedAt: now,
        options: { managedExternalAccess: { enabled: external } },
      })
      .returning({ id: server.id })
    made.servers.push(row!.id)
    return row!.id
  }

  async function environmentIn(
    owner: { organizationId: string; workspaceId: string },
    name: string,
    serverId: string
  ): Promise<string> {
    const [projectRow] = await db
      .insert(project)
      .values({ name, workspaceId: owner.workspaceId, organizationId: owner.organizationId })
      .returning({ id: project.id })
    made.projects.push(projectRow!.id)
    const [envRow] = await db
      .insert(environment)
      .values({ name: 'Production', projectId: projectRow!.id, serverId })
      .returning({ id: environment.id })
    made.environments.push(envRow!.id)
    return envRow!.id
  }

  /** A cluster with one member per server in `serverIds` (the first is the primary). */
  async function cluster(
    owner: { organizationId: string; workspaceId: string },
    name: string,
    serverIds: string[],
    sslMode?: string
  ): Promise<string> {
    const environmentId = await environmentIn(owner, `${name} project`, serverIds[0]!)
    const [row] = await db
      .insert(managed)
      .values({
        environmentId,
        serverId: serverIds[0]!,
        name,
        engine: 'postgres',
        status: 'ready',
        options: { settings: { ssl: sslMode ? { mode: sslMode } : {} } },
      })
      .returning({ id: managed.id })
    made.managed.push(row!.id)
    await db.insert(managedDatabase).values({ managedId: row!.id, name: 'postgres' })
    for (const [index, serverId] of serverIds.entries()) {
      await db.insert(replica).values({
        managedId: row!.id,
        serverId,
        role: index === 0 ? 'primary' : 'replica',
        isReadEligible: false,
        ordinal: index + 1,
      })
    }
    return row!.id
  }

  /** A service of `owner` placed on `serverId`, bound to `managedId`. */
  async function consumer(
    owner: { organizationId: string; workspaceId: string },
    serverId: string,
    managedId: string
  ): Promise<void> {
    const environmentId = await environmentIn(owner, `consumer ${crypto.randomUUID()}`, serverId)
    const [serviceRow] = await db
      .insert(service)
      .values({ environmentId, composeServiceName: 'web' })
      .returning({ id: service.id })
    made.services.push(serviceRow!.id)
    const username = `app_${crypto.randomUUID().slice(0, 8)}`
    const [loginRow] = await db
      .insert(login)
      .values({ managedId, role: 'user', username, appliedUsername: username })
      .returning({ id: login.id })
    const [databaseRow] = await db
      .select({ id: managedDatabase.id })
      .from(managedDatabase)
      .where(eq(managedDatabase.managedId, managedId))
    await db.insert(binding).values({
      loginId: loginRow!.id,
      serviceId: serviceRow!.id,
      databaseId: databaseRow!.id,
      keyPrefix: 'DATABASE',
      isEmitEngineDefaults: false,
    })
  }

  async function cleanup(): Promise<void> {
    if (made.services.length > 0) {
      await db.delete(binding).where(inArray(binding.serviceId, made.services))
      await db.delete(service).where(inArray(service.id, made.services))
    }
    if (made.managed.length > 0) {
      await db.delete(replica).where(inArray(replica.managedId, made.managed))
      await db.delete(managed).where(inArray(managed.id, made.managed))
    }
    if (made.environments.length > 0) {
      await db.delete(environment).where(inArray(environment.id, made.environments))
    }
    if (made.projects.length > 0) await db.delete(project).where(inArray(project.id, made.projects))
    if (made.servers.length > 0) await db.delete(server).where(inArray(server.id, made.servers))
    if (made.workspaces.length > 0) {
      await db.delete(workspace).where(inArray(workspace.id, made.workspaces))
    }
    if (made.organizations.length > 0) {
      await db.delete(organization).where(inArray(organization.id, made.organizations))
    }
  }

  return { org, host, cluster, consumer, cleanup }
}

async function withFixture(
  label: string,
  fn: (db: Db, f: ReturnType<typeof fixture>) => Promise<void>
): Promise<void> {
  if (!dbUrl) {
    skipWithoutDatabase(label)
    return
  }
  const db = createDenoDb()
  const f = fixture(db)
  try {
    await fn(db, f)
  } finally {
    await f.cleanup()
    await endDbConnection(db)
  }
}

test('a database on two servers is held to Require by the one that allows external access', async () => {
  await withFixture('external-access-tls two servers', async (db, f) => {
    const owner = await f.org('Two Servers Org')
    const closed = await f.host(owner.organizationId, 'closed-host', false)
    const open = await f.host(owner.organizationId, 'open-host', true)
    const managedId = await f.cluster(owner, 'Orders', [closed, open], 'disable')

    const refusal = await checkManagedSslModeForExternalAccess(db, {
      managedId,
      configured: 'prefer',
      organizationDefault: undefined,
    })
    assertEquals(refusal && 'servers' in refusal ? refusal.servers : null, ['open-host'])
    assertEquals(
      await resolveEffectiveManagedSsl(db, {
        managedId,
        configured: 'disable',
        organizationDefault: undefined,
      }),
      { mode: 'require', raisedForExternalAccess: true }
    )

    // Turning the closed server on as well is refused while the mode is weak.
    assertEquals(
      (await checkExternalAccessForWeakSslModes(db, closed))?.error,
      'external_access_weak_ssl'
    )
  })
})

test('a database fronted only through a binding counts that server', async () => {
  await withFixture('external-access-tls binding', async (db, f) => {
    const owner = await f.org('Binding Org')
    const engineHost = await f.host(owner.organizationId, 'engine-host', false)
    const appHost = await f.host(owner.organizationId, 'app-host', true)
    const managedId = await f.cluster(owner, 'Billing', [engineHost])
    await f.consumer(owner, appHost, managedId)

    assertEquals(
      (await loadManagedFrontendServerIds(db, managedId)).toSorted(),
      [engineHost, appHost].toSorted()
    )
    const refusal = await checkManagedSslModeForExternalAccess(db, {
      managedId,
      configured: 'allow',
      organizationDefault: undefined,
    })
    assertEquals(refusal && 'servers' in refusal ? refusal.servers : null, ['app-host'])

    // The cluster follows the org default, so a weak default is refused too.
    const defaultRefusal = await checkOrgDefaultSslModeForExternalAccess(db, {
      organizationId: owner.organizationId,
      sslMode: 'prefer',
    })
    assertEquals(
      defaultRefusal && 'databases' in defaultRefusal ? defaultRefusal.databases : null,
      ['Billing']
    )
    // Nothing weak yet, so the app server's switch may stay on.
    assertEquals(await checkExternalAccessForWeakSslModes(db, appHost), null)
  })
})

test("a granted placement names only the server owner's databases and counts the others", async () => {
  await withFixture('external-access-tls cross org', async (db, f) => {
    const hostOwner = await f.org('Host Owner Org')
    const tenant = await f.org('Tenant Org')
    const sharedHost = await f.host(hostOwner.organizationId, 'shared-host', false)
    await f.cluster(hostOwner, 'Owner Weak', [sharedHost], 'prefer')
    await f.cluster(tenant, 'Tenant Secret Name', [sharedHost], 'disable')

    const refusal = await checkExternalAccessForWeakSslModes(db, sharedHost)
    if (refusal?.error !== 'external_access_weak_ssl') throw new TypeError('expected a refusal')
    assertEquals(refusal.databases, ['Owner Weak'])
    assertEquals(refusal.otherDatabases, 1)
    assertStringIncludes(refusal.message, '1 database of another organization')
    assertEquals(refusal.message.includes('Tenant Secret Name'), false)
  })
})

test('a consumer of another organization on a server does not make that server front the cluster', async () => {
  await withFixture('external-access-tls cross org consumer', async (db, f) => {
    const clusterOwner = await f.org('Cluster Owner Org')
    const hostOwner = await f.org('Granting Org')
    const engineHost = await f.host(clusterOwner.organizationId, 'own-engine-host', false)
    const grantedHost = await f.host(hostOwner.organizationId, 'granted-host', true)
    const managedId = await f.cluster(clusterOwner, 'Reports', [engineHost])
    // The ingress builder fronts only bindings of the server owner's
    // organization, so this consumer does not put the cluster on that ProxySQL.
    await f.consumer(clusterOwner, grantedHost, managedId)

    assertEquals(await loadManagedFrontendServerIds(db, managedId), [engineHost])
    assertEquals(
      await checkManagedSslModeForExternalAccess(db, {
        managedId,
        configured: 'disable',
        organizationDefault: undefined,
      }),
      null
    )
  })
})
