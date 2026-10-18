/**
 * The create and delete flows of services and volumes against the folder rules:
 * folder names, the shared (common) scope, locks once a folder exists, rows kept
 * as removing, and the server pin of an environment. Needs a database.
 */
import { assertEquals, assertMatch } from '@std/assert'
import { eq } from 'drizzle-orm'
import {
  environment,
  folder,
  organization,
  principal,
  server,
  service,
  storage,
  tenancy,
} from '../db/schema.ts'
import { parseFoldersRemovePayload } from '../contracts/commands/schemas.ts'
import { getCommandDispatchPayload } from '../features/commands/command-records.ts'
import type { CommandEnvelope } from '../features/commands/envelope.ts'
import type { CommandQueue } from '../features/commands/queue.ts'
import {
  type Ctx,
  createProject,
  send,
  withFolderFixtures as withFixtures,
} from '../test-fixtures/folder-world.test.support.ts'

const test = Deno.test.bind(Deno)

async function createVolume(
  ctx: Ctx,
  envId: string,
  extra: Record<string, unknown> = {},
  withPathCopy = false
) {
  return await send(ctx, 'POST', '/storage', {
    environmentId: envId,
    kind: 'volume',
    name: 'Uploads',
    principalId: ctx.principalId,
    ...(withPathCopy ? { storageCopy: { provider: 'path', serverId: ctx.serverId } } : {}),
    ...extra,
  })
}

async function readVolume(ctx: Ctx, id: string) {
  const [row] = await ctx.db
    .select({ slug: storage.slug, isCommon: storage.isCommon })
    .from(storage)
    .where(eq(storage.id, id))
  return row!
}

async function addService(ctx: Ctx, envId: string, name: string): Promise<string> {
  const [row] = await ctx.db
    .insert(service)
    .values({ environmentId: envId, composeServiceName: name, name })
    .returning({ id: service.id })
  await ctx.db.insert(tenancy).values({ principalId: ctx.principalId, serviceId: row!.id })
  return row!.id
}

test('a new volume is named after its display name, or by the name typed', async () => {
  await withFixtures(async (ctx) => {
    const { envId } = await createProject(ctx, 'Volume Names')
    const named = await createVolume(ctx, envId)
    assertEquals(named.status, 200)
    assertEquals(await readVolume(ctx, named.json.id as string), {
      slug: 'uploads',
      isCommon: false,
    })

    const typed = await createVolume(ctx, envId, { name: 'Backups', slug: 'nightly' })
    assertEquals((await readVolume(ctx, typed.json.id as string)).slug, 'nightly')

    // The default takes the next free suffix; a typed name that is taken is refused.
    const again = await createVolume(ctx, envId)
    assertEquals((await readVolume(ctx, again.json.id as string)).slug, 'uploads-2')
    const clash = await createVolume(ctx, envId, { slug: 'uploads' })
    assertEquals(clash.status, 409)
    assertEquals(clash.json.error, 'directory_name_taken')
    const bad = await createVolume(ctx, envId, { slug: 'Not A Name' })
    assertEquals(bad.status, 400)
    assertEquals(bad.json.error, 'invalid_directory_name')

    const read = await send(ctx, 'GET', `/storage/${named.json.id}`)
    const body = read.json.storage as { slug: string; common: boolean }
    assertEquals({ slug: body.slug, common: body.common }, { slug: 'uploads', common: false })
  })
})

test('the organization setting decides between a typed name and the id', async () => {
  await withFixtures(async (ctx) => {
    const { envId } = await createProject(ctx, 'Setting Names')
    await ctx.db
      .update(organization)
      .set({ options: { directoryNames: 'uuid' } })
      .where(eq(organization.id, ctx.organizationId))
    const typed = await createVolume(ctx, envId, { slug: 'mine' })
    assertEquals(typed.status, 409)
    assertEquals(typed.json.error, 'directory_name_typed_in_uuid_mode')
    const plain = await createVolume(ctx, envId)
    assertEquals((await readVolume(ctx, plain.json.id as string)).slug, plain.json.id)

    await ctx.db
      .update(organization)
      .set({ options: { directoryNames: 'slug' } })
      .where(eq(organization.id, ctx.organizationId))
    const forbidden = await createVolume(ctx, envId, { directoryName: 'uuid' })
    assertEquals(forbidden.status, 400)
    assertEquals(forbidden.json.error, 'directory_name_mode_forbidden')

    await ctx.db
      .update(organization)
      .set({ options: { directoryNames: 'both' } })
      .where(eq(organization.id, ctx.organizationId))
    const chosen = await createVolume(ctx, envId, { directoryName: 'uuid' })
    assertEquals((await readVolume(ctx, chosen.json.id as string)).slug, chosen.json.id)
  })
})

