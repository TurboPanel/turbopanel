import { assertEquals } from '@std/assert'
import { eq } from 'drizzle-orm'
import { getDatabaseUrl } from '../../db/url.ts'
import { createDenoDb } from '../../db/connection.ts'
import {
  container,
  environment,
  organization,
  project,
  server,
  service,
  workspace,
} from '../../db/schema.ts'
import { touchServerMetadata } from '../servers/server-registry.ts'
import { loadServiceRunStates } from './service-run-state.ts'

const dbUrl = getDatabaseUrl()

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const AS_OF = '2026-10-04T12:00:00.000Z'

test('a daemon services report is stored on the server and served per service', async () => {
  if (!dbUrl) {
    console.warn('Skipping service run state tests: TURBOPANEL_DATABASE_URL not set')
    return
  }
  const db = createDenoDb()
  const [org] = await db
    .insert(organization)
    .values({ name: 'Run State Org' })
    .returning({ id: organization.id })
  const organizationId = org!.id
  const [ws] = await db
    .insert(workspace)
    .values({ name: 'Run State Workspace', organizationId })
    .returning({ id: workspace.id })
  const [srv] = await db
    .insert(server)
    .values({ organizationId, name: 'Run State Server' })
    .returning({ id: server.id })
  const serverId = srv!.id
  const [proj] = await db
    .insert(project)
    .values({ name: 'Run State Project', workspaceId: ws!.id, organizationId })
    .returning({ id: project.id })
  const [env] = await db
    .insert(environment)
    .values({ name: 'Run State Env', projectId: proj!.id })
    .returning({ id: environment.id })
  const environmentId = env!.id
  const [web] = await db
    .insert(service)
    .values({ name: 'web', environmentId, composeServiceName: 'web' })
    .returning({ id: service.id })
  const [worker] = await db
    .insert(service)
    .values({ name: 'worker', environmentId, composeServiceName: 'worker' })
    .returning({ id: service.id })
  const webId = web!.id
  const workerId = worker!.id

  try {
    await db.insert(container).values([
      {
        serviceId: webId,
        serverId,
        containerId: 'cid-web',
        containerName: 'rs-web-1',
        composeServiceName: 'web',
      },
      {
        serviceId: workerId,
        serverId,
        containerId: 'cid-worker',
        containerName: 'rs-worker-1',
        composeServiceName: 'worker',
      },
    ])

    // Nothing reported yet: absent, not defaulted.
    assertEquals((await loadServiceRunStates(db, [webId, workerId])).size, 0)

    await touchServerMetadata(db, serverId, {
      services: [
        {
          serviceId: webId,
          state: 'crashing',
          restartCount: 4,
          lastError: '/bin/sh: 1: next: not found',
          asOf: AS_OF,
        },
        { serviceId: workerId, state: 'running', restartCount: 0, asOf: AS_OF },
      ],
    })
    const reported = await loadServiceRunStates(db, [webId, workerId])
    assertEquals(reported.get(webId), {
      state: 'crashing',
      running: false,
      restartCount: 4,
      lastError: '/bin/sh: 1: next: not found',
      asOf: AS_OF,
    })
    assertEquals(reported.get(workerId)?.running, true)

    // The next report replaces the list whole: web is gone, worker remains.
    await touchServerMetadata(db, serverId, {
      services: [{ serviceId: workerId, state: 'running', restartCount: 0, asOf: AS_OF }],
    })
    const replaced = await loadServiceRunStates(db, [webId, workerId])
    assertEquals(replaced.has(webId), false)
    assertEquals(replaced.has(workerId), true)

    // A heartbeat that carries no services leaves what is stored alone.
    await touchServerMetadata(db, serverId, { docker: { version: '28.3.3' } })
    assertEquals((await loadServiceRunStates(db, [workerId])).has(workerId), true)

    // An empty list is a real answer: everything on the host is gone.
    await touchServerMetadata(db, serverId, { services: [] })
    assertEquals((await loadServiceRunStates(db, [webId, workerId])).size, 0)
  } finally {
    await db.delete(container).where(eq(container.serverId, serverId))
    await db.delete(service).where(eq(service.environmentId, environmentId))
    await db.delete(environment).where(eq(environment.id, environmentId))
    await db.delete(project).where(eq(project.id, proj!.id))
    await db.delete(server).where(eq(server.id, serverId))
    await db.delete(workspace).where(eq(workspace.id, ws!.id))
    await db.delete(organization).where(eq(organization.id, organizationId))
  }
})
