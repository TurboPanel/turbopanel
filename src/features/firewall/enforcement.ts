/**
 * The one switch that decides whether the control plane may ever ask a host to
 * load firewall rules.
 *
 * Until stage 7 (Road row `r2-fw-enable-default-drop`) the answer is no: every
 * `server.firewall.reconcile` the control plane sends is a PREVIEW (`mode:
 * "observe"`: the host renders and checks the rules and loads nothing),
 * whatever a server's stored mode says, so `managed` behaves exactly like
 * `observe`. Stage 7 flips this constant in code, after the commit-confirm
 * safety net has been proven on a real host (`fw-proof`). It is deliberately a
 * source constant: nothing a request, an organization setting or a database row
 * says can turn enforcement on.
 */

import type { FirewallMode } from '../../contracts/commands/schemas.ts'
import type { FirewallModeValue } from './vocabulary.ts'

export const FIREWALL_APPLY_ENABLED = false

/**
 * The mode to put on the wire for a server whose stored mode is `stored`.
 * `observe` unless enforcement is enabled and the server asked for `managed`.
 * `off` is never sent as a preview: callers skip servers that are off.
 */
export function wireModeFor(
  stored: FirewallModeValue,
  applyEnabled: boolean = FIREWALL_APPLY_ENABLED
): FirewallMode {
  return applyEnabled && stored === 'managed' ? 'managed' : 'observe'
}