test('a volume opts into the common scope at creation, and a volume outside any environment is common', async () => {
  await withFixtures(async (ctx) => {
    const { envId, projectId } = await createProject(ctx, 'Common Volume')
    const shared = await createVolume(ctx, envId, { name: 'Media', common: true }, true)
    assertEquals(shared.status, 200)
    assertEquals(await readVolume(ctx, shared.json.id as string), { slug: 'media', isCommon: true })
    const [row] = await ctx.db
      .select()
      .from(folder)
      .where(eq(folder.storageId, shared.json.id as string))
    assertEquals(
      { scope: row!.scope, environmentId: row!.environmentId, state: row!.state },
      { scope: 'common', environmentId: null, state: 'planned' }
    )

    const projectLevel = await send(ctx, 'POST', '/storage', {
      projectId,
      kind: 'volume',
      name: 'Project Data',
    })
    assertEquals(projectLevel.status, 200)
    assertEquals((await readVolume(ctx, projectLevel.json.id as string)).isCommon, true)

    const notAFolder = await send(ctx, 'POST', '/storage', {
      environmentId: envId,
      kind: 'file',
      name: 'Config',
      content: 'x',
      slug: 'config',
    })
    assertEquals(notAFolder.status, 400)
    assertEquals(notAFolder.json.error, 'folder_options_not_supported')
  })
})

test('a volume with a path copy has a folder row, which locks its name and shows the environment name locked', async () => {
  await withFixtures(async (ctx) => {
    const { envId } = await createProject(ctx, 'Copy Lock')
    const created = await createVolume(ctx, envId, {}, true)
    const id = created.json.id as string
    const [row] = await ctx.db.select().from(folder).where(eq(folder.storageId, id))
    assertEquals(
      { scope: row!.scope, slug: row!.slug, kind: row!.kind, state: row!.state },
      { scope: 'production', slug: 'uploads', kind: 'volume', state: 'planned' }
    )
    const [org] = await ctx.db
      .select({ options: organization.options })
      .from(organization)
      .where(eq(organization.id, ctx.organizationId))
    assertEquals((org!.options as Record<string, unknown>).directoryNamesLocked, true)

    const renamed = await send(ctx, 'PATCH', `/storage/${id}`, { slug: 'other' })
    assertEquals(renamed.status, 409)
    assertEquals(renamed.json.error, 'storage_slug_locked')
    const scope = await send(ctx, 'PATCH', `/storage/${id}`, { common: true })
    assertEquals(scope.status, 409)
    assertEquals(scope.json.error, 'scope_locked')
    const same = await send(ctx, 'PATCH', `/storage/${id}`, { slug: 'uploads', name: 'Uploads 2' })
    assertEquals(same.status, 200)

    const blocked = await send(ctx, 'PATCH', `/environments/${envId}`, { name: 'staging' })
    assertEquals(blocked.status, 409)
    assertEquals(blocked.json.error, 'environment_name_locked')
  })
})

test('a volume folder name can be changed until a folder exists', async () => {
  await withFixtures(async (ctx) => {
    const { envId } = await createProject(ctx, 'Volume Rename')
    const created = await createVolume(ctx, envId)
    const other = await createVolume(ctx, envId, { name: 'Other' })
    const id = created.json.id as string

    const renamed = await send(ctx, 'PATCH', `/storage/${id}`, { slug: 'pictures' })
    assertEquals(renamed.status, 200)
    assertEquals((await readVolume(ctx, id)).slug, 'pictures')
    // The name another volume of the owner has is taken; a bad one is refused.
    const clash = await send(ctx, 'PATCH', `/storage/${other.json.id}`, { slug: 'pictures' })
    assertEquals(clash.status, 409)
    assertEquals(clash.json.error, 'directory_name_taken')
    assertEquals((await readVolume(ctx, other.json.id as string)).slug, 'other')
    const bad = await send(ctx, 'PATCH', `/storage/${id}`, { slug: 'Not A Name' })
    assertEquals(bad.status, 400)
    assertEquals((await send(ctx, 'PATCH', `/storage/${id}`, { slug: 5 })).status, 400)

    const file = await send(ctx, 'POST', '/storage', {
      environmentId: envId,
      kind: 'file',
      name: 'Config',
      content: 'x',
    })
    const refused = await send(ctx, 'PATCH', `/storage/${file.json.id}`, { slug: 'config' })
    assertEquals(refused.status, 400)
    assertEquals(refused.json.error, 'folder_options_not_supported')
  })
})

