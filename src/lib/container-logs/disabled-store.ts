/**
 * Default store when container logs are disabled or no backend is configured
 * for the runtime.
 *
 * Every method is a safe no-op so callers never branch on availability: an
 * ingest silently drops (container logs are disposable telemetry, not product
 * data), and a query reports an empty, exhausted page.
 *
 * This is also the current Workers stub — the Cloudflare driver lands in a
 * later phase, so the interface merely has to compile on both runtimes today.
 */

import type {
  ContainerLogEvent,
  ContainerLogPage,
  ContainerLogQuery,
  ContainerLogStore,
} from './types.ts'

export class DisabledContainerLogStore implements ContainerLogStore {
  ingest(_events: readonly ContainerLogEvent[]): Promise<void> {
    return Promise.resolve()
  }

  query(_q: ContainerLogQuery): Promise<ContainerLogPage> {
    return Promise.resolve({ events: [], nextCursor: null })
  }
}
