/**
 * Shared ProxySQL **client** listener ports for managed-database ingress.
 *
 * These are the host/container ports apps and operators dial. Engine-native
 * backend ports (`spec.defaultPort`, 5432 / 3306) are unchanged, and member
 * private listeners stay in {@link MANAGED_PRIVATE_PORT_MIN}–{@link
 * MANAGED_PRIVATE_PORT_MAX}.
 *
 * The two listeners are **per protocol family, per organization** — one shared
 * ProxySQL fronts every managed cluster on a server, so a per-service port
 * would defeat the shared-ingress design. MariaDB deliberately shares the MySQL
 * listener because ProxySQL handles both through its MySQL protocol module;
 * Postgres needs its own listener because that is a separate protocol module,
 * not protocol sniffing on one port.
 *
 * Family is derived from the **engine**, never from the port
 * ({@link managedIngressFamilyForEngine}): once ports are operator-configurable
 * a number no longer identifies a protocol.
 */

export type ManagedIngressFamily = 'pgsql' | 'mysql'

/** Platform defaults when an organization configures nothing. */
export const MANAGED_INGRESS_PGSQL_PORT = 15432
export const MANAGED_INGRESS_MYSQL_PORT = 13306

/**
 * High contiguous host-port range for multi-member private listeners
 * (replication + remote ProxySQL backends). Reserved against listener ports.
 */
export const MANAGED_PRIVATE_PORT_MIN = 45_000
export const MANAGED_PRIVATE_PORT_MAX = 45_999

/** ProxySQL's own admin interfaces — loopback only, never a client listener. */
export const PROXYSQL_ADMIN_PORTS = [6032, 6132] as const

/**
 * Effective client listener ports for one organization. `mysqlFamily` covers
 * both MySQL and MariaDB.
 */
export type ManagedIngressPorts = {
  postgres: number
  mysqlFamily: number
}

export const DEFAULT_MANAGED_INGRESS_PORTS: ManagedIngressPorts = {
  postgres: MANAGED_INGRESS_PGSQL_PORT,
  mysqlFamily: MANAGED_INGRESS_MYSQL_PORT,
}

/**
 * Operator-configurable subset stored on the organization. A missing key
 * inherits the platform default, so `{}` and "unconfigured" are the same thing.
 */
export type ManagedIngressPortsConfig = {
  postgres?: number
  mysqlFamily?: number
}

/**
 * Privileged ports are refused outright rather than preflighted: publishing on
 * 22 / 25 / 80 / 443 would take over a host service, and no managed-SQL client
 * needs a low port.
 */
export const MANAGED_INGRESS_PORT_MIN = 1024
export const MANAGED_INGRESS_PORT_MAX = 65_535

/** Wire `protocolPort` — any operator-selectable client listener port. */
export type ManagedIngressProtocolPort = number // NOSONAR typescript:S6564 — semantic alias for validated listener ports

function isPortInRange(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MANAGED_INGRESS_PORT_MIN &&
    value <= MANAGED_INGRESS_PORT_MAX
  )
}

/**
 * Reasons a port cannot serve as a managed client listener. `collision` is
 * reported by {@link validateManagedIngressPorts} when both families would land
 * on the same number; a *host* listener collision is only knowable on the
 * server and is checked by the daemon before it disrupts ProxySQL.
 */
export type ManagedIngressPortRejection =
  | 'out_of_range'
  | 'reserved_admin'
  | 'reserved_private_range'
  | 'collision'

/**
 * Validate one candidate listener port in isolation (range + platform-reserved
 * numbers). Cross-family collisions need both values — see
 * {@link validateManagedIngressPorts}.
 */
export function rejectManagedIngressPort(
  value: unknown,
): ManagedIngressPortRejection | null {
  if (!isPortInRange(value)) return 'out_of_range'
  if ((PROXYSQL_ADMIN_PORTS as readonly number[]).includes(value)) {
    return 'reserved_admin'
  }
  if (value >= MANAGED_PRIVATE_PORT_MIN && value <= MANAGED_PRIVATE_PORT_MAX) {
    return 'reserved_private_range'
  }
  return null
}

export function isManagedIngressProtocolPort(
  value: unknown,
): value is ManagedIngressProtocolPort {
  return rejectManagedIngressPort(value) === null
}

/**
 * Validate a fully-resolved pair. Returns the first problem found, keyed by the
 * family it belongs to, so the route can name the offending field.
 */
export function validateManagedIngressPorts(
  ports: ManagedIngressPorts,
):
  | { ok: true }
  | {
    ok: false
    field: keyof ManagedIngressPorts
    reason: ManagedIngressPortRejection
  } {
  for (const field of ['postgres', 'mysqlFamily'] as const) {
    const reason = rejectManagedIngressPort(ports[field])
    if (reason) return { ok: false, field, reason }
  }
  if (ports.postgres === ports.mysqlFamily) {
    // Two protocol modules cannot share a listener; ProxySQL would fail to bind
    // the second one and the whole ingress would come up half-configured.
    return { ok: false, field: 'mysqlFamily', reason: 'collision' }
  }
  return { ok: true }
}

/**
 * Merge a stored config over the platform defaults. Invalid stored values are
 * ignored (read path over jsonb — a bad key must not make the org's managed
 * surface unreadable); request bodies are rejected by the PUT route instead.
 */
export function resolveManagedIngressPorts(
  config: ManagedIngressPortsConfig | null | undefined,
): ManagedIngressPorts {
  const resolved = { ...DEFAULT_MANAGED_INGRESS_PORTS }
  if (!config) return resolved
  if (rejectManagedIngressPort(config.postgres) === null) {
    resolved.postgres = config.postgres as number
  }
  if (rejectManagedIngressPort(config.mysqlFamily) === null) {
    resolved.mysqlFamily = config.mysqlFamily as number
  }
  // A stored pair that collides falls back wholesale rather than picking a
  // winner — half-applied ports are worse than the documented defaults.
  return validateManagedIngressPorts(resolved).ok ? resolved : { ...DEFAULT_MANAGED_INGRESS_PORTS }
}

/**
 * Protocol family for an engine. MySQL and MariaDB share ProxySQL's MySQL
 * module; everything else is Postgres. `defaultPort` is the engine-native
 * backend port and only participates as a fallback for engine codes this
 * control plane does not recognize (version skew against a newer daemon).
 */
export function managedIngressFamilyForEngine(
  engine: string,
  defaultPort: number,
): ManagedIngressFamily {
  if (engine === 'mysql' || engine === 'mariadb') return 'mysql'
  if (engine === 'postgres') return 'pgsql'
  return defaultPort === 3306 ? 'mysql' : 'pgsql'
}

/** Client listener port an engine's clusters are reachable on. */
export function managedIngressPortForEngine(
  engine: string,
  defaultPort: number,
  ports: ManagedIngressPorts = DEFAULT_MANAGED_INGRESS_PORTS,
): number {
  return managedIngressFamilyForEngine(engine, defaultPort) === 'mysql'
    ? ports.mysqlFamily
    : ports.postgres
}
