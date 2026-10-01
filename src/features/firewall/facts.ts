/**
 * Gather the facts `deriveFirewall` needs for one server. Read-only: nothing
 * here writes, sends or enqueues.
 *
 * Every source of "what this host listens on" is read from the same place its
 * owner already reads it, so the preview cannot drift from the system:
 *  - hosting Caddy: HTTP hostings with hostnames on environments pinned here
 *    (the demand test `system/reconcile.ts` uses), with each hosting's bind scope;
 *  - compose `ports:`: the merged compose of every environment deployed here;
 *  - the shared ProxySQL listeners (`managed/host-exposure.ts`);
 *  - TurboFabric's WireGuard port (a relay on this server);
 *  - the HA Raft ports (this server hosts a primary or a failover replica);
 *  - the control plane's own port (the self-host pin: this server is the panel's host).
 *
 * Environments are counted from their `deployment` rows, so a stopped
 * environment whose deployment row still exists is included until it is removed.
 */

import { and, asc, eq, isNull, or, sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import {
  bulwark,
  datacenter,
  edict,
  fabric,
  instanceHostname,
  organization,
  relay,
  replica,
  server,
} from '../../db/schema.ts'
import { WORKSPACE_KIND_TURBOPANEL } from '../../db/workspace-kind.ts'
import { resolveComposeLayerChain, isComposeChainError } from '../compose/layer-chain.ts'
import { mergeComposeLayers } from '../compose/layers.ts'
import { parseDatacenterOptions } from '../datacenters/datacenter-options.ts'
import { parseFabricOptions } from '../fabric/cidr.ts'
import { resolveHostingBind } from '../hostings/hosting-options.ts'
import { MANAGED_HA_HTTP_PORT, MANAGED_HA_RAFT_PORT } from '../managed/ha-ports.ts'
import { serverHostsManagedHa } from '../managed/ha-policy.ts'
import { loadHostIngressListeners } from '../managed/host-exposure.ts'
import type { ManagedSqlAccessScope } from '../managed/access-scope.ts'
import { parseOrganizationOptions } from '../organizations/organization-options.ts'
import { resolveEffectiveSshPort } from '../servers/host-defaults.ts'
import { parseServerOptions } from '../servers/server-metadata.ts'
import { SYSTEM_SELF_HOST_COMPONENT } from '../system/hierarchy.ts'
import { publishedPortsOfCompose } from './compose-ports.ts'
import type {
  DerivedExposure,
  EdictFact,
  ExposureReach,
  FirewallDeriveInput,
  FirewallSourceSets,
} from './derive.ts'
import { type FirewallOrgPolicy, parseFirewallOrgPolicy } from './policy.ts'

import type { FirewallModeValue } from './vocabulary.ts'

/** The control plane's entrypoint on its own host (Caddy, HTTPS). */
export const CONTROL_PLANE_PORT = 8443

/** Port 80 is opened for Let's Encrypt HTTP-01 issuance and renewal only. */
export const ACME_HTTP_PORT = 80

export type LoadedFirewallFacts = {
  organizationId: string
  mode: FirewallModeValue
  input: FirewallDeriveInput
  /** Why a source of ports could not be read or was skipped; shown with the preview. */
  notes: string[]
}

type ServerBase = { organizationId: string; options: unknown }

async function loadServerBase(db: Db, serverId: string): Promise<ServerBase | null> {
  const [row] = await db
    .select({ organizationId: server.organizationId, options: server.options })
    .from(server)
    .where(eq(server.id, serverId))
    .limit(1)
  if (!row?.organizationId) return null
  return { organizationId: row.organizationId, options: row.options }
}

async function loadDatacenterIds(db: Db, serverId: string): Promise<string[]> {
  const rows = await db.execute<{ datacenter_id: string }>(sql`
    SELECT DISTINCT datacenter_id::text AS datacenter_id
    FROM ip
    WHERE server_id = ${serverId}::uuid AND datacenter_id IS NOT NULL
    ORDER BY 1
  `)
  return [...rows].map((row) => row.datacenter_id)
}

/**
 * The panel's belief about sshd's port: the most specific host default
 * (server, then the server's datacenter when it is in exactly one, then the
 * organization), else 22. The host also asks sshd itself, so a wrong guess can
 * only keep one extra port open; it can never close the real one.
 */
async function loadSshPortHint(
  db: Db,
  serverId: string,
  base: ServerBase,
  datacenterIds: string[]
): Promise<number> {
  const [org] = await db
    .select({ options: organization.options })
    .from(organization)
    .where(eq(organization.id, base.organizationId))
    .limit(1)
  let dcOptions = null
  if (datacenterIds.length === 1) {
    const [dc] = await db
      .select({ options: datacenter.options })
      .from(datacenter)
      .where(eq(datacenter.id, datacenterIds[0]!))
      .limit(1)
    dcOptions = dc ? parseDatacenterOptions(dc.options) : null
  }
  return resolveEffectiveSshPort(
    parseServerOptions(base.options),
    dcOptions,
    org ? parseOrganizationOptions(org.options) : null
  ).sshPort
}

/**
 * This server is the control plane's own host: the self-host pin (a system
 * environment of the `turbopanel` workspace pinned here). Same join as
 * `client/servers/colocated.ts`, repeated because `features/` may not import a
 * surface. Always false on a hosted control plane.
 */
export async function isCoLocatedServer(db: Db, serverId: string): Promise<boolean> {
  const rows = await db.execute<{ pinned: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1
      FROM environment e
      JOIN project p ON p.id = e.project_id
      JOIN workspace w ON w.id = p.workspace_id
      WHERE e.server_id = ${serverId}::uuid
        AND w.kind = ${WORKSPACE_KIND_TURBOPANEL}
        AND p.component = ${SYSTEM_SELF_HOST_COMPONENT}
    ) AS pinned
  `)
  return [...rows][0]?.pinned === true
}

/** 8443 always; plus 80 while any instance hostname uses Let's Encrypt (HTTP-01 needs it). */
async function loadControlPlanePorts(db: Db): Promise<number[]> {
  const rows = await db.select({ source: instanceHostname.source }).from(instanceHostname)
  const usesAcme = rows.some((row) => row.source === 'lets-encrypt')
  return usesAcme ? [CONTROL_PLANE_PORT, ACME_HTTP_PORT] : [CONTROL_PLANE_PORT]
}

function hostingReach(bind: string): ExposureReach | null {
  if (bind === 'public') return 'public'
  if (bind === 'datacenter') return 'datacenter'
  return null
}

/**
 * Hosting Caddy listens on 80 and 443 (and 443/udp for HTTP/3) when an HTTP
 * hosting with hostnames is placed here; the widest bind scope among them
 * decides who may connect. A `local` bind is loopback only: no rule.
 */
async function loadHostingExposures(db: Db, serverId: string): Promise<DerivedExposure[]> {
  const rows = await db.execute<{ options: unknown }>(sql`
    SELECT h.options AS options
    FROM hosting h
    JOIN service hs ON hs.id = h.service_id
    JOIN environment he ON he.id = hs.environment_id
    WHERE he.server_id = ${serverId}::uuid
      AND COALESCE(h.protocol, 'http') = 'http'
      AND jsonb_typeof(h.options->'hostnames') = 'array'
      AND jsonb_array_length(h.options->'hostnames') > 0
  `)
  const reaches = new Set<ExposureReach>()
  for (const row of rows) {
    const options = typeof row.options === 'object' && row.options !== null ? row.options : null
    const reach = hostingReach(
      resolveHostingBind(options as Parameters<typeof resolveHostingBind>[0])
    )
    if (reach !== null) reaches.add(reach)
  }
  const exposures: DerivedExposure[] = []
  for (const reach of reaches) {
    exposures.push(
      {
        source: 'hosting',
        scope: 'host',
        proto: 'tcp',
        ports: '80',
        reach,
        comment: 'Hosting HTTP',
      },
      {
        source: 'hosting',
        scope: 'host',
        proto: 'tcp',
        ports: '443',
        reach,
        comment: 'Hosting HTTPS',
      },
      {
        source: 'hosting',
        scope: 'host',
        proto: 'udp',
        ports: '443',
        reach,
        comment: 'Hosting HTTP/3',
      }
    )
  }
  return exposures
}

const SQL_SCOPE_REACH: Record<ManagedSqlAccessScope, ExposureReach | null> = {
  local: null,
  datacenter: 'datacenter',
  turbofabric: 'fabric',
  public: 'public',
}

async function loadManagedExposures(db: Db, serverId: string): Promise<DerivedExposure[]> {
  const { scopes, ports } = await loadHostIngressListeners(db, serverId)
  const exposures: DerivedExposure[] = []
  for (const scope of scopes) {
    const reach = SQL_SCOPE_REACH[scope]
    if (reach === null) continue
    for (const port of ports) {
      exposures.push({
        source: 'proxysql',
        scope: 'published',
        proto: 'tcp',
        ports: String(port),
        reach,
        comment: 'Managed database listener',
      })
    }
  }
  return exposures
}

/** TurboFabric: a relay on this server listens for WireGuard peers (any address: peers sit behind NAT). */
async function loadFabricExposures(db: Db, serverId: string): Promise<DerivedExposure[]> {
  const [row] = await db
    .select({ options: fabric.options })
    .from(relay)
    .innerJoin(fabric, eq(fabric.id, relay.fabricId))
    .where(eq(relay.serverId, serverId))
    .limit(1)
  if (!row) return []
  return [
    {
      source: 'fabric',
      scope: 'host',
      proto: 'udp',
      ports: String(parseFabricOptions(row.options).listenPort),
      reach: 'public',
      comment: 'TurboFabric WireGuard',
    },
  ]
}

/** The org Orchestrator's Raft and HTTP ports; peers are this organization's other servers. */
async function loadHaExposures(db: Db, serverId: string): Promise<DerivedExposure[]> {
  const members = await db
    .select({ role: replica.role, replicaClass: replica.replicaClass })
    .from(replica)
    .where(eq(replica.serverId, serverId))
  if (!serverHostsManagedHa(members)) return []
  return [MANAGED_HA_HTTP_PORT, MANAGED_HA_RAFT_PORT].map((port) => ({
    source: 'ha',
    scope: 'published' as const,
    proto: 'tcp' as const,
    ports: String(port),
    reach: 'servers' as const,
    comment: 'Managed HA orchestrator',
  }))
}

type EnvironmentCompose = { id: string; projectOptions: unknown; environmentOptions: unknown }

async function loadDeployedEnvironments(db: Db, serverId: string): Promise<EnvironmentCompose[]> {
  const rows = await db.execute<{ id: string; project_options: unknown; env_options: unknown }>(sql`
    SELECT DISTINCT ON (e.id) e.id::text AS id, p.options AS project_options, e.options AS env_options
    FROM deployment d
    JOIN environment e ON e.id = d.environment_id
    JOIN project p ON p.id = e.project_id
    WHERE d.server_id = ${serverId}::uuid
      AND d.status <> 'draining'
    ORDER BY e.id
  `)
  return [...rows].map((row) => ({
    id: row.id,
    projectOptions: row.project_options,
    environmentOptions: row.env_options,
  }))
}

function exposureFromPublishedPort(port: {
  proto: 'tcp' | 'udp'
  ports: string
  hostIp?: string
  service: string
}): DerivedExposure {
  return {
    source: 'compose',
    scope: 'published',
    proto: port.proto,
    ports: port.ports,
    reach: 'public',
    comment: `App ${port.service}`,
    ...(port.hostIp === undefined ? {} : { destination: port.hostIp }),
  }
}

async function loadComposeExposures(
  db: Db,
  serverId: string,
  notes: string[]
): Promise<DerivedExposure[]> {
  const exposures: DerivedExposure[] = []
  for (const environment of await loadDeployedEnvironments(db, serverId)) {
    const chain = resolveComposeLayerChain({
      projectOptions: environment.projectOptions,
      environmentOptions: environment.environmentOptions,
      environmentFilename: 'docker-compose.environment.yml',
    })
    if (isComposeChainError(chain)) {
      notes.push(
        `An environment's compose document could not be read, so its ports are not shown (${environment.id})`
      )
      continue
    }
    const merged = mergeComposeLayers(chain)
    const { ports, notes: portNotes } = publishedPortsOfCompose(merged.data)
    notes.push(...portNotes)
    exposures.push(...ports.map(exposureFromPublishedPort))
  }
  return exposures
}

