/**
 * Managed-SQL client TLS policy.
 *
 * `ManagedSslMode` is a **client-facing** policy at the ProxySQL boundary, not
 * a switch for engine TLS. The backend leg (ProxySQL → engine) is always
 * encrypted: ProxySQL server rows are rendered `use_ssl=1`, Postgres
 * `pg_hba.conf` only publishes `hostssl` rules, and MySQL/MariaDB set
 * `require_secure_transport=ON`. Engine TLS material is therefore
 * unconditional, and this mode decides only two things:
 *
 * 1. **Frontend enforcement** — whether ProxySQL rejects a plaintext client
 *    session (`mysql_users.use_ssl` / `pgsql_users.use_ssl`, which is
 *    `REQUIRE SSL` semantics: encrypted socket, no client certificate).
 * 2. **DSN rendering** — which verification behavior we hand a driver.
 *
 * Certificate *verification* (`verify-ca` / `verify-full`) is a client-side
 * decision about the server certificate; ProxySQL cannot enforce it, so those
 * modes differ from `require` only in what the connection string says. They
 * are usable because the org CA is downloadable from the managed Connect
 * surface.
 *
 * Resolution order: managed-service override → organization default →
 * {@link DEFAULT_MANAGED_SSL_MODE}.
 */

/** Ordered weakest → strongest; UI pickers may render in this order. */
export const MANAGED_SSL_MODES = [
  'disable',
  'allow',
  'prefer',
  'require',
  'verify-ca',
  'verify-full',
] as const

export type ManagedSslMode = (typeof MANAGED_SSL_MODES)[number]

/** Platform fallback when neither the service nor the org configures a mode. */
export const DEFAULT_MANAGED_SSL_MODE: ManagedSslMode = 'require'

export function isManagedSslMode(value: unknown): value is ManagedSslMode {
  return typeof value === 'string' &&
    (MANAGED_SSL_MODES as readonly string[]).includes(value)
}

/**
 * Parse a stored / request-body mode. `undefined` means "not configured"
 * (inherit); anything unrecognized is `null` (reject) so a typo can never
 * silently downgrade to plaintext.
 */
export function parseManagedSslMode(
  value: unknown,
): ManagedSslMode | null | undefined {
  if (value === undefined) return undefined
  if (!isManagedSslMode(value)) return null
  return value
}

/** Effective mode for a cluster: service override → org default → platform. */
export function resolveManagedSslMode(
  configured: ManagedSslMode | undefined,
  organizationDefault?: ManagedSslMode | undefined,
): ManagedSslMode {
  return configured ?? organizationDefault ?? DEFAULT_MANAGED_SSL_MODE
}

/**
 * True when ProxySQL must refuse an unencrypted client session. `allow` and
 * `prefer` both leave TLS available but optional — the difference between them
 * is only what the DSN asks the driver to attempt first.
 */
export function managedSslRequiresTls(mode: ManagedSslMode): boolean {
  return mode === 'require' || mode === 'verify-ca' || mode === 'verify-full'
}

/** True when the client is told to validate the server certificate chain. */
export function managedSslVerifiesServer(mode: ManagedSslMode): boolean {
  return mode === 'verify-ca' || mode === 'verify-full'
}

/**
 * MySQL-family `ssl-mode` spelling. MySQL has no separate "try plaintext
 * first" value, so `allow` and `prefer` both land on `PREFERRED`, and
 * hostname verification is spelled `VERIFY_IDENTITY` rather than
 * `verify-full`.
 */
export function mysqlFamilySslMode(mode: ManagedSslMode): string {
  switch (mode) {
    case 'disable':
      return 'DISABLED'
    case 'allow':
    case 'prefer':
      return 'PREFERRED'
    case 'require':
      return 'REQUIRED'
    case 'verify-ca':
      return 'VERIFY_CA'
    case 'verify-full':
      return 'VERIFY_IDENTITY'
  }
}
