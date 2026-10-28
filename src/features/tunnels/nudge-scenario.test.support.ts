/**
 * A tunnel scenario for the database-backed tunnel tests: a carrier (K), two
 * servers that can run the site (A, B) and a spare that is not in the
 * datacenter yet. The tunnel runs on K. `shop.example.com` is a doorway on the
 * site that runs on A, deployed and live.
 */
import { skipWithoutDatabase } from '../../test-fixtures/require-service.test.support.ts'
import { eq, inArray } from 'drizzle-orm'
import { createDenoDb, endDbConnection } from '../../db/connection.ts'
import { getDatabaseUrl } from '../../db/url.ts'
import {
  command,
  datacenter,
  deployment,
  doorway,
  environment,
  hosting,
  hostname,
  ip,
  key,
  leaf,
  network,
  organization,
  portal,
  project,
  secret,
  server,
  service,
  tunnel,
  workspace,
} from '../../db/schema.ts'
import { parseTunnelRoutesPayload } from '../../contracts/commands/tunnel-routes.ts'
import { getCommandDispatchPayload } from '../commands/command-records.ts'
import type { CommandEnvelope } from '../commands/envelope.ts'
import { replaceHostingHostnames } from '../servers/hostname-records.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import { deriveEncryptionSecretsConfig } from '../../lib/secrets/secrets.ts'
import { TUNNEL_CONNECTOR_FEATURE, TUNNEL_FORWARDING_FEATURE } from '../../lib/version-wire.ts'
import { encryptSecret } from '../../lib/secrets/data-encryption.ts'
import { RUN_SECRET_PROVIDER } from './vocabulary.ts'
import { parseTunnelConnectorsPayload } from '../../contracts/commands/tunnel-connectors.ts'
import type { TunnelSyncDeps } from './sync.ts'

const dbUrl = getDatabaseUrl()
export const NAME = 'shop.example.com'

export type Db = ReturnType<typeof createDenoDb>

export type Scenario = {
  db: Db
  deps: TunnelSyncDeps
  queued: CommandEnvelope[]
  organizationId: string
  datacenterId: string
  networkId: string
  carrierId: string
  siteAId: string
  siteBId: string
  spareId: string
  environmentAId: string
  projectId: string
  hostingAId: string
  hostingBId: string
  tunnelId: string
  /** The provider's id for the tunnel, as connector commands name it. */
  providerTunnelId: string
  doorwayId: string
}

async function newServer(db: Db, organizationId: string, name: string): Promise<string> {
  const [row] = await db
    .insert(server)
    .values({
      organizationId,
      name,
      isConnected: true,
      daemon: { projection: { features: [TUNNEL_FORWARDING_FEATURE, TUNNEL_CONNECTOR_FEATURE] } },
    })
    .returning({ id: server.id })
  await db.insert(key).values({
    serverId: row!.id,
    algorithm: 'Ed25519',
    publicJwk: { kty: 'OKP', crv: 'Ed25519', x: 'A'.repeat(43) },
    fingerprint: `fp-${crypto.randomUUID()}`,
  })
  return row!.id
}

export async function addAddress(
  s: Pick<Scenario, 'db' | 'organizationId' | 'datacenterId' | 'networkId'>,
  serverId: string,
  address: string
) {
  await s.db.insert(ip).values({
    organizationId: s.organizationId,
    datacenterId: s.datacenterId,
    networkId: s.networkId,
    serverId,
    address,
    allocation: 'dedicated',
    scope: 'datacenter',
  })
}

async function newSite(
  db: Db,
  ctx: { organizationId: string; workspaceId: string; serverId: string; label: string }
) {
  const [proj] = await db
    .insert(project)
    .values({
      name: `Project ${ctx.label}`,
      workspaceId: ctx.workspaceId,
      organizationId: ctx.organizationId,
    })
    .returning({ id: project.id })
  const [env] = await db
    .insert(environment)
    .values({ name: 'production', projectId: proj!.id, serverId: ctx.serverId })
    .returning({ id: environment.id })
  const [svc] = await db
    .insert(service)
    .values({ environmentId: env!.id, composeServiceName: 'web' })
    .returning({ id: service.id })
  const [site] = await db
    .insert(hosting)
    .values({ serviceId: svc!.id, options: { hostnames: [] } })
    .returning({ id: hosting.id })
  return { projectId: proj!.id, environmentId: env!.id, hostingId: site!.id }
}

