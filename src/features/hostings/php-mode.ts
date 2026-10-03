/**
 * PHP mode policy: which modes an organization and a server offer, which
 * modes a site's web server can run, and the mode a site gets when it names
 * none.
 *
 * Policy lives in `organization.options.phpModes` and `server.options.phpModes`
 * (managers and owners set both). Unset means every mode is offered. A site
 * may use a mode only when its organization, its server and its engine all
 * allow it. Narrowing a policy never breaks a running site: the mode it
 * already runs is kept, and the policy routes list it as affected.
 *
 * There are no hosting-plan limits here on purpose: a plan sizes servers, it
 * says nothing about what they host.
 */

import { isPhpMode, PHP_MODES, type PhpMode } from '../../contracts/commands/schemas.ts'
import type { SiteEngine } from '../compose/service-kind.ts'

export { isPhpMode, PHP_MODES, type PhpMode }

/**
 * Modes each web server can run. Caddy sites get no PHP mode; nginx and
 * Apache reach PHP over FastCGI; OpenLiteSpeed can also run lsphp.
 */
export const ENGINE_PHP_MODES: Readonly<Record<SiteEngine, readonly PhpMode[]>> = {
  caddy: [],
  nginx: ['fastcgi', 'fpm'],
  apache: ['fastcgi', 'fpm'],
  openlitespeed: PHP_MODES,
}

/** The default for a new PHP site, then its fallbacks. Attached lsphp is never automatic. */
export const PHP_MODE_DEFAULT_ORDER: readonly PhpMode[] = ['fastcgi', 'fpm', 'lsphp-detached']

/**
 * What a daemon that does not advertise `php-site-modes-v1` runs every PHP
 * site on: one shared php-fpm pool. It is the only mode such a daemon is sent.
 */
export const SHARED_POOL_PHP_MODE: PhpMode = 'fpm'

/** Stored policy list: deduplicated in canonical order; anything else reads as unset. */
export function parsePhpModes(value: unknown): PhpMode[] | undefined {
  if (!Array.isArray(value)) return undefined
  const wanted = new Set(value.filter(isPhpMode))
  return PHP_MODES.filter((mode) => wanted.has(mode))
}

/**
 * A policy PUT value: a list of known modes, or `null` to offer every mode
 * again. Unknown entries are refused rather than dropped.
 */
export function parsePhpModesInput(
  value: unknown
): { ok: true; value: PhpMode[] | null } | { ok: false } {
  if (value === null) return { ok: true, value: null }
  if (!Array.isArray(value) || !value.every(isPhpMode)) return { ok: false }
  return { ok: true, value: parsePhpModes(value) ?? [] }
}

export type PhpModePolicy = {
  /** `organization.options.phpModes`; undefined offers every mode. */
  organization?: readonly PhpMode[]
  /** `server.options.phpModes`; undefined offers every mode. */
  server?: readonly PhpMode[]
}

function offers(list: readonly PhpMode[] | undefined, mode: PhpMode): boolean {
  return list === undefined || list.includes(mode)
}

/** Modes a site on this engine may pick under this policy, in canonical order. */
export function allowedPhpModes(policy: PhpModePolicy, engine: SiteEngine): PhpMode[] {
  return ENGINE_PHP_MODES[engine].filter(
    (mode) => offers(policy.organization, mode) && offers(policy.server, mode)
  )
}

/** The mode a new PHP site gets: FastCGI, else php-fpm, else detached lsphp. */
export function defaultPhpMode(allowed: readonly PhpMode[]): PhpMode | undefined {
  return PHP_MODE_DEFAULT_ORDER.find((mode) => allowed.includes(mode))
}

export type PhpModeRefusal =
  'engine_unsupported' | 'not_allowed' | 'none_allowed' | 'daemon_unsupported'

export type SitePhpModeDecision =
  /** `kept`: the policy no longer offers this mode, but the site already runs it. */
  | { ok: true; mode: PhpMode; kept: boolean }
  | { ok: false; reason: PhpModeRefusal; mode?: PhpMode; allowed: PhpMode[] }

/**
 * Decide one PHP site's mode.
 *
 * `authored` is what the site asks for (`x-turbopanel.php.mode`), `previous`
 * what it ran on this server last time. A site that asks for nothing keeps
 * its previous mode, or gets the default when it has none. A previous mode
 * the engine cannot run (the site changed engine) is forgotten.
 */
export function decideSitePhpMode(params: {
  engine: SiteEngine
  policy: PhpModePolicy
  authored?: PhpMode
  previous?: PhpMode
}): SitePhpModeDecision {
  const engineModes = ENGINE_PHP_MODES[params.engine]
  const allowed = allowedPhpModes(params.policy, params.engine)
  const previous =
    params.previous && engineModes.includes(params.previous) ? params.previous : undefined
  const wanted = params.authored ?? previous
  if (wanted === undefined) {
    const mode = defaultPhpMode(allowed)
    return mode ? { ok: true, mode, kept: false } : { ok: false, reason: 'none_allowed', allowed }
  }
  if (!engineModes.includes(wanted)) {
    return { ok: false, reason: 'engine_unsupported', mode: wanted, allowed }
  }
  if (allowed.includes(wanted)) return { ok: true, mode: wanted, kept: false }
  if (wanted === previous) return { ok: true, mode: wanted, kept: true }
  return { ok: false, reason: 'not_allowed', mode: wanted, allowed }
}

/** One site whose recorded mode a policy no longer offers. */
export type PhpModeAffectedSite = {
  environmentId: string
  serverId: string
  composeServiceName: string
  mode: PhpMode
}

/** `deployment.options.phpModes`: compose service name to the mode it was deployed with. */
export function parseRecordedPhpModes(value: unknown): Map<string, PhpMode> {
  const recorded = new Map<string, PhpMode>()
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return recorded
  for (const [name, mode] of Object.entries(value)) {
    if (isPhpMode(mode)) recorded.set(name, mode)
  }
  return recorded
}

/**
 * Sites a policy change would leave on a mode it no longer offers. They are
 * listed, never changed: each keeps its mode until someone picks another.
 */
export function listPhpModeAffectedSites(
  deployments: readonly {
    environmentId: string
    serverId: string
    deploymentOptions: unknown
    policy: PhpModePolicy
  }[]
): PhpModeAffectedSite[] {
  const affected: PhpModeAffectedSite[] = []
  for (const row of deployments) {
    const options = row.deploymentOptions as { phpModes?: unknown } | null
    for (const [composeServiceName, mode] of parseRecordedPhpModes(options?.phpModes)) {
      if (offers(row.policy.organization, mode) && offers(row.policy.server, mode)) continue
      affected.push({
        environmentId: row.environmentId,
        serverId: row.serverId,
        composeServiceName,
        mode,
      })
    }
  }
  return affected
}
