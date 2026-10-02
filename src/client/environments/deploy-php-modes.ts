/**
 * Deploy-time PHP mode resolution for one target server.
 *
 * Every PHP site on the server leaves prepare with `php.mode` set: the mode it
 * asks for (`x-turbopanel.php.mode`), else the one it ran last time, else the
 * default the organization and server allow (FastCGI, then php-fpm, then
 * detached lsphp). See `features/hostings/php-mode.ts`.
 *
 * "Last time" is `deployment.options.phpModes`, which the deploy fan-out
 * records per target. A target deployed before that record existed ran every
 * PHP site on one php-fpm pool, so its sites keep `fpm` until someone picks
 * another mode.
 *
 * Narrowing a policy never breaks a running site: a site whose mode the policy
 * no longer offers keeps it, with a `php_mode_not_allowed` warning. Asking for
 * a mode the policy or the engine refuses is a hard `php_mode_unavailable`.
 */
import { and, eq } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { deployment } from '../../db/schema.ts'
import type { EnvironmentDeploySite } from '../../contracts/commands/schemas.ts'
import type { SiteSpec } from '../../features/compose/site.ts'
import {
  decideSitePhpMode,
  ENGINE_PHP_MODES,
  LEGACY_PHP_MODE,
  parsePhpModes,
  parseRecordedPhpModes,
  type PhpMode,
  type PhpModePolicy,
  type PhpModeRefusal,
} from '../../features/hostings/php-mode.ts'

export type PhpModePrepareError = {
  kind: 'php_mode_unavailable'
  composeServiceName: string
  reason: PhpModeRefusal
  mode?: PhpMode
  allowed: PhpMode[]
}

export type PhpModeWarning = {
  code: 'php_mode_not_allowed'
  message: string
  details: Record<string, unknown>
}

export type SitePhpModeContext = {
  environmentId: string
  serverId: string
  /** Sites scheduled on this server; undefined means all of them. */
  localServiceNames?: ReadonlySet<string>
  /** Authored sites, for the `php.mode` they ask for. */
  specs: readonly SiteSpec[]
  orgOptions: unknown
  serverOptions: unknown
  /** The prepare's warning list; only ever pushed to. */
  warnings: { push(warning: PhpModeWarning): unknown }
}

type PreviousPhpMode = (composeServiceName: string) => PhpMode | undefined

function readPolicyList(options: unknown): PhpMode[] | undefined {
  return parsePhpModes((options as { phpModes?: unknown } | null | undefined)?.phpModes)
}

/** What each site ran on this target last time, from the deploy record. */
export async function loadPreviousPhpModes(
  db: Db,
  environmentId: string,
  serverId: string
): Promise<PreviousPhpMode> {
  const [row] = await db
    .select({ options: deployment.options })
    .from(deployment)
    .where(and(eq(deployment.environmentId, environmentId), eq(deployment.serverId, serverId)))
    .limit(1)
  return previousPhpModesFromRecord(row?.options)
}

export function previousPhpModesFromRecord(options: unknown): PreviousPhpMode {
  if (typeof options !== 'object' || options === null) return () => undefined
  if (!('phpModes' in options)) return () => LEGACY_PHP_MODE
  const recorded = parseRecordedPhpModes(options.phpModes)
  return (name) => recorded.get(name)
}

/** `deployment.options.phpModes` for one prepared target: site name to mode. */
export function recordSitePhpModes(
  sites: readonly EnvironmentDeploySite[] | undefined
): Record<string, PhpMode> {
  const recorded: Record<string, PhpMode> = {}
  for (const site of sites ?? []) {
    if (site.php?.mode) recorded[site.composeServiceName] = site.php.mode
  }
  return recorded
}

type SiteOutcome =
  { site: EnvironmentDeploySite; warning?: PhpModeWarning } | { error: PhpModePrepareError }

function isPhpSite(site: EnvironmentDeploySite, authored: PhpMode | undefined): boolean {
  return authored !== undefined || Object.keys(site.php ?? {}).length > 0
}

export function resolveSitePhpMode(
  site: EnvironmentDeploySite,
  authored: PhpMode | undefined,
  policy: PhpModePolicy,
  previous: PhpMode | undefined
): SiteOutcome {
  if (!isPhpSite(site, authored)) return { site }
  // Caddy has no PHP mode: an unasked site keeps today's behaviour untouched.
  if (ENGINE_PHP_MODES[site.engine].length === 0 && authored === undefined) return { site }

  const decision = decideSitePhpMode({ engine: site.engine, policy, authored, previous })
  const { composeServiceName } = site
  if (!decision.ok) {
    const { reason, mode, allowed } = decision
    const error: PhpModePrepareError = {
      kind: 'php_mode_unavailable',
      composeServiceName,
      reason,
      allowed,
    }
    if (mode) error.mode = mode
    return { error }
  }
  const resolved = { ...site, php: { ...site.php, mode: decision.mode } }
  if (!decision.kept) return { site: resolved }
  return {
    site: resolved,
    warning: {
      code: 'php_mode_not_allowed',
      message: `Site "${composeServiceName}" keeps PHP mode ${decision.mode}, which this organization or server no longer offers.`,
      details: { composeServiceName, mode: decision.mode },
    },
  }
}

/**
 * Stamp `php.mode` on this server's PHP sites. Errors from the stage before
 * pass straight through, so the caller keeps a single check.
 */
export async function withSitePhpModes<E extends { kind: string }>(
  db: Db,
  ctx: SitePhpModeContext,
  sites: EnvironmentDeploySite[] | E
): Promise<EnvironmentDeploySite[] | E | PhpModePrepareError> {
  if ('kind' in sites) return sites
  const authored = new Map(ctx.specs.map((spec) => [spec.composeServiceName, spec.php?.mode]))
  const previousOf = await loadPreviousPhpModes(db, ctx.environmentId, ctx.serverId)
  const policy: PhpModePolicy = {
    organization: readPolicyList(ctx.orgOptions),
    server: readPolicyList(ctx.serverOptions),
  }
  const resolved: EnvironmentDeploySite[] = []
  for (const site of sites) {
    const name = site.composeServiceName
    const local = ctx.localServiceNames?.has(name) ?? true
    const outcome = local
      ? resolveSitePhpMode(site, authored.get(name), policy, previousOf(name))
      : { site }
    if ('error' in outcome) return outcome.error
    if (outcome.warning) ctx.warnings.push(outcome.warning)
    resolved.push(outcome.site)
  }
  return resolved
}