function addressesToCidrs(addresses: string[]): string[] {
  return addresses.map((address) => address.trim()).filter((address) => address !== '')
}

async function loadSourceSets(
  db: Db,
  serverId: string,
  organizationId: string,
  datacenterIds: string[]
): Promise<FirewallSourceSets> {
  const orgServers = await db.execute<{ address: string }>(sql`
    SELECT host(ip.address) AS address
    FROM ip
    JOIN server s ON s.id = ip.server_id
    WHERE s.organization_id = ${organizationId}::uuid AND s.id <> ${serverId}::uuid
    UNION
    SELECT host(r.address) AS address
    FROM relay r
    JOIN server s ON s.id = r.server_id
    WHERE s.organization_id = ${organizationId}::uuid AND s.id <> ${serverId}::uuid
  `)
  const dcCidrs =
    datacenterIds.length === 0
      ? []
      : [
          ...(await db.execute<{ cidr: string }>(sql`
            SELECT DISTINCT n.cidr::text AS cidr
            FROM network n
            WHERE n.kind = 'datacenter'
              AND n.cidr IS NOT NULL
              AND n.organization_id = ${organizationId}::uuid
              AND n.datacenter_id IN (${sql.join(
                datacenterIds.map((id) => sql`${id}::uuid`),
                sql`, `
              )})
          `)),
        ].map((row) => row.cidr)
  const fabricRows = await db
    .select({ cidr: fabric.cidr })
    .from(fabric)
    .where(eq(fabric.organizationId, organizationId))
  return {
    servers: addressesToCidrs([...orgServers].map((row) => row.address)),
    datacenter: addressesToCidrs(dcCidrs),
    fabric: addressesToCidrs(fabricRows.map((row) => row.cidr)),
  }
}