/** The table a queued command carried. */
export async function tableOf(s: Scenario, index: number) {
  return parseTunnelRoutesPayload(await getCommandDispatchPayload(s.db, s.queued[index]!.commandId))
}

async function cleanup(db: Db, organizationId: string): Promise<void> {
  const serverIds = (
    await db.select({ id: server.id }).from(server).where(eq(server.organizationId, organizationId))
  ).map((r) => r.id)
  if (serverIds.length > 0) await db.delete(command).where(inArray(command.serverId, serverIds))
  await db.delete(leaf).where(eq(leaf.organizationId, organizationId))
  await db.delete(doorway).where(eq(doorway.routingOrganizationId, organizationId))
  const tunnelIds = (
    await db.select({ id: tunnel.id }).from(tunnel).where(eq(tunnel.organizationId, organizationId))
  ).map((r) => r.id)
  if (tunnelIds.length > 0) await db.delete(portal).where(inArray(portal.tunnelId, tunnelIds))
  await db.delete(tunnel).where(eq(tunnel.organizationId, organizationId))
  await db.delete(secret).where(eq(secret.organizationId, organizationId))
  await db.delete(deployment).where(inArray(deployment.serverId, serverIds))
  const hostingIds = (
    await db
      .select({ id: hosting.id })
      .from(hosting)
      .innerJoin(service, eq(service.id, hosting.serviceId))
      .innerJoin(environment, eq(environment.id, service.environmentId))
      .innerJoin(project, eq(project.id, environment.projectId))
      .where(eq(project.organizationId, organizationId))
  ).map((r) => r.id)
  if (hostingIds.length > 0) {
    await db.delete(hostname).where(inArray(hostname.hostingId, hostingIds))
    await db.delete(hosting).where(inArray(hosting.id, hostingIds))
  }
  const projectIds = (
    await db
      .select({ id: project.id })
      .from(project)
      .where(eq(project.organizationId, organizationId))
  ).map((r) => r.id)
  if (projectIds.length > 0) {
    const environmentIds = (
      await db
        .select({ id: environment.id })
        .from(environment)
        .where(inArray(environment.projectId, projectIds))
    ).map((r) => r.id)
    if (environmentIds.length > 0) {
      await db.delete(service).where(inArray(service.environmentId, environmentIds))
      await db.delete(environment).where(inArray(environment.id, environmentIds))
    }
    await db.delete(project).where(inArray(project.id, projectIds))
  }
  await db.delete(workspace).where(eq(workspace.organizationId, organizationId))
  await db.delete(ip).where(eq(ip.organizationId, organizationId))
  await db.delete(key).where(inArray(key.serverId, serverIds))
  await db.delete(server).where(eq(server.organizationId, organizationId))
  await db.delete(network).where(eq(network.organizationId, organizationId))
  await db.delete(datacenter).where(eq(datacenter.organizationId, organizationId))
  await db.delete(organization).where(eq(organization.id, organizationId))
}

/**
 * A carrier (K), two servers that can run the site (A, B) and a spare that is
 * not in the datacenter yet. The tunnel runs on K. `shop.example.com` is a
 * doorway on the site that runs on A, deployed and live.
 */
