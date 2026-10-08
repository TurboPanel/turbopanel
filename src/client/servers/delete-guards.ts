import { and, count, eq, inArray, sql } from 'drizzle-orm'
import type { Context } from 'hono'
import type { Db } from '../../db/connection.ts'
import { container, ip, network, server } from '../../db/schema.ts'
import { WORKSPACE_KIND_TURBOPANEL } from '../../db/workspace-kind.ts'

export type ServerDeleteBlockerKind = 'network' | 'container' | 'ip'

export type ServerDeleteBlocker = {
  kind: ServerDeleteBlockerKind
  count: number
}

export const SERVER_HAS_BLOCKERS_CODE = 'server_has_blockers'

export const SERVER_HAS_BLOCKERS_ERROR =
  'Cannot delete this server while dependent resources still exist'

export const SERVER_ONLINE_CODE = 'server_online'

export const SERVER_ONLINE_ERROR =
  'Cannot forget leftover resources while this server is still connected'

export const SERVER_DELETE_PREVIEW_LIST_CAP = 50

export const COLOCATED_SERVER_DELETE_BLOCKED_REASON =
  'The co-located control plane server cannot be deleted'

export function colocatedServerDeleteBlockedReason(): string {
  return COLOCATED_SERVER_DELETE_BLOCKED_REASON
}

/** Revoking the co-located daemon's key would cut the control plane off from its own host. */
export const COLOCATED_SERVER_KEY_REVOKE_BLOCKED_REASON =
  "The co-located control plane server's daemon key cannot be revoked"

export type ForgottenServerResources = {
  containers: number
  networks: number
  ips: number
}

export type ServerDeletePreviewContainer = {
  id: string
  name: string
  status: string
  serviceName?: string
}

export type ServerDeletePreviewNetwork = {
  id: string
  name: string
}

export type ServerDeletePreviewIp = {
  id: string
  address: string
}

export type CappedPreviewList<T> = {
  items: T[]
  more: number
}

export type ServerDeletePreview = {
  online: boolean
  canForget: boolean
  colocated: boolean
  blockers: ServerDeleteBlocker[]
  containers: CappedPreviewList<ServerDeletePreviewContainer>
  networks: CappedPreviewList<ServerDeletePreviewNetwork>
  ips: CappedPreviewList<ServerDeletePreviewIp>
}

/**
 * System-workspace ingress rows are torn down by
 * `deleteSystemEnvironmentSubtree` during DELETE — exclude them from the
 * generic blocker scan so stopped system inventory does not 409 the delete.
 */
function nonSystemContainerWhere(serverId: string) {
  return sql`
      FROM container c
      WHERE c.server_id = ${serverId}::uuid
        AND NOT EXISTS (
          SELECT 1
          FROM service s
          JOIN environment e ON e.id = s.environment_id
          JOIN project p ON p.id = e.project_id
          JOIN workspace w ON w.id = p.workspace_id
          WHERE s.id = c.service_id
            AND w.kind = ${WORKSPACE_KIND_TURBOPANEL}
        )
    `
}

/**
 * Placement and dependency blockers for server delete.
 * Future: extend when service.options carries server/replica placement.
 */
export async function listServerDeleteBlockers(
  db: Db,
  serverId: string,
  organizationId: string
): Promise<ServerDeleteBlocker[]> {
  const [serverRow] = await db
    .select({ id: server.id })
    .from(server)
    .where(and(eq(server.id, serverId), eq(server.organizationId, organizationId)))
    .limit(1)
  if (!serverRow) return []

  const [[networkCountRow], containerCountRows, [ipCountRow]] = await Promise.all([
    db.select({ value: count() }).from(network).where(eq(network.serverId, serverId)),
    db.execute<{ value: number | string }>(sql`
      SELECT count(*)::int AS value
      ${nonSystemContainerWhere(serverId)}
    `),
    db.select({ value: count() }).from(ip).where(eq(ip.serverId, serverId)),
  ])
  const containerCountRow = containerCountRows[0]

  const blockers: ServerDeleteBlocker[] = []
  const networkCount = Number(networkCountRow?.value ?? 0)
  if (networkCount > 0) {
    blockers.push({ kind: 'network', count: networkCount })
  }
  const containerCount = Number(containerCountRow?.value ?? 0)
  if (containerCount > 0) {
    blockers.push({ kind: 'container', count: containerCount })
  }
  const ipCount = Number(ipCountRow?.value ?? 0)
  if (ipCount > 0) {
    blockers.push({ kind: 'ip', count: ipCount })
  }
  return blockers
}

