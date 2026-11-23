/**
 * The compose ports of a deployed environment in the firewall facts, against a
 * real database: the project Base may be empty with every service in the
 * environment's own changes, a port on a private host address is datacenter
 * reach, and one on every or a public address stays public. Skips without
 * TURBOPANEL_DATABASE_URL.
 */

import { skipWithoutDatabase } from '../../test-fixtures/require-service.test.support.ts'
import { assertEquals } from '@std/assert'
import { eq, inArray } from 'drizzle-orm'
import { createDenoDb, endDbConnection } from '../../db/connection.ts'
import {
  deployment,
  environment,
  organization,
  project,
  server,
  workspace,
} from '../../db/schema.ts'
import { getDatabaseUrl } from '../../db/url.ts'
import { deriveFirewall } from './derive.ts'
import { loadFirewallFacts } from './facts.ts'

const test = Deno.test.bind(Deno)
const dbUrl = getDatabaseUrl()

const EMPTY_BASE = { data: {}, version: 1, presentation: { comments: {}, keyOrder: [] } }

function layer(ports: Record<string, string[]>) {
  return {
    data: {
      services: Object.fromEntries(
        Object.entries(ports).map(([name, list]) => [name, { image: 'example/app:1', ports: list }])
      ),
    },
    version: 1,
    presentation: { comments: {}, keyOrder: [] },
  }
}

test('an empty Base with services in the environment derives each port with its own reach and address', async () => {
  if (!dbUrl) {
    skipWithoutDatabase('firewall compose exposure tests')
    return
  }
  const db = createDenoDb()
  const [org] = await db
    .insert(organization)
    .values({ name: 'Compose Exposure Org' })
    .returning({ id: organization.id })
  const organizationId = org!.id
  let workspaceId: string | null = null
  try {
    const [srv] = await db
      .insert(server)
      .values({ organizationId, name: 'Compose Exposure Server', isConnected: true })
      .returning({ id: server.id })
    const serverId = srv!.id
    const [ws] = await db
      .insert(workspace)
      .values({ name: 'Compose Exposure Workspace', organizationId })
      .returning({ id: workspace.id })
    workspaceId = ws!.id
    const [proj] = await db
      .insert(project)
      .values({
        name: 'Compose Exposure Project',
        workspaceId,
        organizationId,
        kind: 'compose',
        options: { compose: EMPTY_BASE },
      })
      .returning({ id: project.id })
    const envs = await db
      .insert(environment)
      .values([
        {
          name: 'one',
          projectId: proj!.id,
          serverId,
          options: {
            compose: layer({
              web: ['10.0.2.10:8081:80', '8082:80', '198.51.100.7:8083:80'],
            }),
          },
        },
        {
          name: 'two',
          projectId: proj!.id,
          serverId,
          options: { compose: layer({ web: ['10.0.2.11:8081:80'] }) },
        },
      ])
      .returning({ id: environment.id })
    await db
      .insert(deployment)
      .values(envs.map((env) => ({ environmentId: env.id, serverId, status: 'applied' })))
    const facts = await loadFirewallFacts(db, serverId)
    const compose = facts!.input.exposures.filter((exposure) => exposure.source === 'compose')
    assertEquals(
      compose
        .map((exposure) => [exposure.ports, exposure.destination ?? null, exposure.reach])
        .toSorted((a, b) => `${a}`.localeCompare(`${b}`)),
      [
        ['8081', '10.0.2.10', 'datacenter'],
        ['8081', '10.0.2.11', 'datacenter'],
        ['8082', null, 'public'],
        ['8083', '198.51.100.7', 'public'],
      ]
    )
    const derivation = deriveFirewall({
      ...facts!.input,
      sources: { ...facts!.input.sources, datacenter: ['10.0.2.0/24'] },
    })
    const mine = derivation.rules.filter((rule) => rule.id.startsWith('d:compose:'))
    assertEquals(mine.length, 4)
    assertEquals(mine.filter((rule) => rule.ports === '8081').length, 2)
  } finally {
    const ids = (
      await db
        .select({ id: server.id })
        .from(server)
        .where(eq(server.organizationId, organizationId))
    ).map((row) => row.id)
    if (ids.length > 0) await db.delete(deployment).where(inArray(deployment.serverId, ids))
    if (workspaceId !== null) {
      await db.delete(environment).where(inArray(environment.serverId, ids))
      await db.delete(project).where(eq(project.workspaceId, workspaceId))
      await db.delete(workspace).where(eq(workspace.id, workspaceId))
    }
    await db.delete(server).where(eq(server.organizationId, organizationId))
    await db.delete(organization).where(eq(organization.id, organizationId))
    await endDbConnection(db)
  }
})
