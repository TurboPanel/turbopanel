/**
 * Burst limit on a server's `topology-report` messages: the only writer of
 * `server.metadata.hardware`, which can be up to 64 KiB a time.
 *
 * It sits in front of every Postgres write that report would cause. A healthy
 * daemon sends one on connect and when its devices change, so well under one a
 * minute; {@link TOPOLOGY_REPORT_RATE} allows a short burst (a reconnect plus a
 * resync request) and nothing like a flood.
 *
 * What it cannot do: the Workers `RateLimit` binding counts per Cloudflare
 * location and is only eventually consistent, so this blunts a flood and is
 * not exact (a server's cell always runs in one place, which keeps it close to
 * exact in practice). The exact limit is the five-minute overwrite cooldown in
 * `features/servers/server-topology-records.ts`, which still holds whatever
 * this lets through. A limited report is dropped: it is fire-and-forget on the
 * socket, so there is no response to carry a 429, and the daemon reports again
 * on its next change or when asked to resync.
 */
import type { RateLimiter } from './contracts.ts'
import { daemonTopologyRateLimitKey } from './keys.ts'

/** Reports per server per period before the rest are dropped. */
export const TOPOLOGY_REPORT_RATE = { limit: 4, periodSeconds: 60 } as const

/**
 * `true` when the report may go on to be stored. A limiter that throws lets it
 * through: the exact overwrite cooldown still bounds the write, and losing a
 * hardware change to a broker hiccup is worse than one extra cheap check.
 */
export async function topologyReportAllowed(
  limiter: RateLimiter | undefined,
  serverId: string,
  onError: (err: unknown) => void = () => undefined
): Promise<boolean> {
  if (!limiter) return true
  try {
    return (await limiter.limit({ key: daemonTopologyRateLimitKey(serverId) })).success
  } catch (err) {
    onError(err)
    return true
  }
}
