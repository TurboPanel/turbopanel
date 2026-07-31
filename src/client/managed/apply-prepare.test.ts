import { assertEquals } from 'jsr:@std/assert'
import { and, eq, isNull } from 'drizzle-orm'
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
  workspace,
} from '../../lib/db/schema.ts'
import { postgresEngineSpec } from '../../lib/managed/postgres.ts'
import type { ManagedSettings } from '../../lib/managed/settings.ts'
import { managedIngressComposeServiceName } from '../../lib/naming.ts'
import { createManagedPrincipal } from '../principals/store.ts'
import { TEST_ONLY_TURBOPANEL_SECRET } from '../../test-fixtures/secrets.ts'
import { ensureManagedContainerAllocation } from './allocate-managed-container.ts'
import {
  buildManagedApplyPayload,
  isPrepareError,
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
    .values({ displayName: 'Managed Allocate Org' })
    .returning({ id: organization.id })
  const organizationId = insertedOrg!.id

  const [insertedWorkspace] = await db
    .insert(workspace)
    .values({ displayName: 'Managed Allocate Workspace', organizationId })
    .returning({ id: workspace.id })
  const workspaceId = insertedWorkspace!.id

  const now = new Date().toISOString()
  const [insertedServer] = await db
    .insert(server)
    .values({
      organizationId,
      displayName: 'Managed Allocate Server',
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: server.id })
  const serverId = insertedServer!.id

  const [insertedOtherServer] = await db
    .insert(server)
    .values({
      organizationId,
      displayName: 'Managed Allocate Other Server',
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: server.id })
  const otherServerId = insertedOtherServer!.id

  const [insertedProject] = await db
    .insert(project)
    .values({
      displayName: 'Managed Allocate Project',
      workspaceId,
    })
    .returning({ id: project.id })
  const projectId = insertedProject!.id

  const [insertedEnvironment] = await db
    .insert(environment)
    .values({
      displayName: 'Managed Allocate Env',
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
    .values({ displayName: 'Managed Apply Prepare Org' })
    .returning({ id: organization.id })
  const organizationId = insertedOrg!.id

  const [insertedWorkspace] = await db
    .insert(workspace)
    .values({ displayName: 'Managed Apply Prepare Workspace', organizationId })
    .returning({ id: workspace.id })
  const workspaceId = insertedWorkspace!.id

  const now = new Date().toISOString()
  const [insertedServer] = await db
    .insert(server)
    .values({
      organizationId,
      displayName: 'Managed Apply Prepare Server',
      createdAt: now,
      updatedAt: now,
      connected: true,
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
      displayName: 'Managed Apply Prepare Project',
      workspaceId,
      metadata: { type: 'managed', code: 'postgres' },
    })
    .returning({ id: project.id })
  const projectId = insertedProject!.id

  const [insertedEnvironment] = await db
    .insert(environment)
    .values({
      displayName: 'Production',
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
      displayName: 'Postgres',
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
    await fn({ db, c: captured, serverId, environmentId, managedId })
  } finally {
    await db.delete(principal).where(eq(principal.managedId, managedId))
    await db.delete(container).where(eq(container.serverId, serverId))
    await db.delete(service).where(eq(service.environmentId, environmentId))
    await db.delete(managed).where(eq(managed.id, managedId))
    await db.delete(environment).where(eq(environment.id, environmentId))
    await db.delete(project).where(eq(project.id, projectId))
    await db.delete(server).where(eq(server.id, serverId))
    await db.delete(workspace).where(eq(workspace.id, workspaceId))
    await db.delete(organization).where(eq(organization.id, organizationId))
  }
}

function settingsWithExposure(enabled: boolean): ManagedSettings {
  const parsed = postgresEngineSpec.parseSettings({
    ...(enabled
      ? { exposure: { enabled: true, publishedPort: 15432, bind: 'local' } }
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
    })

    assertEquals(allocation.containerName, `${allocation.serviceId}-1`)

    const services = await db
      .select({
        id: service.id,
        composeServiceName: service.composeServiceName,
        displayName: service.displayName,
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
    })
    const second = await ensureManagedContainerAllocation(db, {
      environmentId,
      serverId,
      composeServiceName: 'postgres',
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
    })

    const rePin = await ensureManagedContainerAllocation(db, {
      environmentId,
      serverId,
      composeServiceName: 'postgres',
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
    })

    await db
      .update(container)
      .set({ status: 'exited', containerId: null })
      .where(eq(container.id, first.containerRowId))

    const second = await ensureManagedContainerAllocation(db, {
      environmentId,
      serverId,
      composeServiceName: 'postgres',
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

test('buildManagedApplyPayload with exposure enabled allocates distinct engine and ingress', async () => {
  await withManagedApplyPrepareFixtures(async ({
    db,
    c,
    serverId,
    environmentId,
    managedId,
  }) => {
    const payload = await buildManagedApplyPayload(c, db, {
      managedRow: { id: managedId, engine: 'postgres' },
      spec: postgresEngineSpec,
      settings: settingsWithExposure(true),
      databases: ['postgres'],
      serverId,
      environmentId,
    })
    if (isPrepareError(payload)) {
      throw new TypeError(`unexpected prepare error: ${payload.kind}`)
    }

    assertEquals(payload.exposure.enabled, true)
    assertEquals(payload.ingress !== undefined, true)
    assertEquals(payload.ingress?.composeServiceName, 'postgres-ingress')
    assertEquals(
      payload.ingress?.composeServiceName,
      managedIngressComposeServiceName('postgres'),
    )
    assertEquals(payload.ingress?.containerName, `${payload.ingress!.serviceId}-1`)

    const services = await db
      .select({
        id: service.id,
        composeServiceName: service.composeServiceName,
      })
      .from(service)
      .where(eq(service.environmentId, environmentId))
    const names = services
      .map((row) => row.composeServiceName)
      .sort((a, b) => a.localeCompare(b))
    assertEquals(names, ['postgres', 'postgres-ingress'])

    const engineService = services.find((row) => row.composeServiceName === 'postgres')
    const ingressService = services.find(
      (row) => row.composeServiceName === 'postgres-ingress',
    )
    if (!engineService || !ingressService) {
      throw new TypeError('expected engine and ingress service rows')
    }
    assertEquals(engineService.id === ingressService.id, false)
    assertEquals(payload.ingress?.serviceId, ingressService.id)
    assertEquals(payload.containerName, `${engineService.id}-1`)
    assertEquals(payload.ingress?.containerName, `${ingressService.id}-1`)
  })
})

test('buildManagedApplyPayload with exposure disabled prunes pending ingress containers', async () => {
  await withManagedApplyPrepareFixtures(async ({
    db,
    c,
    serverId,
    environmentId,
    managedId,
  }) => {
    const enabled = await buildManagedApplyPayload(c, db, {
      managedRow: { id: managedId, engine: 'postgres' },
      spec: postgresEngineSpec,
      settings: settingsWithExposure(true),
      databases: ['postgres'],
      serverId,
      environmentId,
    })
    if (isPrepareError(enabled)) {
      throw new TypeError(`unexpected prepare error: ${enabled.kind}`)
    }
    const ingressServiceId = enabled.ingress!.serviceId
    const ingressName = enabled.ingress!.composeServiceName

    const pendingBefore = await db
      .select({ id: container.id })
      .from(container)
      .where(
        and(
          eq(container.serviceId, ingressServiceId),
          isNull(container.containerId),
          eq(container.status, 'pending'),
        ),
      )
    assertEquals(pendingBefore.length, 1)

    const disabled = await buildManagedApplyPayload(c, db, {
      managedRow: { id: managedId, engine: 'postgres' },
      spec: postgresEngineSpec,
      settings: settingsWithExposure(false),
      databases: ['postgres'],
      serverId,
      environmentId,
    })
    if (isPrepareError(disabled)) {
      throw new TypeError(`unexpected prepare error: ${disabled.kind}`)
    }

    assertEquals(disabled.exposure.enabled, false)
    assertEquals(disabled.ingress, undefined)

    const pendingAfter = await db
      .select({ id: container.id })
      .from(container)
      .where(
        and(
          eq(container.serviceId, ingressServiceId),
          isNull(container.containerId),
          eq(container.status, 'pending'),
        ),
      )
    assertEquals(pendingAfter.length, 0)

    const [serviceRow] = await db
      .select({ id: service.id, composeServiceName: service.composeServiceName })
      .from(service)
      .where(
        and(
          eq(service.environmentId, environmentId),
          eq(service.composeServiceName, ingressName),
        ),
      )
      .limit(1)
    assertEquals(serviceRow?.id, ingressServiceId)
    assertEquals(serviceRow?.composeServiceName, 'postgres-ingress')
  })
})
