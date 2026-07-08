/**
 * Deno-only Redis token-bucket RateLimiter.
 * Import **only** from `src/deno.ts` / tests (same containment as
 * `src/query-cache/redis-query-cache.ts`) — never from the Workers bundle.
 */
import type { RedisCellClient } from '../cell/redis/client.ts'
import { rateLimitKey } from '../cell/redis/keys.ts'
import { RATE_LIMIT_TOKEN_BUCKET } from '../cell/redis/lua.ts'
import { logWarn } from '../../logger.ts'
import type { RateLimiter } from './contracts.ts'

/** Defaults match Wrangler `DAEMON_CONNECT_RATE_LIMITER` (`{ limit: 6, period: 60 }`). */
export const DEFAULT_DAEMON_CONNECT_RATE_LIMIT = 6
export const DEFAULT_DAEMON_CONNECT_RATE_PERIOD_SECONDS = 60

/** Defaults match Wrangler `DAEMON_REST_RATE_LIMITER` (`{ limit: 30, period: 60 }`). */
export const DEFAULT_DAEMON_REST_RATE_LIMIT = 30
export const DEFAULT_DAEMON_REST_RATE_PERIOD_SECONDS = 60

const MIN_BUCKET_TTL_MS = 1_000

function parsePositiveIntEnv(
  raw: string | undefined,
  fallback: number,
): number {
  if (raw === undefined || raw.trim() === '') return fallback
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return parsed
}

export function resolveDaemonConnectRateLimit(env: {
  get(key: string): string | undefined
} = Deno.env): { limit: number; periodSeconds: number } {
  return {
    limit: parsePositiveIntEnv(
      env.get('TURBOPANEL_DAEMON_CONNECT_RATE_LIMIT'),
      DEFAULT_DAEMON_CONNECT_RATE_LIMIT,
    ),
    periodSeconds: parsePositiveIntEnv(
      env.get('TURBOPANEL_DAEMON_CONNECT_RATE_PERIOD'),
      DEFAULT_DAEMON_CONNECT_RATE_PERIOD_SECONDS,
    ),
  }
}

export function resolveDaemonRestRateLimit(env: {
  get(key: string): string | undefined
} = Deno.env): { limit: number; periodSeconds: number } {
  return {
    limit: parsePositiveIntEnv(
      env.get('TURBOPANEL_DAEMON_REST_RATE_LIMIT'),
      DEFAULT_DAEMON_REST_RATE_LIMIT,
    ),
    periodSeconds: parsePositiveIntEnv(
      env.get('TURBOPANEL_DAEMON_REST_RATE_PERIOD'),
      DEFAULT_DAEMON_REST_RATE_PERIOD_SECONDS,
    ),
  }
}

export function resolveDaemonWsInboundLimits(env: {
  get(key: string): string | undefined
} = Deno.env): { limit: number; windowMs: number } {
  return {
    limit: parsePositiveIntEnv(
      env.get('TURBOPANEL_DAEMON_WS_INBOUND_LIMIT'),
      120,
    ),
    windowMs: parsePositiveIntEnv(
      env.get('TURBOPANEL_DAEMON_WS_INBOUND_WINDOW_MS'),
      60_000,
    ),
  }
}

export function createRedisRateLimiter(opts: {
  client: RedisCellClient
  limit: number
  periodSeconds: number
}): RateLimiter {
  const capacity = opts.limit
  const msPerToken = (opts.periodSeconds * 1000) / opts.limit
  const ttlMs = Math.max(
    Math.ceil(capacity * msPerToken),
    MIN_BUCKET_TTL_MS,
  )
  const { client } = opts

  return {
    async limit(args: { key: string }): Promise<{ success: boolean }> {
      try {
        const result = await client.eval(
          RATE_LIMIT_TOKEN_BUCKET,
          1,
          rateLimitKey(args.key),
          capacity,
          msPerToken,
          Date.now(),
          ttlMs,
        )
        return { success: result === 1 }
      } catch (err) {
        logWarn(
          'daemon-rate-limit',
          `eval failed for ${args.key}: ${String(err)}`,
        )
        return { success: true }
      }
    },
  }
}
