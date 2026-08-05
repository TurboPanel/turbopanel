/**
 * Runtime-agnostic rate limiter — Workers (`RateLimit` binding) and the
 * Deno Redis adapter (`createRedisRateLimiter`) share this interface so route
 * gating stays identical across runtimes.
 */
export interface RateLimiter {
  limit(args: { key: string }): Promise<{ success: boolean }>
}

/** Always allows — used when a binding is absent (Deno/tests) so call sites stay runtime-agnostic. */
export function createNoopRateLimiter(): RateLimiter {
  return {
    async limit(_args: { key: string }): Promise<{ success: boolean }> {
      return { success: true }
    },
  }
}

/**
 * Always denies. Used as the Workers production safety net when a daemon
 * `RateLimit` binding is missing — requests fail closed (429) rather than
 * silently degrading to an unrestricted noop.
 */
export function createFailClosedRateLimiter(): RateLimiter {
  return {
    async limit(_args: { key: string }): Promise<{ success: boolean }> {
      return { success: false }
    },
  }
}
