/**
 * Organization-level container-log settings.
 *
 * Exactly one knob: whether this organization retains container output. It is
 * deliberately **not** a cascade (`../host-defaults.ts` style server →
 * datacenter → organization): retention is billed and stored per tenant, so
 * there is no lower layer that could sensibly override it and no default worth
 * inheriting. Retention length is the platform-wide
 * {@link CONTAINER_LOG_RETENTION_DAYS}; a per-org override is not part of this
 * phase.
 *
 * The resolved value rides the daemon presence ack (`presence-ack`
 * `containerLogsEnabled`), which is what starts and stops the daemon's
 * collector — see `../../daemon/AGENTS.md` and
 * `../../../../turbopaneld/src/logs/container-collector.ts`.
 */

import { CONTAINER_LOG_RETENTION_DAYS } from './types.ts'

/** The `organization.options` subset this module owns. */
export type ContainerLogOrganizationSettings = {
  /** Opt-in retention switch. Absent → off. */
  containerLogsEnabled?: boolean
}

/**
 * Parse a `containerLogsEnabled` PUT value.
 *
 * `null` clears the option (back to the platform default, which is off);
 * anything other than a boolean is rejected rather than coerced — a truthy
 * string here would silently turn on a billed feature.
 */
export function parseContainerLogsEnabledInput(
  value: unknown
): { ok: true; value: boolean | null } | { ok: false } {
  if (value === null) return { ok: true, value: null }
  if (typeof value !== 'boolean') return { ok: false }
  return { ok: true, value }
}

/** Resolved switch for an organization. Default-off, always. */
export function resolveContainerLogsEnabled(
  options: ContainerLogOrganizationSettings | null | undefined
): boolean {
  return options?.containerLogsEnabled === true
}

/** Response body shared by the settings GET and PUT routes. */
export function containerLogSettingsResponse(
  options: ContainerLogOrganizationSettings | null | undefined
): { containerLogsEnabled: boolean; retentionDays: number } {
  return {
    containerLogsEnabled: resolveContainerLogsEnabled(options),
    retentionDays: CONTAINER_LOG_RETENTION_DAYS,
  }
}
