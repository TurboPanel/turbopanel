/**
 * Organization-wide managed-database defaults, stored under
 * `organization.options.managedDatabase`.
 *
 * These are **inheritance sources**, not applied configuration: a managed
 * service resolves its effective value from its own override first, then this
 * org default, then the platform fallback. Changing an org default therefore
 * only moves services that never set an override — a service-level value always
 * wins.
 */

import {
  DEFAULT_MANAGED_INGRESS_PORTS,
  type ManagedIngressPortRejection,
  type ManagedIngressPortsConfig,
  rejectManagedIngressPort,
  validateManagedIngressPorts,
} from './ingress-ports.ts'
import { type ManagedSslMode, parseManagedSslMode } from './ssl.ts'

export type ManagedOrganizationDefaults = {
  /**
   * Default client TLS policy for managed SQL in this organization. Omitted →
   * platform `require` (see {@link DEFAULT_MANAGED_SSL_MODE}).
   */
  sslMode?: ManagedSslMode
  /**
   * Shared ProxySQL client listener ports. Organization-wide on purpose: one
   * ProxySQL fronts every managed cluster on a server, so these are per protocol
   * family, never per service. Omitted keys inherit the platform defaults.
   */
  ports?: ManagedIngressPortsConfig
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Parse `organization.options.managedDatabase`. Unknown / malformed keys are
 * dropped rather than rejected — this is a read path over stored jsonb, and a
 * single bad key must not make an org's managed surface unreadable. Request
 * bodies are validated by the PUT route instead
 * ({@link parseManagedSslModeInput}).
 */
export function parseManagedOrganizationDefaults(
  value: unknown,
): ManagedOrganizationDefaults {
  if (!isRecord(value)) return {}
  const defaults: ManagedOrganizationDefaults = {}
  const sslMode = parseManagedSslMode(value.sslMode)
  if (sslMode) defaults.sslMode = sslMode
  const ports = parseStoredIngressPorts(value.ports)
  if (ports) defaults.ports = ports
  return defaults
}

/**
 * Keep only individually-valid stored port overrides. A pair that collides is
 * dropped by {@link resolveManagedIngressPorts} at resolve time rather than
 * here, so the stored operator intent survives a read.
 */
function parseStoredIngressPorts(
  value: unknown,
): ManagedIngressPortsConfig | null {
  if (!isRecord(value)) return null
  const ports: ManagedIngressPortsConfig = {}
  if (rejectManagedIngressPort(value.postgres) === null) {
    ports.postgres = value.postgres as number
  }
  if (rejectManagedIngressPort(value.mysqlFamily) === null) {
    ports.mysqlFamily = value.mysqlFamily as number
  }
  return Object.keys(ports).length > 0 ? ports : null
}

/**
 * Parse a `sslMode` PUT body value. `null` clears the org default (services
 * fall back to the platform mode); an unrecognized string is rejected so a typo
 * cannot silently downgrade every inheriting service to plaintext.
 */
export function parseManagedSslModeInput(
  value: unknown,
): { ok: true; value: ManagedSslMode | null } | { ok: false } {
  if (value === null) return { ok: true, value: null }
  const parsed = parseManagedSslMode(value)
  if (!parsed) return { ok: false }
  return { ok: true, value: parsed }
}

/** Per-family patch; `null` on a family clears that override back to platform. */
export type ManagedIngressPortsPatch = {
  postgres?: number | null
  mysqlFamily?: number | null
}

/**
 * Parse a `ports` PUT body value. `null` clears every override; an object
 * patches only the families it names. Unlike the stored read path, an invalid
 * port is rejected rather than dropped — silently ignoring it would report
 * success while leaving clients on the old listener.
 */
export function parseManagedIngressPortsInput(
  value: unknown,
):
  | { ok: true; value: ManagedIngressPortsPatch | null }
  | {
    ok: false
    field?: keyof ManagedIngressPortsPatch
    reason?: ManagedIngressPortRejection
  } {
  if (value === null) return { ok: true, value: null }
  if (!isRecord(value)) return { ok: false }
  const patch: ManagedIngressPortsPatch = {}
  for (const field of ['postgres', 'mysqlFamily'] as const) {
    if (!(field in value)) continue
    if (value[field] === null) {
      patch[field] = null
      continue
    }
    const reason = rejectManagedIngressPort(value[field])
    if (reason) return { ok: false, field, reason }
    patch[field] = value[field] as number
  }
  if (Object.keys(patch).length === 0) return { ok: false }
  return { ok: true, value: patch }
}

/**
 * Post-merge check for a stored defaults object. Individual ports were already
 * validated on the way in, so this only catches cross-family collisions —
 * including the case where one override lands on the *other* family's
 * still-inherited platform default.
 */
export function validateManagedOrganizationDefaults(
  defaults: ManagedOrganizationDefaults,
):
  | { ok: true }
  | { ok: false; field: string; reason: ManagedIngressPortRejection } {
  const check = validateManagedIngressPorts({
    postgres: defaults.ports?.postgres ??
      DEFAULT_MANAGED_INGRESS_PORTS.postgres,
    mysqlFamily: defaults.ports?.mysqlFamily ??
      DEFAULT_MANAGED_INGRESS_PORTS.mysqlFamily,
  })
  if (check.ok) return { ok: true }
  return { ok: false, field: `ports.${check.field}`, reason: check.reason }
}
