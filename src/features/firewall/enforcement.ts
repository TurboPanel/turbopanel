/**
 * The switch that decides whether the control plane may ask a host to load
 * firewall rules.
 *
 * **Fleet-wide the answer is still no.** `FIREWALL_APPLY_ENABLED` stays a
 * source constant `false` until stage 7 (Road row `r2-fw-enable-default-drop`)
 * flips it in code, after the commit-confirm safety net has been proven on a
 * real host (`fw-proof`). Nothing a request, an organization setting or a
 * database row says can turn enforcement on for every server.
 *
 * **One server on purpose, for the host proofs.** A server may be sent
 * `mode: "managed"` before stage 7 only when BOTH keys are turned:
 *  1. the operator names its id in the deploy-time variable
 *     `TURBOPANEL_FIREWALL_APPLY_SERVERS` (comma-separated server UUIDs, at
 *     most {@link FIREWALL_APPLY_SERVERS_MAX}; `*`, `all` or any malformed
 *     entry makes the whole list empty; ignored outright on the hosted live
 *     environment, `TURBOPANEL_ENVIRONMENT=live`), and
 *  2. an owner or manager sets that server's firewall mode to `managed`
 *     (audited as `server.firewall_mode.set`).
 * Either key alone keeps the server observe-only. What the host then does is
 * the daemon's commit-confirm: the root guard is armed before any rule is
 * loaded, the ruleset is pending until `turbopaneld firewall confirm`, and the
 * guard restores the confirmed rules at the deadline. Default drop stays held
 * by the daemon (`DEFAULT_DROP_HELD_WARNING`) whatever is sent.
 *
 * Every sender takes a {@link FirewallApplyGate}; a caller that passes none
 * gets {@link DENY_FIREWALL_APPLY}, which for an opted-in host that already
 * applied means a teardown (`off`), not a quiet observe. A forgotten call site
 * therefore flaps rules; a source-scan test requires every call site to pass one.
 */

import type { FirewallMode } from '../../contracts/commands/schemas.ts'
import type { FirewallModeValue } from './vocabulary.ts'

/** Fleet-wide enforcement. Stage 7 flips this in code; never an env var or a row. */
export const FIREWALL_APPLY_ENABLED = false

/** Deploy-time allowlist of the server ids that may be sent `managed` before stage 7. */
export const FIREWALL_APPLY_SERVERS_ENV = 'TURBOPANEL_FIREWALL_APPLY_SERVERS'

/** A list longer than this is refused whole: the switch is for a proof host, not a fleet. */
export const FIREWALL_APPLY_SERVERS_MAX = 3

/** May this server be sent `managed`? Answers for the deploy-time key only. */
export type FirewallApplyGate = (serverId: string) => boolean

export const DENY_FIREWALL_APPLY: FirewallApplyGate = () => false

const UUID_PATTERN = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/

/**
 * The server ids named by {@link FIREWALL_APPLY_SERVERS_ENV}. Empty unless every
 * entry is a UUID and there are at most {@link FIREWALL_APPLY_SERVERS_MAX}:
 * a wildcard or a typo never widens the switch, it closes it.
 */
export function parseFirewallApplyServers(raw: string | undefined): ReadonlySet<string> {
  const entries = (raw ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== '')
  if (entries.length === 0 || entries.length > FIREWALL_APPLY_SERVERS_MAX) return new Set()
  if (!entries.every((entry) => UUID_PATTERN.test(entry))) return new Set()
  return new Set(entries)
}

/** The hosted environment on which the allowlist is never honored (public production). */
export const FIREWALL_APPLY_REFUSED_ENVIRONMENT = 'live'

/** The deploy-time key read from a runtime's string env (Workers bindings or `Deno.env`). */
export function firewallApplyGateFromEnv(
  env: Readonly<Record<string, string | undefined>> | undefined
): FirewallApplyGate {
  const environment = env?.TURBOPANEL_ENVIRONMENT?.trim().toLowerCase()
  if (environment === FIREWALL_APPLY_REFUSED_ENVIRONMENT) return DENY_FIREWALL_APPLY
  const servers = parseFirewallApplyServers(env?.[FIREWALL_APPLY_SERVERS_ENV])
  if (servers.size === 0) return DENY_FIREWALL_APPLY
  return (serverId) => servers.has(serverId.toLowerCase())
}

/**
 * The mode to put on the wire for a server whose stored mode is `stored`.
 * `observe` unless enforcement is allowed for this server and it asked for
 * `managed`. `off` is never sent as a preview: callers skip servers that are
 * off (or send the teardown, see `preview.ts`).
 */
export function wireModeFor(
  stored: FirewallModeValue,
  applyAllowed: boolean = FIREWALL_APPLY_ENABLED
): FirewallMode {
  return applyAllowed && stored === 'managed' ? 'managed' : 'observe'
}

/** Both keys for one server: fleet-wide stage 7, or this server's deploy-time allowance. */
export function applyAllowedFor(serverId: string, gate: FirewallApplyGate | undefined): boolean {
  return FIREWALL_APPLY_ENABLED || (gate ?? DENY_FIREWALL_APPLY)(serverId)
}
