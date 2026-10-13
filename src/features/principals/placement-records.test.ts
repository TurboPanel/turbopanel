import { skipWithoutDatabase } from '../../test-fixtures/require-service.test.support.ts'
import { assertEquals } from '@std/assert'
import { eq } from 'drizzle-orm'
import { getDatabaseUrl } from '../../db/url.ts'
import { createDenoDb } from '../../db/connection.ts'
import {
  environment,
  login,
  managed,
  organization,
  principal,
  project,
  server,
  service,
  tenancy,
  workspace,
} from '../../db/schema.ts'
import {
  ensureProjectPlacements,
  listServerPlacements,
  loadPrincipalUsage,
  markPlacementsAbsent,
  markPlacementsPresent,
  markPlacementsRetiring,
  recordPendingPlacements,
  resolvePlacementInputs,
} from './placement-records.ts'

const dbUrl = getDatabaseUrl()

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

type Fixtures = {
  db: ReturnType<typeof createDenoDb>
  organizationId: string
  projectId: string
  environmentId: string
  serviceId: string
  serverIds: [string, string]
  /** A compose-declared principal with a tenancy on the service. */
  composePrincipalId: string
  /** A hand-made principal with no tenancy. */
  manualPrincipalId: string
}

async function withFixtures(fn: (ctx: Fixtures) => Promise<void>): Promise<void> {
  if (!dbUrl) {
    skipWithoutDatabase('placement record tests')
    return
  }
  const db = createDenoDb()
  const suffix = crypto.randomUUID().slice(0, 8)
  const [org] = await db
    .insert(organization)
    .values({ name: `Placement Test Org ${suffix}` })
    .returning({ id: organization.id })
  const organizationId = org!.id
  const [ws] = await db
    .insert(workspace)
    .values({ name: 'Placement Workspace', organizationId })
    .returning({ id: workspace.id })
  const [proj] = await db
    .insert(project)
    .values({ name: `Placement Project ${suffix}`, workspaceId: ws!.id, organizationId })
    .returning({ id: project.id })
  const projectId = proj!.id
  const servers = await db
    .insert(server)
    .values([
      { organizationId, name: `placement-a-${suffix}` },
      { organizationId, name: `placement-b-${suffix}` },
    ])
    .returning({ id: server.id })
  const serverIds: [string, string] = [servers[0]!.id, servers[1]!.id]
  const [env] = await db
    .insert(environment)
    .values({ name: 'Placement Env', projectId, serverId: serverIds[0] })
    .returning({ id: environment.id })
  const environmentId = env!.id
  const [svc] = await db
    .insert(service)
    .values({ environmentId, name: 'web', composeServiceName: 'web' })
    .returning({ id: service.id })
  const serviceId = svc!.id
  const principals = await db
    .insert(principal)
    .values([
      {
        organizationId,
        projectId,
        kind: 'system',
        provider: 'server',
        username: `pl_compose_${suffix}`,
        appliedUsername: `pl_compose_${suffix}`,
        metadata: { composeAlias: 'web', home: `/srv/users/pl_compose_${suffix}` },
      },
      {
        organizationId,
        projectId,
        kind: 'system',
        provider: 'server',
        username: `pl_manual_${suffix}`,
        appliedUsername: `pl_manual_${suffix}`,
        metadata: { home: `/srv/users/pl_manual_${suffix}` },
      },
    ])
    .returning({ id: principal.id })
  const composePrincipalId = principals[0]!.id
  const manualPrincipalId = principals[1]!.id
  await db.insert(tenancy).values({ principalId: composePrincipalId, serviceId })

  try {
    await fn({
      db,
      organizationId,
      projectId,
      environmentId,
      serviceId,
      serverIds,
      composePrincipalId,
      manualPrincipalId,
    })
  } finally {
    await db.delete(tenancy).where(eq(tenancy.serviceId, serviceId))
    await db.delete(principal).where(eq(principal.projectId, projectId))
    await db.delete(service).where(eq(service.id, serviceId))
    await db.delete(environment).where(eq(environment.id, environmentId))
    await db.delete(project).where(eq(project.id, projectId))
    await db.delete(server).where(eq(server.organizationId, organizationId))
    await db.delete(workspace).where(eq(workspace.id, ws!.id))
    await db.delete(organization).where(eq(organization.id, organizationId))
  }
}

test('resolvePlacementInputs derives the source from compose alias, tenancy and storage', async () => {
  await withFixtures(async ({ db, environmentId, composePrincipalId, manualPrincipalId }) => {
    const inputs = await resolvePlacementInputs(db, {
      environmentId,
      principals: [
        { principalId: composePrincipalId, home: '/srv/users/c' },
        { principalId: manualPrincipalId, home: '/srv/users/m' },
        { principalId: manualPrincipalId, home: '/srv/users/m' },
      ],
      storagePrincipalIds: [manualPrincipalId],
    })
    assertEquals(inputs, [
      { principalId: composePrincipalId, home: '/srv/users/c', source: 'compose' },
      { principalId: manualPrincipalId, home: '/srv/users/m', source: 'storage' },
    ])
  })
})

