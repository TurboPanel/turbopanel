import { assertEquals, assertNotEquals } from 'jsr:@std/assert'
import { and, eq } from 'drizzle-orm'
import { getDatabaseUrl } from '../../db-url.ts'
import { createDenoDb } from '../../db.ts'
import { emptyComposeDocument } from '../../lib/compose/types.ts'
import type { ComposeDocument } from '../../lib/compose/types.ts'
import {
  environment,
  organization,
  project,
  server,
  storage,
  workspace,
} from '../../lib/db/schema.ts'
import { registerComposeVolumes } from './register-compose-volumes.ts'

const dbUrl = getDatabaseUrl()

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

function composeWithVolume(key: string): ComposeDocument {
  return {
    ...emptyComposeDocument(),
    data: {
      services: {
        web: { image: 'nginx' },
      },
      volumes: {
        [key]: null,
      },
    },
  }
}

async function withVolumeFixtures(
  fn: (ctx: {
    db: ReturnType<typeof createDenoDb>
    organizationId: string
    environmentId: string
    serverId: string
  }) => Promise<void>,
): Promise<void> {
  if (!dbUrl) {
    console.warn('Skipping register-compose-volumes tests: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()

  const [insertedOrg] = await db
    .insert(organization)
    .values({ name: 'Compose Volumes Org' })
    .returning({ id: organization.id })
  const organizationId = insertedOrg!.id

  const [insertedWorkspace] = await db
    .insert(workspace)
    .values({ name: 'Compose Volumes Workspace', organizationId })
    .returning({ id: workspace.id })
  const workspaceId = insertedWorkspace!.id

  const now = new Date().toISOString()
  const [insertedServer] = await db
    .insert(server)
    .values({
      organizationId,
      name: 'Compose Volumes Server',
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: server.id })
  const serverId = insertedServer!.id

  const [insertedProject] = await db
    .insert(project)
    .values({
      name: 'Compose Volumes Project',
      workspaceId,
    })
    .returning({ id: project.id })
  const projectId = insertedProject!.id

  const [insertedEnvironment] = await db
    .insert(environment)
    .values({
      name: 'Compose Volumes Env',
      projectId,
    })
    .returning({ id: environment.id })
  const environmentId = insertedEnvironment!.id

  try {
    await fn({ db, organizationId, environmentId, serverId })
  } finally {
    await db.delete(storage).where(eq(storage.environmentId, environmentId))
    await db.delete(environment).where(eq(environment.id, environmentId))
    await db.delete(project).where(eq(project.id, projectId))
    await db.delete(server).where(eq(server.id, serverId))
    await db.delete(workspace).where(eq(workspace.id, workspaceId))
    await db.delete(organization).where(eq(organization.id, organizationId))
  }
}

test('registerComposeVolumes creates a new row when no composeVolumeKey match exists', async () => {
  await withVolumeFixtures(async ({
    db,
    organizationId,
    environmentId,
    serverId,
  }) => {
    const [legacy] = await db
      .insert(storage)
      .values({
        organizationId,
        environmentId,
        serverId,
        kind: 'docker_volume',
        name: 'data',
        metadata: { dockerVolumeName: 'legacy-pinned-volume' },
      })
      .returning({ id: storage.id })

    const registered = await registerComposeVolumes(db, {
      document: composeWithVolume('data'),
      organizationId,
      environmentId,
      serverId,
    })

    assertEquals(registered.length, 1)
    assertNotEquals(registered[0]!.storageId, legacy!.id)
    assertEquals(registered[0]!.composeKey, 'data')
    assertEquals(registered[0]!.volumeName, registered[0]!.storageId)

    const rows = await db
      .select({
        id: storage.id,
        metadata: storage.metadata,
      })
      .from(storage)
      .where(
        and(
          eq(storage.environmentId, environmentId),
          eq(storage.kind, 'docker_volume'),
        ),
      )

    assertEquals(rows.length, 2)
    const tagged = rows.find((row) => row.id === registered[0]!.storageId)
    assertEquals((tagged!.metadata as Record<string, unknown>).composeVolumeKey, 'data')
  })
})

test('registerComposeVolumes is idempotent for already-tagged rows', async () => {
  await withVolumeFixtures(async ({
    db,
    organizationId,
    environmentId,
    serverId,
  }) => {
    const first = await registerComposeVolumes(db, {
      document: composeWithVolume('cache'),
      organizationId,
      environmentId,
      serverId,
    })
    const second = await registerComposeVolumes(db, {
      document: composeWithVolume('cache'),
      organizationId,
      environmentId,
      serverId,
    })

    assertEquals(first.length, 1)
    assertEquals(second.length, 1)
    assertEquals(first[0]!.storageId, second[0]!.storageId)
    assertEquals(first[0]!.volumeName, second[0]!.volumeName)

    const rows = await db
      .select({ id: storage.id })
      .from(storage)
      .where(eq(storage.environmentId, environmentId))
    assertEquals(rows.length, 1)
  })
})

test('registerComposeVolumes returns empty when compose has no volumes', async () => {
  await withVolumeFixtures(async ({
    db,
    organizationId,
    environmentId,
    serverId,
  }) => {
    const registered = await registerComposeVolumes(db, {
      document: emptyComposeDocument(),
      organizationId,
      environmentId,
      serverId,
    })
    assertEquals(registered, [])

    const rows = await db
      .select({ id: storage.id })
      .from(storage)
      .where(eq(storage.environmentId, environmentId))
    assertEquals(rows.length, 0)
  })
})

test('registerComposeVolumes skips external and explicit-name volumes', async () => {
  await withVolumeFixtures(async ({
    db,
    organizationId,
    environmentId,
    serverId,
  }) => {
    const document: ComposeDocument = {
      ...emptyComposeDocument(),
      data: {
        services: { web: { image: 'nginx' } },
        volumes: {
          internal: null,
          external: { external: true },
          named: { name: 'operator-pinned' },
        },
      },
    }

    const registered = await registerComposeVolumes(db, {
      document,
      organizationId,
      environmentId,
      serverId,
    })

    assertEquals(registered.length, 1)
    assertEquals(registered[0]!.composeKey, 'internal')

    const rows = await db
      .select({ name: storage.name })
      .from(storage)
      .where(eq(storage.environmentId, environmentId))
    assertEquals(rows.map((row) => row.name), ['internal'])
  })
})

test('registerComposeVolumes reuses an existing composeVolumeKey row', async () => {
  await withVolumeFixtures(async ({
    db,
    organizationId,
    environmentId,
    serverId,
  }) => {
    const [existing] = await db
      .insert(storage)
      .values({
        organizationId,
        environmentId,
        serverId,
        kind: 'docker_volume',
        name: 'data',
        metadata: {
          composeVolumeKey: 'data',
          dockerVolumeName: 'pinned-data-vol',
        },
      })
      .returning({ id: storage.id })

    const registered = await registerComposeVolumes(db, {
      document: composeWithVolume('data'),
      organizationId,
      environmentId,
      serverId,
    })

    assertEquals(registered.length, 1)
    assertEquals(registered[0]!.storageId, existing!.id)
    assertEquals(registered[0]!.volumeName, 'pinned-data-vol')

    const rows = await db
      .select({ id: storage.id })
      .from(storage)
      .where(eq(storage.environmentId, environmentId))
    assertEquals(rows.length, 1)
  })
})

test('registerComposeVolumes concurrent callers share one storage row', async () => {
  await withVolumeFixtures(async ({
    db,
    organizationId,
    environmentId,
    serverId,
  }) => {
    const document = composeWithVolume('shared')
    const [first, second] = await Promise.all([
      registerComposeVolumes(db, {
        document,
        organizationId,
        environmentId,
        serverId,
      }),
      registerComposeVolumes(db, {
        document,
        organizationId,
        environmentId,
        serverId,
      }),
    ])

    assertEquals(first.length, 1)
    assertEquals(second.length, 1)
    assertEquals(first[0]!.storageId, second[0]!.storageId)
    assertEquals(first[0]!.composeKey, 'shared')
    assertEquals(second[0]!.composeKey, 'shared')
    assertEquals(first[0]!.volumeName, second[0]!.volumeName)

    const rows = await db
      .select({ id: storage.id })
      .from(storage)
      .where(eq(storage.environmentId, environmentId))
    assertEquals(rows.length, 1)
    assertEquals(rows[0]!.id, first[0]!.storageId)
  })
})
