/**
 * Which services of an environment get which cache's variables: the sites and
 * `node` apps that run as the cache's Hosting Account, on the cache's server.
 * Pure; the caller supplies each service's resolved account.
 */

export type CacheConsumerService = {
  name: string
  /** `container`, `site` or `node`. */
  kind: string
  /** The Hosting Account the service runs as, or undefined when it has none. */
  principalId: string | undefined
}

export type CacheConsumerCache = { id: string; serverId: string; principalId: string }

export type CacheConsumerWarning = {
  code: 'cache_other_account' | 'cache_other_server'
  composeServiceName: string
}

export type CacheConsumerResult = {
  /** Compose service name to the cache ids it gets, in cache order. */
  consumers: Map<string, string[]>
  warnings: CacheConsumerWarning[]
}

const CONSUMER_KINDS: ReadonlySet<string> = new Set(['site', 'node'])

/** `consumers` for `serverId`; a container never gets a cache in this release. */
export function cacheConsumers(
  services: readonly CacheConsumerService[],
  caches: readonly CacheConsumerCache[],
  serverId: string
): CacheConsumerResult {
  const consumers = new Map<string, string[]>()
  const warnings: CacheConsumerWarning[] = []
  if (caches.length === 0) return { consumers, warnings }
  for (const svc of services) {
    if (!CONSUMER_KINDS.has(svc.kind)) continue
    const mine = caches.filter((entry) => entry.principalId === svc.principalId)
    const local = mine.filter((entry) => entry.serverId === serverId)
    if (local.length > 0) {
      consumers.set(
        svc.name,
        local.map((entry) => entry.id)
      )
    } else if (mine.length > 0) {
      warnings.push({ code: 'cache_other_server', composeServiceName: svc.name })
    } else {
      warnings.push({ code: 'cache_other_account', composeServiceName: svc.name })
    }
  }
  return { consumers, warnings }
}

/** Plain-words text of a consumer warning. */
export function cacheConsumerWarningMessage(warning: CacheConsumerWarning): string {
  return warning.code === 'cache_other_server'
    ? `"${warning.composeServiceName}" runs under the Hosting Account of a cache on another server, so it gets no cache variables.`
    : `"${warning.composeServiceName}" runs under a different Hosting Account than any cache of this environment, so it gets no cache variables.`
}
