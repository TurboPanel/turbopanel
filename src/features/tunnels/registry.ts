import type { TunnelAdapter } from './adapter.ts'
import { createCloudflareAdapter } from './cloudflare-adapter.ts'
import type { TunnelProvider } from './vocabulary.ts'

export type TunnelAdapterRegistry = (provider: TunnelProvider) => TunnelAdapter

/** The adapters the panel ships. `fetchImpl` lets tests stand in for the provider. */
export function createTunnelAdapterRegistry(fetchImpl?: typeof fetch): TunnelAdapterRegistry {
  const adapters: Record<TunnelProvider, TunnelAdapter> = {
    cloudflare: createCloudflareAdapter({ fetch: fetchImpl }),
  }
  return (provider) => adapters[provider]
}
