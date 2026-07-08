import type { RateLimiter } from './contracts.ts'

/** Structural mirror of Workers `RateLimit` so Deno can typecheck without ambient CF types. */
type WorkersRateLimitBinding = {
  limit(options: { key: string }): Promise<{ success: boolean }>
}

/**
 * Adapter over the Cloudflare Workers `RateLimit` binding.
 * Import **only** from Workers-side wiring (same containment as `workers-ws.ts`).
 */
export function createWorkersRateLimiter(binding: WorkersRateLimitBinding): RateLimiter {
  return {
    limit(args: { key: string }): Promise<{ success: boolean }> {
      return binding.limit({ key: args.key })
    },
  }
}
