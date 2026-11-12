import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import type { DaemonCellRegistry } from '../../contracts/cell.ts'
import type { PreloadedFleetPresenceData } from '../../daemon/cell/server-status.ts'
import { readProjectionsForServers } from '../../daemon/cell/postgres-projection.ts'
import {
  COLOCATED_SERVER_DISPLAY_NAME,
  readLocalMachineKey,
  resolveColocatedServerId,
} from '../authn/install-state.ts'
import { WORKSPACE_KIND_TURBOPANEL } from '../../db/workspace-kind.ts'
import { license, server } from '../../db/schema.ts'

/** Matches `SYSTEM_SELF_HOST_COMPONENT` in `system/hierarchy.ts` (literal to avoid importing that module). */
const SELF_HOST_COMPONENT = 'turbopanel'

/**
 * Resolve which server ids are co-located with this control plane.
 *
 * Probe sources (registry, `__direct__` projection, local machine-key) identify
 * the live co-located daemon. The preferred durable source for authorization
 * guards (server delete, license revoke) is the self-host environment pin:
 * the co-located host is exactly the server carrying the `turbopanel`
 * system environment. Pass `includeSelfHostPin` to include that pin — keep
 * it off for cached read-model display badges so their approved-SQL profile
 * stays unchanged. Until that pin exists, server delete also falls back to an
 * active bound {@link COLOCATED_SERVER_DISPLAY_NAME} license
 * ({@link hasActiveColocatedLicenseBinding}).
 */

export type ResolveColocatedServerIdSetOptions = {
  /**
   * Org-scoped visible server lists already filter to assigned organization rows.
   * Skip the broader unassigned canonical lookup from `resolveColocatedServerId`.
   */
  orgScoped?: boolean
  /** Reuse rows/projections from a single fleet-presence preload. */
  preloaded?: PreloadedFleetPresenceData
  /**
   * Also mark servers that own the self-host `turbopanel` system environment.
   * Opt-in for authorization guards; leave off for display badges / read models.
   */
  includeSelfHostPin?: boolean
}

async function addCanonicalColocatedId(
  db: Db,
  serverIds: string[],
  colocated: Set<string>
): Promise<void> {
  const canonical = await resolveColocatedServerId(db)
  if (canonical && serverIds.includes(canonical)) {
    colocated.add(canonical)
  }
}

async function addDirectProjectionIds(
  db: Db,
  serverIds: string[],
  colocated: Set<string>,
  preloaded?: PreloadedFleetPresenceData
): Promise<void> {
  const projections = preloaded?.projections ?? (await readProjectionsForServers(db, serverIds))
  for (const id of serverIds) {
    if (projections.get(id)?.remoteAddress === '__direct__') {
      colocated.add(id)
    }
  }
}

async function addLocalMachineKeyIds(
  db: Db,
  serverIds: string[],
  colocated: Set<string>,
  preloaded?: PreloadedFleetPresenceData
): Promise<void> {
  const localMachineKey = await readLocalMachineKey()
  if (!localMachineKey) return

  const rows =
    preloaded?.rows ??
    (await db
      .select({ id: server.id, machineKey: server.machineKey })
      .from(server)
      .where(inArray(server.id, serverIds)))
  for (const row of rows) {
    if (row.machineKey === localMachineKey) {
      colocated.add(row.id)
    }
  }
}

/** Server ids not already marked colocated (self-host pin candidates). */
export function uncolocatedCandidates(serverIds: string[], colocated: Set<string>): string[] {
  return serverIds.filter((id) => !colocated.has(id))
}

