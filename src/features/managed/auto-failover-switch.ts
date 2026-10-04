/**
 * Per-deployment switch for automatic failover (`TURBOPANEL_AUTO_FAILOVER`).
 *
 * Read at event time from the runtime's string env (Workers vars or
 * `Deno.env`). `on` / `off` (also `true`/`false`, `1`/`0`) win. Unset or blank
 * falls back to the deployment: off on `staging` / `live`
 * (`TURBOPANEL_ENVIRONMENT`), on everywhere else — testing, local dev and
 * self-hosted Deno keep the original behaviour. Any other value is `off`:
 * a mistyped switch must never promote.
 *
 * Off only stops the automatic fence / promote of an accepted dead-primary
 * event; manual switchover and disaster recovery are unaffected.
 */

import { DEFAULT_FRESH_STANDBY_MARGIN_MS, MAX_FRESH_STANDBY_MARGIN_MS } from './ha-fresh-standby.ts'

export const AUTO_FAILOVER_ENV = 'TURBOPANEL_AUTO_FAILOVER'

export type AutoFailoverSetting = 'on' | 'off'

/**
 * Off: the accepted event is recorded as a terminal `blocked` row with no
 * target (so it never starts the cooldown) and nothing is queued.
 */
export const AUTOMATIC_FAILOVER_DISABLED_REASON = 'auto_failover_disabled'
export const AUTOMATIC_FAILOVER_DISABLED_MESSAGE =
  'Automatic failover not started: it is turned off on this control plane (auto_failover_disabled)'

const ON_VALUES: ReadonlySet<string> = new Set(['on', 'true', '1'])
const OFF_VALUES: ReadonlySet<string> = new Set(['off', 'false', '0'])

/** Deployments where automatic failover is off unless the env says `on`. */
const OFF_BY_DEFAULT_ENVIRONMENTS: ReadonlySet<string> = new Set(['staging', 'live'])

export function resolveAutoFailover(
  env: Readonly<Record<string, string | undefined>> | undefined
): AutoFailoverSetting {
  const raw = env?.[AUTO_FAILOVER_ENV]?.trim().toLowerCase() ?? ''
  if (raw === '') {
    // Same parsing as `resolveDeploymentEnvironment` (app/build-info.ts), which
    // a feature module may not import.
    const deployment = env?.TURBOPANEL_ENVIRONMENT?.trim().toLowerCase() ?? ''
    return OFF_BY_DEFAULT_ENVIRONMENTS.has(deployment) ? 'off' : 'on'
  }
  if (ON_VALUES.has(raw)) return 'on'
  if (OFF_VALUES.has(raw)) return 'off'
  return 'off'
}

type DenoEnvGlobal = { Deno?: { env?: { get(key: string): string | undefined } } }

function denoEnvGet(key: string): string | undefined {
  try {
    return (globalThis as DenoEnvGlobal).Deno?.env?.get(key)
  } catch {
    // No env permission for this key (a narrowed `--allow-env`): treat as unset.
    return undefined
  }
}

/** The switch from `Deno.env` (self-hosted). Unset = `on`. */
export function resolveAutoFailoverFromDenoEnv(): AutoFailoverSetting {
  return resolveAutoFailover({
    [AUTO_FAILOVER_ENV]: denoEnvGet(AUTO_FAILOVER_ENV),
    TURBOPANEL_ENVIRONMENT: denoEnvGet('TURBOPANEL_ENVIRONMENT'),
  })
}

/**
 * `TURBOPANEL_AUTO_FAILOVER_RECEIPT_MARGIN_SECONDS`: how long before the
 * detected failure start a non-streaming standby may have last been seen
 * streaming and still be promoted (`ha-fresh-standby.ts`). Unset, blank or
 * malformed = the 10 s default; capped at 60 s so a typo cannot open the gate
 * wide.
 */
export const FRESH_STANDBY_MARGIN_ENV = 'TURBOPANEL_AUTO_FAILOVER_RECEIPT_MARGIN_SECONDS'

export function resolveFreshStandbyMarginMs(
  env: Readonly<Record<string, string | undefined>> | undefined
): number {
  const raw = env?.[FRESH_STANDBY_MARGIN_ENV]?.trim() ?? ''
  if (!/^\d+(\.\d+)?$/.test(raw)) return DEFAULT_FRESH_STANDBY_MARGIN_MS
  return Math.min(Math.round(Number(raw) * 1000), MAX_FRESH_STANDBY_MARGIN_MS)
}

/** The margin from `Deno.env` (self-hosted). */
export function resolveFreshStandbyMarginMsFromDenoEnv(): number {
  return resolveFreshStandbyMarginMs({
    [FRESH_STANDBY_MARGIN_ENV]: denoEnvGet(FRESH_STANDBY_MARGIN_ENV),
  })
}
