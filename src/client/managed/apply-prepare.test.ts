import { assertEquals } from '@std/assert'
import { and, eq, inArray, ne } from 'drizzle-orm'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '../../app.ts'
import { getDatabaseUrl } from '../../db-url.ts'
import { createDenoDb } from '../../db.ts'
import {
  deriveEncryptionSecretsConfig,
  parseSecretsEnv,
} from '../authn/secrets.ts'
import { attachDaemonStateToServer } from '../../daemon/authn/server-identity-db.ts'
import {
  container,
  environment,
  managed,
  organization,
  principal,
  project,
  server,
  service,
  tls,
  workspace,
} from '../../lib/db/schema.ts'
import { postgresEngineSpec } from '../../lib/managed/postgres.ts'
import type { ManagedSettings } from '../../lib/managed/settings.ts'
import { createManagedPrincipal } from '../principals/store.ts'
import { TEST_ONLY_TURBOPANEL_SECRET } from '../../test-fixtures/secrets.ts'
import { ensureManagedContainerAllocation } from './allocate-managed-container.ts'
import {
  isPrepareError,
  prepareManagedApplyPayloads,
} from './apply-prepare.ts'

const dbUrl = getDatabaseUrl()

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

async function withManagedAllocationFixtures(
  fn: (ctx: {
    db: ReturnType<typeof createDenoDb>
    serverId: string
    otherServerId: string
    environmentId: string
  }) => Promise<void>,
): Promise<void> {
  if (!dbUrl) {
    console.warn('Skipping apply-prepare allocation tests: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()

  const [insertedOrg] = await db
    .insert(organization)
    .values({ name: 'Managed Allocate Org' })
    .returning({ id: organization.id })
  const organizationId = insertedOrg!.id

  const [insertedWorkspace] = await db
    .insert(workspace)
    .values({ name: 'Managed Allocate Workspace', organizationId })
    .returning({ id: workspace.id })
  const workspaceId = insertedWorkspace!.id

  const now = new Date().toISOString()
  const [insertedServer] = await db
    .insert(server)
    .values({
      organizationId,
      name: 'Managed Allocate Server',
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: server.id })
  const serverId = insertedServer!.id

  const [insertedOtherServer] = await db
    .insert(server)
    .values({
      organizationId,
      name: 'Managed Allocate Other Server',
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: server.id })
  const otherServerId = insertedOtherServer!.id

  const [insertedProject] = await db
    .insert(project)
    .values({
      name: 'Managed Allocate Project',
      workspaceId,
    })
    .returning({ id: project.id })
  const projectId = insertedProject!.id

  const [insertedEnvironment] = await db
    .insert(environment)
    .values({
      name: 'Managed Allocate Env',
      projectId,
    })
    .returning({ id: environment.id })
  const environmentId = insertedEnvironment!.id

  try {
    await fn({ db, serverId, otherServerId, environmentId })
  } finally {
    await db.delete(container).where(eq(container.serverId, serverId))
    await db.delete(container).where(eq(container.serverId, otherServerId))
    await db.delete(service).where(eq(service.environmentId, environmentId))
    await db.delete(environment).where(eq(environment.id, environmentId))
    await db.delete(project).where(eq(project.id, projectId))
    await db.delete(server).where(eq(server.id, serverId))
    await db.delete(server).where(eq(server.id, otherServerId))
    await db.delete(workspace).where(eq(workspace.id, workspaceId))
    await db.delete(organization).where(eq(organization.id, organizationId))
  }
}

async function withManagedApplyPrepareFixtures(
  fn: (ctx: {
    db: ReturnType<typeof createDenoDb>
    c: Context<AppEnv>
    serverId: string
    environmentId: string
    managedId: string
    organizationId: string
  }) => Promise<void>,
): Promise<void> {
  if (!dbUrl) {
    console.warn('Skipping apply-prepare payload tests: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const secretsConfig = parseSecretsEnv(TEST_ONLY_TURBOPANEL_SECRET, undefined, 'deno')
  const dataEncryptionSecrets = await deriveEncryptionSecretsConfig(
    secretsConfig,
    'data-encryption',
  )
  const db = createDenoDb()

  const [insertedOrg] = await db
    .insert(organization)
    .values({ name: 'Managed Apply Prepare Org' })
    .returning({ id: organization.id })
  const organizationId = insertedOrg!.id

  const [insertedWorkspace] = await db
    .insert(workspace)
    .values({ name: 'Managed Apply Prepare Workspace', organizationId })
    .returning({ id: workspace.id })
  const workspaceId = insertedWorkspace!.id

  const now = new Date().toISOString()
  const [insertedServer] = await db
    .insert(server)
    .values({
      organizationId,
      name: 'Managed Apply Prepare Server',
      createdAt: now,
      updatedAt: now,
      isConnected: true,
      statusChangedAt: now,
    })
    .returning({ id: server.id })
  const serverId = insertedServer!.id

  await attachDaemonStateToServer(db, serverId, {
    publicJwk: { kty: 'OKP', crv: 'Ed25519', x: 'managed-apply-prepare-key' },
    fingerprint: `managed-apply-prepare-fp-${serverId}`,
  })

  const [insertedProject] = await db
    .insert(project)
    .values({
      name: 'Managed Apply Prepare Project',
      workspaceId,
      metadata: { type: 'managed', code: 'postgres' },
    })
    .returning({ id: project.id })
  const projectId = insertedProject!.id

  const [insertedEnvironment] = await db
    .insert(environment)
    .values({
      name: 'Production',
      projectId,
      serverId,
    })
    .returning({ id: environment.id })
  const environmentId = insertedEnvironment!.id

  const [insertedManaged] = await db
    .insert(managed)
    .values({
      environmentId,
      serverId,
      name: 'Postgres',
      engine: 'postgres',
      status: 'ready',
      options: { settings: postgresEngineSpec.defaultSettings, databases: ['postgres'] },
    })
    .returning({ id: managed.id })
  const managedId = insertedManaged!.id

  await createManagedPrincipal(db, dataEncryptionSecrets, {
    managedId,
    provider: 'postgres',
    username: 'postgres',
    metadata: { managedRoot: true, databases: ['postgres'] },
  })

  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    c.set('secretsConfig', secretsConfig)
    c.set('dataEncryptionSecrets', dataEncryptionSecrets)
    return next()
  })

  let captured: Context<AppEnv> | null = null
  app.get('/capture', (c) => {
    captured = c
    return c.json({ ok: true })
  })
  await app.request('/capture')
  if (!captured) throw new TypeError('failed to capture Hono context')

  try {
    await fn({
      db,
      c: captured,
      serverId,
      environmentId,
      managedId,
      organizationId,
    })
  } finally {
    // `attachManagedOrgTlsMaterial` self-heals a system (managed-ingress)
    // workspace/project/environment/service scoped to `serverId` as a side
    // effect of preparing the apply payload — sweep every workspace under
    // this test-owned organization (not just the tracked consumer ids) so
    // that hierarchy never leaks and blocks the `server` delete below via
    // the `environment.server_id` RESTRICT foreign key.
    await db.delete(principal).where(eq(principal.managedId, managedId))
    await db.delete(container).where(eq(container.serverId, serverId))

    const workspaceIds = (
      await db
        .select({ id: workspace.id })
        .from(workspace)
        .where(eq(workspace.organizationId, organizationId))
    ).map((row) => row.id)
    if (workspaceIds.length > 0) {
      const projectIds = (
        await db
          .select({ id: project.id })
          .from(project)
          .where(inArray(project.workspaceId, workspaceIds))
      ).map((row) => row.id)
      if (projectIds.length > 0) {
        const environmentIds = (
          await db
            .select({ id: environment.id })
            .from(environment)
            .where(inArray(environment.projectId, projectIds))
        ).map((row) => row.id)
        if (environmentIds.length > 0) {
          await db.delete(service).where(inArray(service.environmentId, environmentIds))
          await db.delete(managed).where(inArray(managed.environmentId, environmentIds))
          await db.delete(environment).where(inArray(environment.id, environmentIds))
        }
        await db.delete(project).where(inArray(project.id, projectIds))
      }
    }
    await db.delete(server).where(eq(server.id, serverId))
    if (workspaceIds.length > 0) {
      await db.delete(workspace).where(inArray(workspace.id, workspaceIds))
    }
    await db.delete(tls).where(eq(tls.organizationId, organizationId))
    await db.delete(organization).where(eq(organization.id, organizationId))
  }
}

function settingsWithExposure(enabled: boolean): ManagedSettings {
  const parsed = postgresEngineSpec.parseSettings({
    ...(enabled
      ? { exposure: { enabled: true, scope: 'local' } }
      : { exposure: { enabled: false } }),
  })
  if (!parsed) throw new TypeError('expected valid managed settings')
  return parsed
}

test('ensureManagedContainerAllocation creates service + ordinal-1 container named <service.id>-1', async () => {
  await withManagedAllocationFixtures(async ({ db, serverId, environmentId }) => {
    const allocation = await ensureManagedContainerAllocation(db, {
      environmentId,
      serverId,
      composeServiceName: 'postgres',
      ordinal: 1,
    })

    assertEquals(allocation.containerName, `${allocation.serviceId}-1`)

    const services = await db
      .select({
        id: service.id,
        composeServiceName: service.composeServiceName,
        displayName: service.name,
      })
      .from(service)
      .where(eq(service.environmentId, environmentId))
    assertEquals(services.length, 1)
    assertEquals(services[0]!.id, allocation.serviceId)
    assertEquals(services[0]!.composeServiceName, 'postgres')
    assertEquals(services[0]!.displayName, 'postgres')

    const rows = await db
      .select({
        id: container.id,
        containerName: container.containerName,
        status: container.status,
        ordinal: container.ordinal,
        containerId: container.containerId,
      })
      .from(container)
      .where(
        and(
          eq(container.serviceId, allocation.serviceId),
          eq(container.serverId, serverId),
        ),
      )
    assertEquals(rows.length, 1)
    assertEquals(rows[0]!.id, allocation.containerRowId)
    assertEquals(rows[0]!.containerName, `${allocation.serviceId}-1`)
    assertEquals(rows[0]!.status, 'pending')
    assertEquals(rows[0]!.ordinal, 1)
    assertEquals(rows[0]!.containerId, null)
  })
})

test('ensureManagedContainerAllocation is idempotent on re-apply', async () => {
  await withManagedAllocationFixtures(async ({ db, serverId, environmentId }) => {
    const first = await ensureManagedContainerAllocation(db, {
      environmentId,
      serverId,
      composeServiceName: 'postgres',
      ordinal: 1,
    })
    const second = await ensureManagedContainerAllocation(db, {
      environmentId,
      serverId,
      composeServiceName: 'postgres',
      ordinal: 1,
    })

    assertEquals(second.serviceId, first.serviceId)
    assertEquals(second.containerRowId, first.containerRowId)
    assertEquals(second.containerName, first.containerName)

    const rows = await db
      .select({ id: container.id })
      .from(container)
      .where(eq(container.serviceId, first.serviceId))
    assertEquals(rows.length, 1)
  })
})

test('ensureManagedContainerAllocation prunes stray pending rows on another server', async () => {
  await withManagedAllocationFixtures(async ({
    db,
    serverId,
    otherServerId,
    environmentId,
  }) => {
    const first = await ensureManagedContainerAllocation(db, {
      environmentId,
      serverId: otherServerId,
      composeServiceName: 'postgres',
      ordinal: 1,
    })

    const rePin = await ensureManagedContainerAllocation(db, {
      environmentId,
      serverId,
      composeServiceName: 'postgres',
      ordinal: 1,
    })

    assertEquals(rePin.serviceId, first.serviceId)
    assertEquals(rePin.containerRowId, first.containerRowId)
    assertEquals(rePin.containerName, first.containerName)
    assertEquals(rePin.containerName, `${rePin.serviceId}-1`)

    const rows = await db
      .select({
        id: container.id,
        serverId: container.serverId,
        status: container.status,
      })
      .from(container)
      .where(eq(container.serviceId, first.serviceId))

    assertEquals(rows.length, 1)
    assertEquals(rows[0]!.id, first.containerRowId)
    assertEquals(rows[0]!.serverId, serverId)
    assertEquals(rows[0]!.status, 'pending')
  })
})

test('ensureManagedContainerAllocation restores exited null-id ordinal-1 row to pending', async () => {
  await withManagedAllocationFixtures(async ({ db, serverId, environmentId }) => {
    const first = await ensureManagedContainerAllocation(db, {
      environmentId,
      serverId,
      composeServiceName: 'postgres',
      ordinal: 1,
    })

    await db
      .update(container)
      .set({ status: 'exited', containerId: null })
      .where(eq(container.id, first.containerRowId))

    const second = await ensureManagedContainerAllocation(db, {
      environmentId,
      serverId,
      composeServiceName: 'postgres',
      ordinal: 1,
    })

    assertEquals(second.containerRowId, first.containerRowId)
    assertEquals(second.containerName, first.containerName)
    assertEquals(second.serviceId, first.serviceId)

    const [row] = await db
      .select({
        id: container.id,
        status: container.status,
        containerId: container.containerId,
        containerName: container.containerName,
        composeServiceName: container.composeServiceName,
      })
      .from(container)
      .where(eq(container.id, first.containerRowId))
      .limit(1)

    assertEquals(row!.id, first.containerRowId)
    assertEquals(row!.status, 'pending')
    assertEquals(row!.containerId, null)
    assertEquals(row!.containerName, `${first.serviceId}-1`)
    assertEquals(row!.composeServiceName, 'postgres')
  })
})

test('prepareManagedApplyPayloads self-heals primary member and omits ingress', async () => {
  await withManagedApplyPrepareFixtures(async ({
    db,
    c,
    serverId,
    environmentId,
    managedId,
    organizationId,
  }) => {
    const prepared = await prepareManagedApplyPayloads(c, db, {
      managedRow: { id: managedId, engine: 'postgres' },
      spec: postgresEngineSpec,
      settings: settingsWithExposure(true),
      databases: ['postgres'],
      serverId,
      environmentId,
      organizationId,
    })
    if (isPrepareError(prepared)) {
      throw new TypeError(`unexpected prepare error: ${prepared.kind}`)
    }

    assertEquals(prepared.members.length, 1)
    assertEquals(prepared.members[0]!.serverId, serverId)
    const payload = prepared.members[0]!.payload
    assertEquals(payload.memberRole, 'primary')
    assertEquals(payload.memberOrdinal, 1)
    assertEquals(payload.exposure.enabled, true)
    assertEquals('ingress' in payload, false)
    assertEquals(payload.peers, [])

    const services = await db
      .select({
        id: service.id,
        composeServiceName: service.composeServiceName,
        options: service.options,
      })
      .from(service)
      .where(eq(service.environmentId, environmentId))
    assertEquals(services.length, 1)
    assertEquals(services[0]?.composeServiceName, 'postgres')
    const serviceId = services[0]!.id
    assertEquals(payload.containerName, `${serviceId}-1`)
    assertEquals(
      (services[0]!.options as { instances?: number } | null)?.instances,
      1,
    )

    const containers = await db
      .select({
        role: container.role,
        ordinal: container.ordinal,
        containerName: container.containerName,
      })
      .from(container)
      .where(eq(container.serviceId, serviceId))
    assertEquals(containers.length, 1)
    assertEquals(containers[0]!.role, 'service')
    assertEquals(containers[0]!.ordinal, 1)
    assertEquals(containers[0]!.containerName, `${serviceId}-1`)
  })
})

test('prepareManagedApplyPayloads ensures org CA and sets orgTlsMaterial with denc leaf key', async () => {
  await withManagedApplyPrepareFixtures(async ({
    db,
    c,
    serverId,
    environmentId,
    managedId,
    organizationId,
  }) => {
    const prepared = await prepareManagedApplyPayloads(c, db, {
      managedRow: { id: managedId, engine: 'postgres' },
      spec: postgresEngineSpec,
      settings: settingsWithExposure(false),
      databases: ['postgres'],
      serverId,
      environmentId,
      organizationId,
    })
    if (isPrepareError(prepared)) {
      throw new TypeError(`unexpected prepare error: ${prepared.kind}`)
    }

    const payload = prepared.members[0]!.payload
    assertEquals(payload.orgTlsMaterial !== undefined, true)
    assertEquals(
      payload.orgTlsMaterial!.certificatePem.includes('BEGIN CERTIFICATE'),
      true,
    )
    assertEquals(
      payload.orgTlsMaterial!.caCertPem.includes('BEGIN CERTIFICATE'),
      true,
    )
    assertEquals(
      payload.orgTlsMaterial!.privateKeyEnvelope.startsWith('tpdaemon.'),
      true,
    )

    const cas = await db
      .select({ id: tls.id, source: tls.source, status: tls.status })
      .from(tls)
      .where(
        and(
          eq(tls.organizationId, organizationId),
          eq(tls.source, 'organization_ca'),
          ne(tls.status, 'revoked'),
        ),
      )
    assertEquals(cas.length, 1)

    // Re-apply reuses the same active CA (no second row).
    const again = await prepareManagedApplyPayloads(c, db, {
      managedRow: { id: managedId, engine: 'postgres' },
      spec: postgresEngineSpec,
      settings: settingsWithExposure(false),
      databases: ['postgres'],
      serverId,
      environmentId,
      organizationId,
    })
    if (isPrepareError(again)) {
      throw new TypeError(`unexpected prepare error: ${again.kind}`)
    }
    assertEquals(
      again.members[0]!.payload.orgTlsMaterial?.caCertPem,
      payload.orgTlsMaterial?.caCertPem,
    )

    const casAfter = await db
      .select({ id: tls.id })
      .from(tls)
      .where(
        and(
          eq(tls.organizationId, organizationId),
          eq(tls.source, 'organization_ca'),
          ne(tls.status, 'revoked'),
        ),
      )
    assertEquals(casAfter.length, 1)
  })
})