async function loadEdictFacts(
  db: Db,
  organizationId: string,
  serverId: string
): Promise<EdictFact[]> {
  const rows = await db
    .select()
    .from(edict)
    .where(
      and(
        eq(edict.organizationId, organizationId),
        eq(edict.isEnabled, true),
        or(isNull(edict.serverId), eq(edict.serverId, serverId))
      )
    )
    .orderBy(asc(edict.createdAt), asc(edict.id))
  return rows.map((row) => ({
    id: row.id,
    scope: row.scope as EdictFact['scope'],
    action: row.action as EdictFact['action'],
    proto: row.proto as EdictFact['proto'],
    ports: row.ports,
    sourceKind: row.sourceKind as EdictFact['sourceKind'],
    sourceAddresses: row.sourceAddresses ?? [],
    label: row.label,
  }))
}

async function loadServerMode(db: Db, serverId: string): Promise<FirewallModeValue> {
  const [row] = await db
    .select({ mode: bulwark.mode })
    .from(bulwark)
    .where(eq(bulwark.serverId, serverId))
    .limit(1)
  return (row?.mode ?? 'observe') as FirewallModeValue
}

async function loadOrganizationPolicy(db: Db, organizationId: string): Promise<FirewallOrgPolicy> {
  const [row] = await db
    .select({ options: organization.options })
    .from(organization)
    .where(eq(organization.id, organizationId))
    .limit(1)
  return parseFirewallOrgPolicy(row?.options)
}

