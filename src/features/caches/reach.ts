/**
 * Helper reach: a container that declares `x-turbopanel.reach` publishes one
 * port on `127.0.0.1`, and the host opens that port to one Hosting Account
 * only. The sites and apps named in `from` get `TURBOPANEL_HELPER_<NAME>_HOST`
 * and `_PORT`. Everything here is pure; the deploy prepare step calls it.
 */

import type { EnvironmentDeployHelperReach } from '../../contracts/commands/schemas.ts'
import { allocateSiteListenPort } from '../compose/site.ts'
import { CACHE_PORT_MAX, CACHE_PORT_MIN, MAX_HELPER_REACH_PER_DEPLOY } from './vocabulary.ts'

export type ReachDecl = { service: string; port: number; from: readonly string[] }

export type ReachServiceInfo = {
  kind: string
  principalId: string | undefined
}

export type HelperPlanEntry = {
  /** The service name as authored. */
  origin: string
  /** The container's name in the document the host receives. */
  composeServiceName: string
  containerPort: number
  username: string
  from: readonly string[]
}

export type HelperPlan = { entries: HelperPlanEntry[]; errors: string[] }

const REACH_CONSUMER_KINDS: ReadonlySet<string> = new Set(['site', 'node'])

/** The first problem with one declaration, in plain words, or null. */
function declProblem(
  decl: ReachDecl,
  services: ReadonlyMap<string, ReachServiceInfo>,
  usernameOf: (principalId: string) => string | undefined,
  clones: readonly string[]
): string | null {
  if (clones.length !== 1) {
    return `"${decl.service}" has a reach port, so it must run as one copy`
  }
  const accounts = new Set<string>()
  for (const name of decl.from) {
    const info = services.get(name)
    if (info === undefined || !REACH_CONSUMER_KINDS.has(info.kind)) {
      return `"${name}" is not a site or Node app, so it cannot reach "${decl.service}"`
    }
    if (info.principalId === undefined)
      return `"${name}" has no Hosting Account to open the port to`
    accounts.add(info.principalId)
  }
  if (accounts.size !== 1) {
    return `A helper port opens to one Hosting Account; ${decl.from.join(' and ')} run as different accounts`
  }
  const [only] = [...accounts]
  if (only === undefined || usernameOf(only) === undefined) {
    return `The Hosting Account of ${decl.from.join(' and ')} is not set up yet`
  }
  return null
}

/** Check every declaration and resolve the account each opens to. */
export function planHelperReach(
  decls: readonly ReachDecl[],
  services: ReadonlyMap<string, ReachServiceInfo>,
  usernameOf: (principalId: string) => string | undefined,
  expansion: ReadonlyMap<string, readonly string[]>
): HelperPlan {
  const entries: HelperPlanEntry[] = []
  const errors: string[] = []
  if (decls.length > MAX_HELPER_REACH_PER_DEPLOY) {
    return { entries, errors: [`At most ${MAX_HELPER_REACH_PER_DEPLOY} helper ports per deploy`] }
  }
  for (const decl of decls) {
    const clones = expansion.get(decl.service) ?? [decl.service]
    const problem = declProblem(decl, services, usernameOf, clones)
    if (problem !== null) {
      errors.push(problem)
      continue
    }
    const first = decl.from[0]
    const principalId = first === undefined ? undefined : services.get(first)?.principalId
    const username = principalId === undefined ? undefined : usernameOf(principalId)
    const name = clones[0]
    if (username === undefined || name === undefined) continue
    entries.push({
      origin: decl.service,
      composeServiceName: name,
      containerPort: decl.port,
      username,
      from: decl.from,
    })
  }
  return { entries, errors }
}

export type AllocatedHelperReach = {
  reach: EnvironmentDeployHelperReach[]
  /** Origin service name to host port, recorded so a redeploy keeps it. */
  helperPorts: Record<string, number>
}

function inBand(port: number | undefined): port is number {
  return (
    port !== undefined && Number.isInteger(port) && port >= CACHE_PORT_MIN && port <= CACHE_PORT_MAX
  )
}