async function addSelfHostPinnedIds(
  db: Db,
  serverIds: string[],
  colocated: Set<string>
): Promise<void> {
  const candidates = uncolocatedCandidates(serverIds, colocated)
  if (candidates.length === 0) return

  // Same join as findSystemEnvironmentForServer(…, 'turbopanel').
  const pinned = await db.execute<{ server_id: string }>(sql`
    SELECT DISTINCT e.server_id::text AS server_id
    FROM environment e
    JOIN project p ON p.id = e.project_id
    JOIN workspace w ON w.id = p.workspace_id
    WHERE e.server_id IN (${sql.join(
      candidates.map((id) => sql`${id}::uuid`),
      sql`, `
    )})
      AND w.kind = ${WORKSPACE_KIND_TURBOPANEL}
      AND p.component = ${SELF_HOST_COMPONENT}
  `)
  for (const row of pinned) {
    if (row.server_id) colocated.add(row.server_id)
  }
}

/** Server ids for daemons co-located with this control plane. */
export async function resolveColocatedServerIdSet(
  db: Db,
  _registry: DaemonCellRegistry | undefined,
  serverIds: string[],
  options: ResolveColocatedServerIdSetOptions = {}
): Promise<Set<string>> {
  const colocated = new Set<string>()
  if (serverIds.length > 0) {
    await fillColocatedServerIds(db, serverIds, colocated, options)
  }
  return colocated
}

async function fillColocatedServerIds(
  db: Db,
  serverIds: string[],
  colocated: Set<string>,
  options: ResolveColocatedServerIdSetOptions
): Promise<void> {
  if (!options.orgScoped) {
    await addCanonicalColocatedId(db, serverIds, colocated)
  }

  await addDirectProjectionIds(db, serverIds, colocated, options.preloaded)
  await addLocalMachineKeyIds(db, serverIds, colocated, options.preloaded)

  if (options.includeSelfHostPin) {
    await addSelfHostPinnedIds(db, serverIds, colocated)
  }
}

/** Error code for a tunnel token push to a server that is not co-located. */
export const TUNNEL_TOKEN_COLOCATED_ONLY = 'tunnel_token_colocated_only'

export type InstanceTunnelGuard =
  { ok: true } | { ok: false; status: 403; code: typeof TUNNEL_TOKEN_COLOCATED_ONLY; error: string }

/**
 * The control plane's own tunnel token goes only to the daemon on its host.
 * Every `tunnel-token` sender calls this before enqueueing the request.
 *
 * `orgScoped` skips the canonical lookup on purpose: its last fallbacks (the
 * hostname, "the single unassigned server") can name a remote server, and
 * that is the same resolver the sender used to pick `serverId`. What remains
 * is the direct Unix socket attach, this host's machine key and the
 * self-host environment pin, which a remote server never carries.
 */
export async function assertColocatedForInstanceTunnel(
  db: Db,
  registry: DaemonCellRegistry | undefined,
  serverId: string
): Promise<InstanceTunnelGuard> {
  const colocated = await resolveColocatedServerIdSet(db, registry, [serverId], {
    orgScoped: true,
    includeSelfHostPin: true,
  })
  if (colocated.has(serverId)) return { ok: true }
  return {
    ok: false,
    status: 403,
    code: TUNNEL_TOKEN_COLOCATED_ONLY,
    error: 'The control plane tunnel runs only on the control plane host',
  }
}

export function isColocatedWithInstance(serverId: string, colocatedIds: Set<string>): boolean {
  return colocatedIds.has(serverId)
}

/**
 * True when this server holds the install-wizard reserved license
 * (`COLOCATED_SERVER_DISPLAY_NAME`) that is still active. Safety fallback for
 * server delete before the self-host environment pin exists.
 */
export async function hasActiveColocatedLicenseBinding(
  db: Db,
  organizationId: string,
  serverId: string
): Promise<boolean> {
  const rows = await db
    .select({ id: license.id })
    .from(license)
    .where(
      and(
        eq(license.organizationId, organizationId),
        eq(license.serverId, serverId),
        eq(license.name, COLOCATED_SERVER_DISPLAY_NAME),
        isNull(license.revokedAt)
      )
    )
    .limit(1)
  return rows.length > 0
}