test('deleting a volume keeps its folder row as removing, and the lock stays', async () => {
  await withFixtures(async (ctx) => {
    const { envId } = await createProject(ctx, 'Volume Delete')
    const created = await createVolume(ctx, envId, {}, true)
    const id = created.json.id as string
    const deleted = await send(ctx, 'DELETE', `/storage/${id}`)
    assertEquals(deleted.status, 200)
    const rows = await ctx.db.select().from(folder).where(eq(folder.serverId, ctx.serverId))
    assertEquals(
      rows.map((row) => [row.state, row.storageId, row.slug]),
      [['removing', null, 'uploads']]
    )
    const blocked = await send(ctx, 'PATCH', `/environments/${envId}`, { name: 'staging' })
    assertEquals(blocked.status, 409)
    assertMatch(String(blocked.json.message), /cannot change/)
  })
})

test('removing a volume copy leaves that server folder waiting for the host', async () => {
  await withFixtures(async (ctx) => {
    const { envId } = await createProject(ctx, 'Copy Remove')
    const created = await createVolume(ctx, envId, {}, true)
    const id = created.json.id as string
    const copies = await send(ctx, 'GET', `/storage/${id}/copies`)
    const copyId = (copies.json.copies as Array<{ id: string }>)[0]!.id
    const removed = await send(ctx, 'DELETE', `/storage/${id}/copies/${copyId}`)
    assertEquals(removed.status, 200)
    const [row] = await ctx.db.select().from(folder).where(eq(folder.storageId, id))
    assertEquals(row!.state, 'removing')
    // Adding a copy again plans nothing new while the old row is still there.
    const added = await send(ctx, 'POST', `/storage/${id}/copies`, {
      provider: 'path',
      serverId: ctx.serverId,
    })
    assertEquals(added.status, 200)
  })
})

test('a service takes a typed folder name and the common scope only until its first folder exists', async () => {
  await withFixtures(async (ctx) => {
    const { envId } = await createProject(ctx, 'Service Settings')
    const web = await addService(ctx, envId, 'web')

    const typed = await send(ctx, 'PATCH', `/services/${web}`, { slug: 'example.com' })
    assertEquals(typed.status, 200)
    const read = await send(ctx, 'GET', `/services/${web}`)
    const body = read.json.service as { slug: string; common: boolean }
    assertEquals({ slug: body.slug, common: body.common }, { slug: 'example.com', common: false })

    const bad = await send(ctx, 'PATCH', `/services/${web}`, { slug: 'Example.COM' })
    assertEquals(bad.status, 400)
    const shared = await send(ctx, 'PATCH', `/services/${web}`, { common: true })
    assertEquals(shared.status, 200)
    assertEquals(
      ((await send(ctx, 'GET', `/services/${web}`)).json.service as { common: boolean }).common,
      true
    )
    await send(ctx, 'PATCH', `/services/${web}`, { common: false })

    await ctx.db.insert(folder).values({
      serverId: ctx.serverId,
      principalId: ctx.principalId,
      environmentId: envId,
      scope: 'production',
      kind: 'service',
      slug: 'example.com',
      serviceId: web,
      state: 'planned',
    })
    const locked = await send(ctx, 'PATCH', `/services/${web}`, { slug: 'other.example.com' })
    assertEquals(locked.status, 409)
    assertEquals(locked.json.error, 'service_slug_locked')
    const scope = await send(ctx, 'PATCH', `/services/${web}`, { common: true })
    assertEquals(scope.status, 409)
    assertEquals(scope.json.error, 'scope_locked')
    // Editing anything else, or writing the same values, is fine.
    const other = await send(ctx, 'PATCH', `/services/${web}`, {
      slug: 'example.com',
      description: 'x',
    })
    assertEquals(other.status, 200)
  })
})

test('sharing a service leaves its folder name to the deploy', async () => {
  await withFixtures(async (ctx) => {
    const { envId } = await createProject(ctx, 'Scope Only')
    const web = await addService(ctx, envId, 'web')
    assertEquals((await send(ctx, 'PATCH', `/services/${web}`, { common: true })).status, 200)
    const [row] = await ctx.db
      .select({ slug: service.slug, isCommon: service.isCommon })
      .from(service)
      .where(eq(service.id, web))
    assertEquals(row, { slug: null, isCommon: true })
  })
})