function capPreviewList<T>(items: T[], total: number): CappedPreviewList<T> {
  const capped = items.slice(0, SERVER_DELETE_PREVIEW_LIST_CAP)
  return {
    items: capped,
    more: Math.max(0, total - capped.length),
  }
}

export async function loadServerDeletePreview(
  db: Db,
  serverId: string,
  organizationId: string,
  opts: Readonly<{ online: boolean; colocated: boolean }>
): Promise<ServerDeletePreview> {
  const blockers = await listServerDeleteBlockers(db, serverId, organizationId)
  const containerTotal = blockers.find((row) => row.kind === 'container')?.count ?? 0
  const networkTotal = blockers.find((row) => row.kind === 'network')?.count ?? 0
  const ipTotal = blockers.find((row) => row.kind === 'ip')?.count ?? 0

  const [containerRows, networkRows, ipRows] = await Promise.all([
    containerTotal === 0
      ? Promise.resolve(
          [] as Array<{
            id: string
            name: string
            status: string
            serviceName: string | null
          }>
        )
      : db.execute<{
          id: string
          name: string
          status: string
          serviceName: string | null
        }>(sql`
          SELECT c.id, c.container_name AS name, c.status, c.compose_service_name AS "serviceName"
          ${nonSystemContainerWhere(serverId)}
          ORDER BY c.container_name ASC
          LIMIT ${SERVER_DELETE_PREVIEW_LIST_CAP}
        `),
    db
      .select({ id: network.id, name: network.name })
      .from(network)
      .where(eq(network.serverId, serverId))
      .orderBy(network.name)
      .limit(SERVER_DELETE_PREVIEW_LIST_CAP),
    db
      .select({ id: ip.id, address: ip.address })
      .from(ip)
      .where(eq(ip.serverId, serverId))
      .orderBy(ip.address)
      .limit(SERVER_DELETE_PREVIEW_LIST_CAP),
  ])

  const containers = capPreviewList(
    containerRows.map((row) => {
      const item: ServerDeletePreviewContainer = {
        id: row.id,
        name: row.name,
        status: row.status,
      }
      if (row.serviceName) item.serviceName = row.serviceName
      return item
    }),
    containerTotal
  )
  const networks = capPreviewList(
    networkRows.map((row) => ({ id: row.id, name: row.name ?? '' })),
    networkTotal
  )
  const ips = capPreviewList(
    ipRows.map((row) => ({ id: row.id, address: String(row.address) })),
    ipTotal
  )

  return {
    online: opts.online,
    canForget: !opts.online && !opts.colocated,
    colocated: opts.colocated,
    blockers,
    containers,
    networks,
    ips,
  }
}

/**
 * Query `forgetResources=true` (same style as managed `detach=true`) or an
 * explicit JSON body `{ forgetResources: true }`. Anything else is off.
 */
export function parseForgetResourcesFlag(
  queryValue: string | undefined,
  body: Record<string, unknown>
): boolean {
  return queryValue === 'true' || body.forgetResources === true
}

export function serverOnlineForgetBlockedResponse(c: Context): Response {
  return c.json(
    {
      error: SERVER_ONLINE_ERROR,
      code: SERVER_ONLINE_CODE,
    },
    409
  )
}

export function serverDeleteBlockersResponse(
  c: Context,
  blockers: ServerDeleteBlocker[]
): Response {
  return c.json(
    {
      error: SERVER_HAS_BLOCKERS_ERROR,
      code: SERVER_HAS_BLOCKERS_CODE,
      blockers,
    },
    409
  )
}

export async function forgetServerOwnedResources(
  tx: Db,
  serverId: string
): Promise<ForgottenServerResources> {
  const containerRows = await tx.execute<{ id: string }>(sql`
    SELECT c.id
    ${nonSystemContainerWhere(serverId)}
  `)
  const containerIds = containerRows.map((row) => row.id)
  if (containerIds.length > 0) {
    await tx.delete(container).where(inArray(container.id, containerIds))
  }
  const ipRows = await tx.delete(ip).where(eq(ip.serverId, serverId)).returning({ id: ip.id })
  const networkRows = await tx
    .delete(network)
    .where(eq(network.serverId, serverId))
    .returning({ id: network.id })
  return {
    containers: containerIds.length,
    networks: networkRows.length,
    ips: ipRows.length,
  }
}
