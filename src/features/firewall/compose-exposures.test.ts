/**
 * The compose ports of a deployed environment in the firewall facts, against a
 * real database: the project Base may be empty with every service in the
 * environment's own changes, a port on a fabric address is fabric reach, and
 * one on every, a public or an unmatched private address stays public. Skips
 * without TURBOPANEL_DATABASE_URL.
 */

import { skipWithoutDatabase } from '../../test-fixtures/require-service.test.support.ts'
import { assertEquals } from '@std/assert'
import { eq, inArray } from 'drizzle-orm'
import { createDenoDb, endDbConnection } from '../../db/connection.ts'
import {
  deployment,
  environment,
  fabric,
  organization,
  project,
  server,
  workspace,
} from '../../db/schema.ts'
import { getDatabaseUrl } from '../../db/url.ts'
import { deriveFirewall } from './derive.ts'
import { loadFirewallFacts, reachOfHostIp } from './facts.ts'

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

test('an empty Base with services in the environment derives each port with its own address, and a fabric address gets fabric reach', async () => {
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
    await db.insert(fabric).values({ organizationId, name: 'Exposure Fabric', cidr: '10.250.0.0/16' })
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
          options: { compose: layer({ web: ['10.0.2.11:8081:80', '10.250.1.5:8084:80'] }) },
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
        ['8081', '10.0.2.10', 'public'],
        ['8081', '10.0.2.11', 'public'],
        ['8082', null, 'public'],
        ['8083', '198.51.100.7', 'public'],
        ['8084', '10.250.1.5', 'fabric'],
      ]
    )
    const derivation = deriveFirewall({
      ...facts!.input,
      sources: facts!.input.sources,
    })
    const mine = derivation.rules.filter((rule) => rule.id.startsWith('d:compose:'))
    assertEquals(mine.length, 5)
    assertEquals(mine.find((rule) => rule.ports === '8084')?.sources, ['10.250.0.0/16'])
    assertEquals(mine.filter((rule) => rule.ports === '8081').length, 2)
  } finally {
    const ids = (
      await db
        .select({ id: server.id })
        .from(server)
        .where(eq(server.organizationId, organizationId))
    ).map((row) => row.id)
    await db.delete(fabric).where(eq(fabric.organizationId, organizationId))
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

test('reachOfHostIp checks the fabric range first, then the datacenter, and keeps unmatched addresses public', () => {
  const sets = { fabric: ['10.250.0.0/16'], datacenter: ['10.0.2.0/24', 'fd00:1::/64'] }
  assertEquals(reachOfHostIp(undefined, sets), 'public')
  assertEquals(reachOfHostIp('198.51.100.7', sets), 'public')
  assertEquals(reachOfHostIp('10.250.3.4', sets), 'fabric')
  assertEquals(reachOfHostIp('10.0.2.10', sets), 'datacenter')
  assertEquals(reachOfHostIp('fd00:1::5', sets), 'datacenter')
  // A fabric range that sits inside a datacenter network is still fabric.
  assertEquals(reachOfHostIp('10.250.3.4', { ...sets, datacenter: ['10.0.0.0/8'] }), 'fabric')
  // Private but in no known range, ULA or link-local: not narrowed.
  assertEquals(reachOfHostIp('100.64.1.2', sets), 'public')
  assertEquals(reachOfHostIp('fd00:2::5', sets), 'public')
  assertEquals(reachOfHostIp('169.254.1.2', sets), 'public')
  assertEquals(reachOfHostIp('169.254.1.2', { ...sets, datacenter: ['169.254.0.0/16'] }), 'datacenter')
})
