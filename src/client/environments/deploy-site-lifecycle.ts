/**
 * A PHP site's post-deploy commands and background workers on the deploy wire.
 *
 * They are authored as service options (`postDeployCommands`, `workers`, see
 * `features/projects/site-lifecycle-options.ts`) and translated here: each
 * command line becomes argv through the same rule scheduled jobs use, and a
 * worker's memory limit in megabytes becomes bytes. Anything that fails the
 * rule is dropped, because saving the options already refused it with the
 * reason.
 *
 * A daemon that does not list `site-php-lifecycle-v1` would refuse the whole
 * environment deploy at parse time, so a site that carries commands or workers
 * is refused first, naming the server, and nothing is sent. A site without
 * them deploys as before. Post-deploy commands can run again when a deploy is
 * retried, so they should be safe to run more than once.
 */
import type {
  EnvironmentDeploySite,
  EnvironmentDeploySitePostDeploy,
  EnvironmentDeploySiteWorker,
} from '../../contracts/commands/schemas.ts'
import { parseCronCommand } from '../../features/deploy/cron.ts'
import type { ServiceOptions } from '../../features/projects/service-options.ts'
import { hasSiteLifecycle } from '../../features/projects/site-lifecycle-options.ts'
import { SITE_PHP_LIFECYCLE_FEATURE } from '../../lib/version-wire.ts'

export type SiteLifecycleWire = {
  postDeploy?: EnvironmentDeploySitePostDeploy
  workers?: EnvironmentDeploySiteWorker[]
}

export type SiteLifecycleUnsupportedError = {
  kind: 'site_lifecycle_unsupported'
  message: string
  /** The servers whose daemon lacks `site-php-lifecycle-v1`. */
  servers: Array<{ serverId: string; name: string }>
}

const BYTES_PER_MEGABYTE = 1024 * 1024

function argvOf(line: string): string[] | null {
  const parsed = parseCronCommand(line)
  return parsed.ok ? parsed.value : null
}

function renderPostDeploy(
  options: ServiceOptions,
  sourceKind: EnvironmentDeploySite['sourceKind']
): EnvironmentDeploySitePostDeploy | undefined {
  // A managed directory has no release for a command to run in.
  if (sourceKind === 'managed-directory') return undefined
  const commands = (options.postDeployCommands ?? [])
    .map(argvOf)
    .filter((argv): argv is string[] => argv !== null)
  if (commands.length === 0) return undefined
  return {
    commands,
    ...(options.postDeployTimeoutSeconds === undefined
      ? {}
      : { timeoutSeconds: options.postDeployTimeoutSeconds }),
    ...(options.postDeployTiming === undefined ? {} : { timing: options.postDeployTiming }),
  }
}

function renderWorkers(options: ServiceOptions): EnvironmentDeploySiteWorker[] {
  const workers: EnvironmentDeploySiteWorker[] = []
  for (const worker of options.workers ?? []) {
    if (worker.enabled === false) continue
    const command = argvOf(worker.command)
    if (command === null) continue
    workers.push({
      name: worker.name,
      command,
      ...(worker.processes === undefined ? {} : { processes: worker.processes }),
      ...(worker.stopTimeoutSeconds === undefined
        ? {}
        : { stopTimeoutSeconds: worker.stopTimeoutSeconds }),
      ...(worker.memoryMb === undefined
        ? {}
        : { memoryMaxBytes: worker.memoryMb * BYTES_PER_MEGABYTE }),
    })
  }
  return workers
}

/** The wire fields for one site; empty when the site has nothing to run, so its payload is unchanged. */
export function renderSiteLifecycleForDeploy(
  options: ServiceOptions | null | undefined,
  sourceKind: EnvironmentDeploySite['sourceKind']
): SiteLifecycleWire {
  if (!options || !hasSiteLifecycle(options)) return {}
  const postDeploy = renderPostDeploy(options, sourceKind)
  const workers = renderWorkers(options)
  return {
    ...(postDeploy ? { postDeploy } : {}),
    ...(workers.length > 0 ? { workers } : {}),
  }
}

/** Commands and workers run as the site's account, never as root: true when there is something to run but nobody to run it as. */
export function siteLifecycleUnowned(wire: SiteLifecycleWire, hasPrincipal: boolean): boolean {
  return !hasPrincipal && sitesCarryLifecycle([wire])
}

/** True when any site in the list carries commands or workers. */
export function sitesCarryLifecycle(
  sites: ReadonlyArray<Pick<EnvironmentDeploySite, 'postDeploy' | 'workers'>>
): boolean {
  return sites.some((site) => site.postDeploy !== undefined || (site.workers?.length ?? 0) > 0)
}

/** The refusal for a daemon without the feature, or undefined when nothing needs it or it is there. */
export function siteLifecycleUnsupported(
  sites: ReadonlyArray<Pick<EnvironmentDeploySite, 'postDeploy' | 'workers'>>,
  features: readonly string[],
  server: { serverId: string; name: string }
): SiteLifecycleUnsupportedError | undefined {
  if (!sitesCarryLifecycle(sites) || features.includes(SITE_PHP_LIFECYCLE_FEATURE)) {
    return undefined
  }
  return {
    kind: 'site_lifecycle_unsupported',
    message: `The daemon on ${server.name} is too old to run post-deploy commands and background workers. Update the server, then deploy again.`,
    servers: [server],
  }
}