export async function withScenario(
  options: { tunnelPlacement?: 'chosen' | 'all'; deployedOnA?: boolean },
  fn: (s: Scenario) => Promise<void>
): Promise<void> {
  if (!dbUrl) {
    skipWithoutDatabase('tunnel nudge tests')
    return
  }
  const db = createDenoDb()
  const secretsConfig = parseTestSecretsConfig('deno')
  const dataEncryptionSecrets = await deriveEncryptionSecretsConfig(
    secretsConfig,
    'data-encryption'
  )
  const queued: CommandEnvelope[] = []
  const deps: TunnelSyncDeps = {
    commandQueue: {
      enqueue: (envelope) => {
        queued.push(envelope)
        return Promise.resolve()
      },
    },
    secretsConfig,
    dataEncryptionSecrets,
  }
  const [org] = await db.insert(organization).values({ name: 'Tunnel Nudge Org' }).returning()
  const organizationId = org!.id
  try {
    const [dc] = await db
      .insert(datacenter)
      .values({ organizationId, name: 'Nudge DC' })
      .returning({ id: datacenter.id })
    const [net] = await db
      .insert(network)
      .values({
        organizationId,
        datacenterId: dc!.id,
        kind: 'datacenter',
        cidr: '10.95.0.0/24', // NOSONAR typescript:S1313 — private test network, never dialed
        name: 'LAN',
      })
      .returning({ id: network.id })
    const base = { db, organizationId, datacenterId: dc!.id, networkId: net!.id }
    const carrierId = await newServer(db, organizationId, 'Carrier')
    const siteAId = await newServer(db, organizationId, 'Site A')
    const siteBId = await newServer(db, organizationId, 'Site B')
    const spareId = await newServer(db, organizationId, 'Spare')
    await addAddress(base, carrierId, '10.95.0.10') // NOSONAR typescript:S1313 — private test address, never dialed
    await addAddress(base, siteAId, '10.95.0.11') // NOSONAR typescript:S1313 — private test address, never dialed
    await addAddress(base, siteBId, '10.95.0.12') // NOSONAR typescript:S1313 — private test address, never dialed
    const [ws] = await db
      .insert(workspace)
      .values({ name: 'Nudge WS', organizationId })
      .returning({ id: workspace.id })
    const siteA = await newSite(db, {
      organizationId,
      workspaceId: ws!.id,
      serverId: siteAId,
      label: 'A',
    })
    const siteB = await newSite(db, {
      organizationId,
      workspaceId: ws!.id,
      serverId: siteBId,
      label: 'B',
    })
    await db.insert(deployment).values({
      environmentId: siteA.environmentId,
      serverId: siteAId,
      status: options.deployedOnA === false ? 'applying' : 'applied',
    })
    await db
      .insert(deployment)
      .values({ environmentId: siteB.environmentId, serverId: siteBId, status: 'applied' })
    await replaceHostingHostnames(db, siteA.hostingId, organizationId, [NAME])
    const placement = options.tunnelPlacement ?? 'chosen'
    const [runToken] = await db
      .insert(secret)
      .values({
        organizationId,
        provider: RUN_SECRET_PROVIDER,
        name: 'Nudge run token',
        // A made-up token, built so no scanner mistakes it for a real one.
        secretEnvelope: await encryptSecret(dataEncryptionSecrets, 'T'.repeat(48)),
      })
      .returning({ id: secret.id })
    const providerTunnelId = crypto.randomUUID()
    const [t] = await db
      .insert(tunnel)
      .values({
        organizationId,
        routingOrganizationId: organizationId,
        provider: 'cloudflare',
        name: 'Nudge',
        externalId: providerTunnelId,
        secretId: runToken!.id,
        placement,
        ...(placement === 'all' ? { datacenterId: dc!.id } : {}),
      })
      .returning({ id: tunnel.id })
    if (placement === 'chosen') {
      await db.insert(portal).values({ tunnelId: t!.id, serverId: carrierId, wanted: 'run' })
    }
    const [door] = await db
      .insert(doorway)
      .values({
        routingOrganizationId: organizationId,
        tunnelId: t!.id,
        hostname: NAME,
        hostingId: siteA.hostingId,
        status: 'live',
      })
      .returning({ id: doorway.id })
    await fn({
      ...base,
      deps,
      queued,
      carrierId,
      siteAId,
      siteBId,
      spareId,
      environmentAId: siteA.environmentId,
      projectId: siteA.projectId,
      hostingAId: siteA.hostingId,
      hostingBId: siteB.hostingId,
      tunnelId: t!.id,
      providerTunnelId,
      doorwayId: door!.id,
    })
  } finally {
    await cleanup(db, organizationId)
    await endDbConnection(db)
  }
}

/** Commands sent to one server, in order. */
export function sentTo(s: Scenario, serverId: string): CommandEnvelope[] {
  return s.queued.filter((e) => e.serverId === serverId && e.type === 'server.tunnel.routes')
}

/** Connector lists sent to one server, in order. */
export function connectorsTo(s: Scenario, serverId: string): CommandEnvelope[] {
  return s.queued.filter((e) => e.serverId === serverId && e.type === 'server.tunnel.connectors')
}

/** The connector list a queued command carried. */
export async function connectorListOf(s: Scenario, envelope: CommandEnvelope) {
  return parseTunnelConnectorsPayload(await getCommandDispatchPayload(s.db, envelope.commandId))
}
