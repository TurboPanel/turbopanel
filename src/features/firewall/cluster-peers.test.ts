/**
 * Managed cluster peer ports in the firewall derivation, against a real
 * database: the rule lists exactly the peer servers, shrinks when one is
 * removed, is absent without peers, keeps IPv4 and IPv6, and is never open to
 * anyone. Skips without TURBOPANEL_DATABASE_URL.
 */

import { assertEquals } from '@std/assert'
import { eq, inArray } from 'drizzle-orm'
import { createDenoDb, endDbConnection } from '../../db/connection.ts'
import {
  environment,
  ip,
  managed,
  organization,
  project,
  replica,
  server,
  workspace,
} from '../../db/schema.ts'
import { getDatabaseUrl } from '../../db/url.ts'
import { deriveFirewall } from './derive.ts'
import { loadClusterPeerExposures, loadFirewallFacts } from './facts.ts'

const test = Deno.test.bind(Deno)

const dbUrl = getDatabaseUrl()
const PRIVATE_PORT = 34001

type Db = ReturnType<typeof createDenoDb>

type Cluster = {
  organizationId: string
  managedId: string
  serverIds: string[]
  /** The server whose firewall is derived (hosts the primary). */
  home: string
  peerReplicaIds: string[]
}

async function insertServer(db: Db, organizationId: string, name: string, address: string) {
  const now = new Date().toISOString()
  const [row] = await db
    .insert(server)
    .values({ organizationId, name, isConnected: true, statusChangedAt: now })
    .returning({ id: server.id })
  await db.insert(ip).values({
    organizationId,
    serverId: row!.id,
    address,
    allocation: 'dedicated',
    scope: 'public',
  })
  return row!.id
}

async function withCluster(
  peerAddresses: string[],
  fn: (db: Db, cluster: Cluster) => Promise<void>
) {
  if (!dbUrl) {
    console.warn('Skipping cluster peer firewall tests: TURBOPANEL_DATABASE_URL not set')
    return
  }
  const db = createDenoDb()
  const [org] = await db
    .insert(organization)
    .values({ name: 'Cluster Peer Firewall Org' })
    .returning({ id: organization.id })
  const organizationId = org!.id
  let workspaceId: string | null = null
  try {
    const home = await insertServer(db, organizationId, 'Home', '203.0.113.5')
    const peers = await Promise.all(
      peerAddresses.map((address, index) =>
        insertServer(db, organizationId, `Peer ${index + 1}`, address)
      )
    )
    const [ws] = await db
      .insert(workspace)
      .values({ name: 'Cluster Peer Workspace', organizationId })
      .returning({ id: workspace.id })
    workspaceId = ws!.id
    const [proj] = await db
      .insert(project)
      .values({
        name: 'Cluster Peer Project',
        workspaceId,
        organizationId,
        metadata: { type: 'managed', code: 'postgres' },
      })
      .returning({ id: project.id })
    const [env] = await db
      .insert(environment)
      .values({ name: 'Production', projectId: proj!.id, serverId: home })
      .returning({ id: environment.id })
    const [cluster] = await db
      .insert(managed)
      .values({
        environmentId: env!.id,
        serverId: home,
        name: 'peers',
        engine: 'postgres',
        status: 'ready',
      })
      .returning({ id: managed.id })
    await db.insert(replica).values({
      managedId: cluster!.id,
      serverId: home,
      role: 'primary',
      ordinal: 1,
      privatePort: PRIVATE_PORT,
    })
    const peerRows =
      peers.length === 0
        ? []
        : await db
            .insert(replica)
            .values(
              peers.map((serverId, index) => ({
                managedId: cluster!.id,
                serverId,
                role: 'replica',
                replicaClass: 'read',
                isReadEligible: true,
                ordinal: index + 2,
                privatePort: PRIVATE_PORT + index + 1,
              }))
            )
            .returning({ id: replica.id })
    await fn(db, {
      organizationId,
      managedId: cluster!.id,
      serverIds: [home, ...peers],
      home,
      peerReplicaIds: peerRows.map((row) => row.id),
    })
  } finally {
    const ids = (
      await db
        .select({ id: server.id })
        .from(server)
        .where(eq(server.organizationId, organizationId))
    ).map((row) => row.id)
    if (ids.length > 0) await db.delete(ip).where(inArray(ip.serverId, ids))
    await db.delete(replica).where(inArray(replica.serverId, ids))
    if (ids.length > 0) await db.delete(managed).where(inArray(managed.serverId, ids))
    if (workspaceId !== null) {
      await db.delete(environment).where(inArray(environment.serverId, ids))
      await db.delete(project).where(eq(project.workspaceId, workspaceId))
      await db.delete(workspace).where(eq(workspace.id, workspaceId))
    }
    await db.delete(server).where(eq(server.organizationId, organizationId))
    await db.delete(organization).where(eq(organization.id, organizationId))
    await endDbConnection(db)
  }
}

async function derivedClusterRules(db: Db, cluster: Cluster) {
  const facts = await loadFirewallFacts(db, cluster.home)
  const derivation = deriveFirewall(facts!.input)
  return derivation.rules.filter((rule) => rule.id.startsWith('d:cluster:'))
}

test('a cluster with three peers lists exactly those peers, sorted, on its own port only', async () => {
  await withCluster(['198.51.100.30', '198.51.100.2', '198.51.100.9'], async (db, cluster) => {
    const rules = await derivedClusterRules(db, cluster)
    assertEquals(rules.length, 1)
    assertEquals(rules[0]!.ports, String(PRIVATE_PORT))
    assertEquals(rules[0]!.sources, ['198.51.100.2/32', '198.51.100.30/32', '198.51.100.9/32'])
    assertEquals(rules[0]!.destinations, ['203.0.113.5'])
    assertEquals(rules[0]!.sources.includes('any'), false)
  })
})

test('removing a peer shrinks the rule', async () => {
  await withCluster(['198.51.100.2', '198.51.100.9', '198.51.100.30'], async (db, cluster) => {
    await db.delete(replica).where(eq(replica.id, cluster.peerReplicaIds[2]!))
    const rules = await derivedClusterRules(db, cluster)
    assertEquals(rules[0]!.sources, ['198.51.100.2/32', '198.51.100.9/32'])
  })
})

test('a cluster with no peers derives no rule', async () => {
  await withCluster([], async (db, cluster) => {
    assertEquals(await derivedClusterRules(db, cluster), [])
    assertEquals(await loadClusterPeerExposures(db, cluster.home, []), [])
  })
})

test('IPv4 and IPv6 peers are both listed', async () => {
  await withCluster(['198.51.100.2', '2001:db8::7'], async (db, cluster) => {
    const rules = await derivedClusterRules(db, cluster)
    assertEquals(rules[0]!.sources, ['198.51.100.2/32', '2001:db8::7/128'])
  })
})

test('a second member of one cluster on one server cannot exist, so one rule per port is complete', async () => {
  await withCluster(['198.51.100.2'], async (db, cluster) => {
    let rejected = false
    try {
      await db.insert(replica).values({
        managedId: cluster.managedId,
        serverId: cluster.home,
        role: 'replica',
        replicaClass: 'read',
        isReadEligible: true,
        ordinal: 9,
        privatePort: PRIVATE_PORT + 20,
      })
    } catch {
      rejected = true
    }
    assertEquals(rejected, true)
    assertEquals((await derivedClusterRules(db, cluster)).length, 1)
  })
})