/** Everything the derivation needs for one server, or null when the server is gone. */
export async function loadFirewallFacts(
  db: Db,
  serverId: string
): Promise<LoadedFirewallFacts | null> {
  const base = await loadServerBase(db, serverId)
  if (!base) return null
  const notes: string[] = []
  const datacenterIds = await loadDatacenterIds(db, serverId)
  const [coLocated, controlPlaneTcpPorts, sshPort, policy, mode, edicts, sources] =
    await Promise.all([
      isCoLocatedServer(db, serverId),
      loadControlPlanePorts(db),
      loadSshPortHint(db, serverId, base, datacenterIds),
      loadOrganizationPolicy(db, base.organizationId),
      loadServerMode(db, serverId),
      loadEdictFacts(db, base.organizationId, serverId),
      loadSourceSets(db, serverId, base.organizationId, datacenterIds),
    ])
  const [hosting, managed, fabricExposure, ha, compose] = await Promise.all([
    loadHostingExposures(db, serverId),
    loadManagedExposures(db, serverId),
    loadFabricExposures(db, serverId),
    loadHaExposures(db, serverId),
    loadComposeExposures(db, serverId, notes),
  ])
  return {
    organizationId: base.organizationId,
    mode,
    notes,
    input: {
      policy,
      sshPortHint: sshPort,
      coLocated,
      controlPlaneTcpPorts,
      exposures: [...hosting, ...managed, ...fabricExposure, ...ha, ...compose],
      edicts,
      sources,
    },
  }
}
