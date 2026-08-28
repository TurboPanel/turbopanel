/**
 * Where a managed SQL client may reach a cluster.
 *
 * This is deliberately **not** the generic `HostingBindScope`: HTTP hostings
 * rank `local < datacenter < public`, while managed SQL also has a TurboFabric
 * path, and the four values here resolve to four *different addresses* on the
 * shared ProxySQL frontend rather than a widening ladder.
 *
 * | Scope         | Client path                                                     |
 * | ------------- | --------------------------------------------------------------- |
 * | `local`       | loopback + the org managed network / spanning segments only     |
 * | `datacenter`  | ProxySQL published on the server's datacenter private address   |
 * | `turbofabric` | ProxySQL published on the server's TurboFabric (`tp0`) address  |
 * | `public`      | ProxySQL published on all interfaces                            |
 *
 * Engine members never publish a client listener at any scope — their allocated
 * private port stays a replication/backend transport. Exposure is a property of
 * the ProxySQL frontend only.
 *
 * Replication transport selection is a separate ladder keyed on `replicaClass`
 * (see `src/client/managed/members.ts`); nothing here changes which path a
 * failover replica may replicate over.
 */
export type ManagedSqlAccessScope =
  | 'local'
  | 'datacenter'
  | 'turbofabric'
  | 'public'

/** Narrowest → widest. Also the canonical order for operator-facing lists. */
export const MANAGED_SQL_ACCESS_SCOPES: readonly ManagedSqlAccessScope[] = [
  'local',
  'datacenter',
  'turbofabric',
  'public',
]

/**
 * Scope assumed when a service enables exposure without naming one.
 *
 * `public` keeps the historical meaning of "exposure enabled" (an operator who
 * turned exposure on got an internet-reachable listener), so an omitted scope
 * never silently narrows an already-published cluster. New UI always sends an
 * explicit scope.
 */
export const DEFAULT_MANAGED_SQL_ACCESS_SCOPE: ManagedSqlAccessScope = 'public'

/**
 * Scope of a cluster with exposure **disabled**: no host publish is desired,
 * and the connection panel still has a usable loopback endpoint to show.
 */
export const UNEXPOSED_MANAGED_SQL_ACCESS_SCOPE: ManagedSqlAccessScope = 'local'

const SCOPE_SET = new Set<string>(MANAGED_SQL_ACCESS_SCOPES)

export function isManagedSqlAccessScope(
  value: unknown,
): value is ManagedSqlAccessScope {
  return typeof value === 'string' && SCOPE_SET.has(value)
}

/**
 * Widest wins when picking the single endpoint to advertise as *the* connection
 * (TLS SANs, operator DSN). Publishing is a set — see
 * `decideIngressBindScopes` — so this rank never drops a scope from the bind.
 */
const SCOPE_RANK: Record<ManagedSqlAccessScope, number> = {
  local: 1,
  datacenter: 2,
  turbofabric: 3,
  public: 4,
}

export function managedSqlAccessScopeRank(scope: ManagedSqlAccessScope): number {
  return SCOPE_RANK[scope]
}

/** Widest first, so `[0]` is the operator-facing primary endpoint. */
export function compareManagedSqlAccessScopes(
  a: ManagedSqlAccessScope,
  b: ManagedSqlAccessScope,
): number {
  return SCOPE_RANK[b] - SCOPE_RANK[a]
}

/**
 * Deduplicated scopes, widest first. Every cluster on one host shares a single
 * ProxySQL frontend, so a reconcile publishes the *union* of what its clusters
 * ask for rather than collapsing to the widest one: a `datacenter` cluster and
 * a `turbofabric` cluster want two different addresses, and honoring only the
 * wider one would leave the other's clients with nothing listening.
 */
export function unionManagedSqlAccessScopes(
  scopes: readonly (ManagedSqlAccessScope | undefined)[],
): ManagedSqlAccessScope[] {
  const seen = new Set<ManagedSqlAccessScope>()
  for (const scope of scopes) {
    if (scope === undefined) continue
    seen.add(scope)
  }
  return [...seen].sort(compareManagedSqlAccessScopes)
}

/**
 * `public` is all-interfaces, so it already covers every narrower address.
 * Collapsing then keeps compose from publishing `0.0.0.0` *and* a specific
 * interface for the same port, which Docker rejects as a duplicate binding.
 */
export function collapseManagedSqlAccessScopes(
  scopes: readonly ManagedSqlAccessScope[],
): ManagedSqlAccessScope[] {
  if (scopes.includes('public')) return ['public']
  return [...scopes].sort(compareManagedSqlAccessScopes)
}

const SCOPE_LABELS: Record<ManagedSqlAccessScope, string> = {
  local: 'Local',
  datacenter: 'Datacenter',
  turbofabric: 'TurboFabric',
  public: 'Public',
}

export function managedSqlAccessScopeLabel(scope: ManagedSqlAccessScope): string {
  return SCOPE_LABELS[scope]
}
