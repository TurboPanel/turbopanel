/**
 * Effective host exposure of a server's shared ProxySQL frontend.
 *
 * One ProxySQL runs per host and fronts **every** managed cluster placed on it
 * (members) plus every cluster a service on it is bound to (consumers). It
 * publishes one pair of listener ports, on one set of host addresses, for all
 * of them — ProxySQL has no per-user source ACL and Docker cannot publish a
 * port for some frontend users and not others.
 *
 * Two consequences, and this module is the single place both are derived from
 * so the reconcile decision and the connection surface cannot drift:
 *
 *  1. **Zero enabled clusters → no publish at all.** The empty union is what
 *     `decideIngressBindScopes` turns into `{ kind: 'omit' }`, and the daemon
 *     turns into a compose file with no `ports:`. This is the enforcement for
 *     the exposure toggle today; there is no host firewall yet.
 *  2. **One enabled cluster publishes for its co-residents too.** A cluster
 *     whose own `exposure.enabled` is false is still reachable on the published
 *     address when it shares a host with an exposed cluster. That is a real
 *     property of the shared listener, not a display bug, so the connection
 *     surface reports it (`viaCoResidentCluster`) rather than claiming the
 *     cluster is unreachable. Narrowing it further needs per-cluster
 *     enforcement the shared frontend cannot express today — a per-cluster
 *     published port, or a host firewall keyed on `settings.exposure`.
 */

import { eq, inArray } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import { managed, replica, server } from '../../lib/db/schema.ts'
import {
  DEFAULT_MANAGED_SQL_ACCESS_SCOPE,
  type ManagedSqlAccessScope,
} from '../../lib/managed/access-scope.ts'
import { getManagedEngineSpec } from '../../lib/managed/index.ts'
import type { ManagedSettings } from '../../lib/managed/settings.ts'
import type { ManagedEngineCode } from '../../lib/managed/types.ts'
import { unionExposureScopes } from './ingress-desired-pure.ts'
import { loadBoundManagedIdsForServer } from './ingress-bound-consumers.ts'
import { parseManagedRowOptions } from './options.ts'

export { loadBoundManagedIdsForServer } from './ingress-bound-consumers.ts'

/** The scope a cluster asks for, or `undefined` when it asks for no publish. */
export function requestedExposureScope(
  exposure: ManagedSettings['exposure'],
): ManagedSqlAccessScope | undefined {
  if (!exposure.enabled) return undefined
  return exposure.scope ?? DEFAULT_MANAGED_SQL_ACCESS_SCOPE
}

/**
 * Pure union of what a host's clusters ask for, widest first.
 *
 * Empty means no cluster wants a host publish — the frontend publishes nothing.
 * Callers that already hold the parsed settings (the reconcile builder) use this
 * directly; callers that only know a server id use
 * {@link loadHostExposureScopes}.
 */
export function hostExposureScopes(
  exposures: readonly ManagedSettings['exposure'][],
): ManagedSqlAccessScope[] {
  return unionExposureScopes(exposures.map(requestedExposureScope))
}

/**
 * Every managed cluster this server's ProxySQL fronts: co-resident members
 * plus clusters bound by services placed here.
 *
 * Mirrors the set `buildManagedIngressReconcileDesired` reconciles — the
 * published listener serves exactly these clusters.
 */
async function loadFrontedManagedIds(
  db: Db,
  serverId: string,
): Promise<string[]> {
  const memberRows = await db
    .select({ managedId: replica.managedId })
    .from(replica)
    .where(eq(replica.serverId, serverId))

  // Server-owner org, matching the reconcile builder: one ProxySQL per host
  // belongs to the org that owns the host, whoever placed clusters on it.
  const [serverRow] = await db
    .select({ organizationId: server.organizationId })
    .from(server)
    .where(eq(server.id, serverId))
    .limit(1)

  const organizationId = serverRow?.organizationId
  const ids = new Set(memberRows.map((row) => row.managedId))
  if (organizationId) {
    for (
      const boundId of await loadBoundManagedIdsForServer(
        db,
        serverId,
        organizationId,
      )
    ) {
      ids.add(boundId)
    }
  }
  return [...ids]
}

/**
 * Union of the exposure scopes every cluster on `serverId` asks for.
 *
 * This is what the host actually publishes, so it is also what a client can
 * actually dial — for every cluster the frontend serves, exposed or not.
 */
export async function loadHostExposureScopes(
  db: Db,
  serverId: string,
): Promise<ManagedSqlAccessScope[]> {
  const managedIds = await loadFrontedManagedIds(db, serverId)
  if (managedIds.length === 0) return []

  const rows = await db
    .select({
      id: managed.id,
      engine: managed.engine,
      options: managed.options,
    })
    .from(managed)
    .where(inArray(managed.id, managedIds))

  const exposures: ManagedSettings['exposure'][] = []
  for (const row of rows) {
    const spec = getManagedEngineSpec((row.engine ?? 'postgres') as ManagedEngineCode)
    if (!spec) continue
    const parsed = parseManagedRowOptions(spec, row.options)
    exposures.push(parsed?.settings.exposure ?? spec.defaultSettings.exposure)
  }
  return hostExposureScopes(exposures)
}

/**
 * What a client can really reach for one cluster, versus what its own settings
 * asked for.
 *
 * `published` is the honest answer to "is there a host listener in front of this
 * cluster": it is true whenever *any* cluster on the host is exposed, because
 * the listener is shared. `viaCoResidentCluster` marks the case worth telling an
 * operator about — this cluster's own toggle is off, and it is reachable anyway.
 */
export type ManagedEffectiveExposure = {
  /** The cluster's own recorded intent (`settings.exposure.enabled`). */
  requested: boolean
  /** A host listener publishes in front of this cluster. */
  published: boolean
  /** Scopes the shared listener covers, widest first; empty when unpublished. */
  scopes: ManagedSqlAccessScope[]
  /** Published only because a co-resident cluster asked for it. */
  viaCoResidentCluster: boolean
}

export async function resolveManagedEffectiveExposure(
  db: Db,
  params: Readonly<{
    serverId: string
    exposure: ManagedSettings['exposure']
  }>,
): Promise<ManagedEffectiveExposure> {
  const scopes = await loadHostExposureScopes(db, params.serverId)
  const requested = params.exposure.enabled
  return {
    requested,
    published: scopes.length > 0,
    scopes,
    viaCoResidentCluster: !requested && scopes.length > 0,
  }
}