test('placements move pending -> present -> retiring -> absent and a present row survives a redeploy', async () => {
  await withFixtures(async ({ db, serverIds, composePrincipalId, manualPrincipalId }) => {
    const [serverId] = serverIds
    const inputs = [
      { principalId: composePrincipalId, home: '/srv/users/c', source: 'compose' as const },
      { principalId: manualPrincipalId, home: '/srv/users/m', source: 'manual' as const },
    ]
    await recordPendingPlacements(db, serverId, inputs)
    const states = async () =>
      Object.fromEntries(
        (await listServerPlacements(db, serverId)).map((row) => [row.principalId, row.state])
      )
    assertEquals(await states(), {
      [composePrincipalId]: 'pending',
      [manualPrincipalId]: 'pending',
    })

    await markPlacementsPresent(db, serverId, [composePrincipalId])
    assertEquals(await states(), {
      [composePrincipalId]: 'present',
      [manualPrincipalId]: 'pending',
    })

    // A redeploy re-records both: present stays present, pending stays pending.
    await recordPendingPlacements(db, serverId, inputs)
    assertEquals(await states(), {
      [composePrincipalId]: 'present',
      [manualPrincipalId]: 'pending',
    })

    const [composeRow] = await db
      .select({ appliedUsername: principal.appliedUsername })
      .from(principal)
      .where(eq(principal.id, composePrincipalId))
    const username = composeRow!.appliedUsername
    await markPlacementsRetiring(db, serverId, [username])
    assertEquals((await states())[composePrincipalId], 'retiring')
    await markPlacementsAbsent(db, serverId, [username])
    assertEquals((await states())[composePrincipalId], 'absent')

    // A later deploy that brings the account back starts it over at pending,
    // and a late stop result cannot pull it back to absent.
    await recordPendingPlacements(db, serverId, inputs)
    assertEquals((await states())[composePrincipalId], 'pending')
    await markPlacementsAbsent(db, serverId, [username])
    assertEquals((await states())[composePrincipalId], 'pending')

    const listed = await listServerPlacements(db, serverId)
    assertEquals(listed.length, 2)
    assertEquals(listed[0]!.uid, null)
  })
})

test('loadPrincipalUsage counts tenancies and placements on other servers only', async () => {
  await withFixtures(async ({ db, serverIds, composePrincipalId, manualPrincipalId }) => {
    const [serverA, serverB] = serverIds
    await recordPendingPlacements(db, serverA, [
      { principalId: composePrincipalId, home: '/srv/users/c', source: 'compose' },
      { principalId: manualPrincipalId, home: '/srv/users/m', source: 'manual' },
    ])
    await recordPendingPlacements(db, serverB, [
      { principalId: manualPrincipalId, home: '/srv/users/m', source: 'manual' },
    ])

    const usage = await loadPrincipalUsage(db, [composePrincipalId, manualPrincipalId], serverA)
    assertEquals(usage.get(composePrincipalId), {
      tenancies: 1,
      bindings: 0,
      storages: 0,
      secrets: 0,
      logins: 0,
      otherPlacements: 0,
    })
    assertEquals(usage.get(manualPrincipalId), {
      tenancies: 0,
      bindings: 0,
      storages: 0,
      secrets: 0,
      logins: 0,
      otherPlacements: 1,
    })

    // An absent placement elsewhere no longer counts as a user.
    const [manualRow] = await db
      .select({ appliedUsername: principal.appliedUsername })
      .from(principal)
      .where(eq(principal.id, manualPrincipalId))
    await markPlacementsRetiring(db, serverB, [manualRow!.appliedUsername])
    await markPlacementsAbsent(db, serverB, [manualRow!.appliedUsername])
    const after = await loadPrincipalUsage(db, [manualPrincipalId], serverA)
    assertEquals(after.get(manualPrincipalId)?.otherPlacements, 0)
  })
})

test("loadPrincipalUsage counts the principal's database logins", async () => {
  await withFixtures(async ({ db, environmentId, serverIds, composePrincipalId }) => {
    const [cluster] = await db
      .insert(managed)
      .values({
        environmentId,
        serverId: serverIds[1],
        name: 'Placement Usage DB',
        engine: 'postgres',
        status: 'ready',
      })
      .returning({ id: managed.id })
    try {
      await db.insert(login).values({
        managedId: cluster!.id,
        principalId: composePrincipalId,
        role: 'user',
        appliedUsername: 'pl_login_user',
      })
      const usage = await loadPrincipalUsage(db, [composePrincipalId], serverIds[0])
      assertEquals(usage.get(composePrincipalId)?.logins, 1)
    } finally {
      await db.delete(managed).where(eq(managed.id, cluster!.id))
    }
  })
})

test("ensureProjectPlacements records every system principal on the project's servers, once", async () => {
  await withFixtures(
    async ({ db, projectId, serverIds, composePrincipalId, manualPrincipalId }) => {
      const [serverA] = serverIds
      // One row already present stays as it is.
      await recordPendingPlacements(db, serverA, [
        { principalId: composePrincipalId, home: '/srv/users/kept', source: 'compose' },
      ])
      await ensureProjectPlacements(db, projectId)
      await ensureProjectPlacements(db, projectId)
      const rows = await listServerPlacements(db, serverA)
      assertEquals(
        rows
          .map((row) => [
            row.principalId,
            row.state,
            row.source,
            row.home.startsWith('/srv/users/'),
          ])
          .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
        [
          [composePrincipalId, 'pending', 'compose', true],
          [manualPrincipalId, 'present', 'manual', true],
        ].sort((a, b) => String(a[0]).localeCompare(String(b[0])))
      )
      // The environment is pinned to server A only, so nothing lands on B.
      assertEquals((await listServerPlacements(db, serverIds[1])).length, 0)
    }
  )
})