test('a typed service folder name that another service of the owner uses is refused', async () => {
  await withFixtures(async (ctx) => {
    const first = await createProject(ctx, 'Service Clash One')
    const second = await createProject(ctx, 'Service Clash Two')
    const a = await addService(ctx, first.envId, 'web')
    const b = await addService(ctx, second.envId, 'web')
    assertEquals((await send(ctx, 'PATCH', `/services/${a}`, { slug: 'example.com' })).status, 200)
    const clash = await send(ctx, 'PATCH', `/services/${b}`, { slug: 'example.com' })
    assertEquals(clash.status, 409)
    assertEquals(clash.json.error, 'directory_name_taken')
  })
})

test('two services of one environment cannot take one folder name, owner or not', async () => {
  await withFixtures(async (ctx) => {
    const { envId } = await createProject(ctx, 'Service Same Env')
    const insert = async (name: string) => {
      const [row] = await ctx.db
        .insert(service)
        .values({ environmentId: envId, composeServiceName: name, name })
        .returning({ id: service.id })
      return row!.id
    }
    const a = await insert('one')
    const b = await insert('two')
    assertEquals((await send(ctx, 'PATCH', `/services/${a}`, { slug: 'dup' })).status, 200)
    const clash = await send(ctx, 'PATCH', `/services/${b}`, { slug: 'dup' })
    assertEquals(clash.status, 409)
    assertEquals(clash.json.error, 'directory_name_taken')
  })
})

test('deleting a service keeps its folder row as removing', async () => {
  await withFixtures(async (ctx) => {
    const { envId } = await createProject(ctx, 'Service Delete')
    const web = await addService(ctx, envId, 'web')
    await ctx.db.insert(folder).values({
      serverId: ctx.serverId,
      principalId: ctx.principalId,
      environmentId: envId,
      scope: 'production',
      kind: 'service',
      slug: 'web',
      serviceId: web,
      state: 'present',
    })
    await ctx.db.delete(tenancy).where(eq(tenancy.serviceId, web))
    const deleted = await send(ctx, 'DELETE', `/services/${web}`)
    assertEquals(deleted.status, 200)
    const rows = await ctx.db.select().from(folder).where(eq(folder.serverId, ctx.serverId))
    assertEquals(
      rows.map((row) => [row.state, row.serviceId]),
      [['removing', null]]
    )
  })
})

test('an environment cannot move to another server while it has folders', async () => {
  await withFixtures(async (ctx) => {
    const { envId } = await createProject(ctx, 'Pin Lock')
    const web = await addService(ctx, envId, 'web')
    await ctx.db
      .update(environment)
      .set({ serverId: ctx.serverId })
      .where(eq(environment.id, envId))
    // Pinning to the server it is on is not a move.
    const same = await send(ctx, 'PATCH', `/environments/${envId}`, { serverId: ctx.serverId })
    assertEquals(same.status, 200)

    await ctx.db.insert(folder).values({
      serverId: ctx.serverId,
      principalId: ctx.principalId,
      environmentId: envId,
      scope: 'production',
      kind: 'service',
      slug: 'web',
      serviceId: web,
      state: 'present',
    })
    const cleared = await send(ctx, 'PATCH', `/environments/${envId}`, { serverId: null })
    assertEquals(cleared.status, 409)
    assertEquals(cleared.json.error, 'environment_server_locked')
    assertEquals((cleared.json.folders as unknown[]).length, 1)
    assertMatch(String(cleared.json.message), /cannot move to another server/)
  })
})

test('an environment name must be a folder name when it is created', async () => {
  await withFixtures(async (ctx) => {
    const { projectId } = await createProject(ctx, 'Env Create')
    for (const name of ['Staging', 'my env', 'common']) {
      const refused = await send(ctx, 'POST', '/environments', { projectId, name })
      assertEquals(refused.status, 400, name)
      assertEquals(refused.json.error, 'invalid_environment_name', name)
    }
    assertEquals((await send(ctx, 'POST', '/environments', { projectId })).status, 400)
    assertEquals(
      (await send(ctx, 'POST', '/environments', { projectId, name: 'staging' })).status,
      200
    )

    const project = await send(ctx, 'POST', '/projects', {
      type: 'empty',
      workspaceId: ctx.workspaceId,
      name: 'Bad Env Project',
      environmentName: 'My Env',
    })
    assertEquals(project.status, 400)
    assertEquals(project.json.error, 'invalid_environment_name')
  })
})

/** A queue that remembers what it was given, standing in for the real one. */
function recordingQueue(): { queue: CommandQueue; sent: CommandEnvelope[] } {
  const sent: CommandEnvelope[] = []
  return {
    sent,
    queue: {
      enqueue: (envelope) => {
        sent.push(envelope)
        return Promise.resolve()
      },
    },
  }
}

