/**
 * Shared ProxySQL **client** listener ports for managed-database ingress.
 *
 * These are the host/container ports apps and operators dial. Member private
 * listeners stay in 45000–45999, and ProxySQL admin stays `127.0.0.1:6032`.
 * Engine-native backend ports (`spec.defaultPort`, 5432 / 3306) are unchanged.
 */

export const MANAGED_INGRESS_PGSQL_PORT = 15432
export const MANAGED_INGRESS_MYSQL_PORT = 16306

/** Legacy listener ports accepted on the wire for version-skewed daemons. */
export const MANAGED_INGRESS_LEGACY_PGSQL_PORT = 5432
export const MANAGED_INGRESS_LEGACY_MYSQL_PORT = 3306

export const MANAGED_INGRESS_LISTENER_PORTS = [
  MANAGED_INGRESS_PGSQL_PORT,
  MANAGED_INGRESS_MYSQL_PORT,
] as const

export type ManagedIngressListenerPort =
  (typeof MANAGED_INGRESS_LISTENER_PORTS)[number]

/** Wire `protocolPort` — new listeners plus legacy values for skew. */
export type ManagedIngressProtocolPort =
  | typeof MANAGED_INGRESS_PGSQL_PORT
  | typeof MANAGED_INGRESS_MYSQL_PORT
  | typeof MANAGED_INGRESS_LEGACY_PGSQL_PORT
  | typeof MANAGED_INGRESS_LEGACY_MYSQL_PORT

const PROTOCOL_PORTS: readonly ManagedIngressProtocolPort[] = [
  MANAGED_INGRESS_PGSQL_PORT,
  MANAGED_INGRESS_MYSQL_PORT,
  MANAGED_INGRESS_LEGACY_PGSQL_PORT,
  MANAGED_INGRESS_LEGACY_MYSQL_PORT,
]

export function isManagedIngressProtocolPort(
  value: unknown,
): value is ManagedIngressProtocolPort {
  return (
    typeof value === 'number' &&
    (PROTOCOL_PORTS as readonly number[]).includes(value)
  )
}

/**
 * Client listener port for an engine. `3306` / mysql / mariadb → MySQL family;
 * everything else → Postgres family.
 */
export function managedIngressPortForEngine(
  engine: string,
  defaultPort: number,
): ManagedIngressListenerPort {
  if (
    defaultPort === MANAGED_INGRESS_LEGACY_MYSQL_PORT ||
    engine === 'mysql' ||
    engine === 'mariadb'
  ) {
    return MANAGED_INGRESS_MYSQL_PORT
  }
  return MANAGED_INGRESS_PGSQL_PORT
}

/**
 * Protocol family for a wire `protocolPort`. Accepts both the current
 * listeners and the legacy 5432 / 3306 values so a skewed daemon/control-plane
 * pair still routes into the right family.
 */
export function managedIngressFamilyForPort(
  port: number,
): 'pgsql' | 'mysql' | null {
  if (
    port === MANAGED_INGRESS_PGSQL_PORT ||
    port === MANAGED_INGRESS_LEGACY_PGSQL_PORT
  ) {
    return 'pgsql'
  }
  if (
    port === MANAGED_INGRESS_MYSQL_PORT ||
    port === MANAGED_INGRESS_LEGACY_MYSQL_PORT
  ) {
    return 'mysql'
  }
  return null
}
