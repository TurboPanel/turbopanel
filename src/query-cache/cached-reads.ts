import { serverDetailCachedRead } from './read-models/server-detail.ts'
import { serversListCachedRead } from './read-models/servers-list.ts'

/**
 * Every cached read, for the registry test. A read model that is not listed
 * here fails the "registry matches definitions" test, so none can be added or
 * left out quietly.
 */
export const ALL_CACHED_READS = [serversListCachedRead, serverDetailCachedRead] as const