/** Give each entry a host port from the listen band, keeping `preferred` when it is free. */
export function allocateHelperPorts(
  entries: readonly HelperPlanEntry[],
  used: Set<number>,
  preferred: Readonly<Record<string, number>>,
  uniqueKey: string
): AllocatedHelperReach {
  const reach: EnvironmentDeployHelperReach[] = []
  const helperPorts: Record<string, number> = {}
  for (const entry of entries) {
    const wanted = preferred[entry.origin]
    const hostPort = allocateSiteListenPort(
      `reach:${entry.origin}`,
      used,
      inBand(wanted) ? wanted : undefined,
      uniqueKey
    )
    reach.push({
      composeServiceName: entry.composeServiceName,
      containerPort: entry.containerPort,
      hostPort,
      username: entry.username,
    })
    helperPorts[entry.origin] = hostPort
  }
  return { reach, helperPorts }
}

/** The `helperPorts` a deploy recorded on its `deployment.options`; empty when absent or malformed. */
export function readRecordedHelperPorts(options: unknown): Record<string, number> {
  if (typeof options !== 'object' || options === null) return {}
  const raw = (options as { helperPorts?: unknown }).helperPorts
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const out: Record<string, number> = {}
  for (const [name, port] of Object.entries(raw)) {
    if (typeof port === 'number' && inBand(port)) out[name] = port
  }
  return out
}

/**
 * Add `127.0.0.1:<hostPort>:<containerPort>` to each reach container's
 * `ports`. Returns the names that are not in the document (a bug upstream).
 */
export function injectHelperPublishes(
  data: Record<string, unknown>,
  reach: readonly EnvironmentDeployHelperReach[]
): string[] {
  const services = data.services
  const missing: string[] = []
  for (const entry of reach) {
    const node =
      typeof services === 'object' && services !== null
        ? (services as Record<string, unknown>)[entry.composeServiceName]
        : undefined
    if (typeof node !== 'object' || node === null || Array.isArray(node)) {
      missing.push(entry.composeServiceName)
      continue
    }
    const target = node as Record<string, unknown>
    const ports = Array.isArray(target.ports) ? [...(target.ports as unknown[])] : []
    ports.push(`127.0.0.1:${entry.hostPort}:${entry.containerPort}`)
    target.ports = ports
  }
  return missing
}

/** `<NAME>` of `TURBOPANEL_HELPER_<NAME>_HOST`: the same rule as `TURBOPANEL_SITE_<SERVICE>_URL`. */
export function helperEnvName(composeServiceName: string): string {
  let sanitized = composeServiceName.replaceAll(/\W/g, '_')
  if (/^\d/.test(sanitized)) sanitized = `_${sanitized}`
  return sanitized.toUpperCase()
}

/** Service name to the plain variables its helpers deliver. */
export function helperVariables(
  entries: readonly HelperPlanEntry[],
  ports: Readonly<Record<string, number>>
): Map<string, Record<string, string>> {
  const out = new Map<string, Record<string, string>>()
  for (const entry of entries) {
    const port = ports[entry.origin]
    if (port === undefined) continue
    const name = helperEnvName(entry.origin)
    for (const consumer of entry.from) {
      const vars = out.get(consumer) ?? {}
      vars[`TURBOPANEL_HELPER_${name}_HOST`] = '127.0.0.1'
      vars[`TURBOPANEL_HELPER_${name}_PORT`] = String(port)
      out.set(consumer, vars)
    }
  }
  return out
}

/** The `cacheConsumers` a deploy recorded on its `deployment.options`: service name to cache ids. */
export function readRecordedCacheConsumers(options: unknown): Record<string, string[]> {
  if (typeof options !== 'object' || options === null) return {}
  const raw = (options as { cacheConsumers?: unknown }).cacheConsumers
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const out: Record<string, string[]> = {}
  for (const [name, ids] of Object.entries(raw)) {
    if (Array.isArray(ids)) out[name] = ids.filter((id): id is string => typeof id === 'string')
  }
  return out
}