test('deleting a volume asks its server to remove the folder, naming it by its parts', async () => {
  const { queue, sent } = recordingQueue()
  await withFixtures(
    async (ctx) => {
      const { envId } = await createProject(ctx, 'Volume Removal Ask')
      const created = await createVolume(ctx, envId, {}, true)
      const deleted = await send(ctx, 'DELETE', `/storage/${created.json.id}`)
      assertEquals(deleted.status, 200)
      const removals = sent.filter((envelope) => envelope.type === 'server.folders.remove')
      assertEquals(removals.length, 1)
      assertEquals(removals[0]!.serverId, ctx.serverId)
      const [owner] = await ctx.db
        .select({ login: principal.appliedUsername })
        .from(principal)
        .where(eq(principal.id, ctx.principalId))
      const payload = await getCommandDispatchPayload(ctx.db, removals[0]!.commandId)
      assertEquals(parseFoldersRemovePayload(payload).folders, [
        {
          kind: 'volume',
          folder: { owner: owner!.login, scope: 'production', slug: 'uploads' },
        },
      ])
    },
    { commandQueue: queue }
  )
})

test('removing a volume copy asks that server, and deleting a service asks its server', async () => {
  const { queue, sent } = recordingQueue()
  await withFixtures(
    async (ctx) => {
      const { envId } = await createProject(ctx, 'Service Removal Ask')
      const created = await createVolume(ctx, envId, {}, true)
      const id = created.json.id as string
      const copies = await send(ctx, 'GET', `/storage/${id}/copies`)
      const copyId = (copies.json.copies as Array<{ id: string }>)[0]!.id
      assertEquals((await send(ctx, 'DELETE', `/storage/${id}/copies/${copyId}`)).status, 200)
      assertEquals(sent.filter((e) => e.type === 'server.folders.remove').length, 1)

      const web = await addService(ctx, envId, 'web')
      await ctx.db.insert(folder).values({
        serverId: ctx.serverId,
        principalId: ctx.principalId,
        environmentId: envId,
        scope: 'production',
        kind: 'service',
        slug: 'web',
        serviceId: web,
        state: 'present',
      })
      await ctx.db.delete(tenancy).where(eq(tenancy.serviceId, web))
      assertEquals((await send(ctx, 'DELETE', `/services/${web}`)).status, 200)
      // One command per server carries every removing folder on it, the volume's too.
      const removals = sent.filter((envelope) => envelope.type === 'server.folders.remove')
      assertEquals(removals.length, 2)
      const payload = parseFoldersRemovePayload(
        await getCommandDispatchPayload(ctx.db, removals[1]!.commandId)
      )
      assertEquals(payload.folders.map((entry) => `${entry.kind}:${entry.folder.slug}`).sort(), [
        'service:web',
        'volume:uploads',
      ])
    },
    { commandQueue: queue }
  )
})

test('a delete that is refused asks no one to remove anything', async () => {
  const { queue, sent } = recordingQueue()
  await withFixtures(
    async (ctx) => {
      const { envId } = await createProject(ctx, 'Refused Delete')
      const created = await createVolume(ctx, envId, {}, true)
      const missing = await send(ctx, 'DELETE', `/storage/${crypto.randomUUID()}`)
      assertEquals(missing.status, 404)
      assertEquals(sent, [])
      assertEquals(
        (await ctx.db.select().from(folder).where(eq(folder.serverId, ctx.serverId))).length,
        1
      )
      assertEquals(created.status, 200)
    },
    { commandQueue: queue }
  )
})

test('a removing folder says in plain words that it waits for its server', async () => {
  await withFixtures(async (ctx) => {
    const { envId } = await createProject(ctx, 'Waiting Words')
    const created = await createVolume(ctx, envId, {}, true)
    assertEquals((await send(ctx, 'DELETE', `/storage/${created.json.id}`)).status, 200)
    // The server is offline (a fresh server is not connected).
    const offline = await send(ctx, 'PATCH', `/environments/${envId}`, { name: 'staging' })
    assertEquals(offline.status, 409)
    assertEquals(
      (offline.json.folders as Array<{ reason: string }>)[0]!.reason,
      'being removed, waiting for server Alpha to come back'
    )
    await ctx.db.update(server).set({ isConnected: true }).where(eq(server.id, ctx.serverId))
    const online = await send(ctx, 'PATCH', `/environments/${envId}`, { name: 'staging' })
    assertEquals(
      (online.json.folders as Array<{ reason: string }>)[0]!.reason,
      'being removed from server Alpha'
    )
  })
})
