/**
 * Container-log enablement on the presence channel.
 *
 * The daemon learns whether to collect container output from the ack it gets
 * back for its own `hello` / `heartbeat` — **not** from a command. A command
 * would need queueing, leasing, an outcome, and a retry story for a boolean
 * that is already re-sent on the next presence frame; the ack costs one frame
 * on a socket that is already open and converges by construction after a
 * daemon restart, a control-plane restart, or a toggle the daemon missed.
 *
 * The daemon side is `turbopaneld/src/instance/client.ts` (`presence-ack`) →
 * `turbopaneld/src/logs/container-collector.ts`.
 */

import { eq } from "drizzle-orm";
import type { Db } from "../db.ts";
import { organization, server } from "../lib/db/schema.ts";
import { parseOrganizationOptions } from "../lib/organization-options.ts";
import { resolveContainerLogsEnabled } from "../lib/container-logs/org-settings.ts";

/** Control-plane → daemon acknowledgement of a `hello` / `heartbeat`. */
export type DaemonPresenceAck = {
  type: "presence-ack";
  at: string;
  containerLogsEnabled: boolean;
};

export function buildPresenceAck(
  containerLogsEnabled: boolean,
  at: string = new Date().toISOString(),
): DaemonPresenceAck {
  return { type: "presence-ack", at, containerLogsEnabled };
}

/**
 * Resolve the owning organization's container-log switch for one server.
 *
 * One join per call. Any failure resolves to `false`: the safe direction for a
 * billed, high-volume feature is off.
 *
 * Presence paths should call {@link loadServerContainerLogsEnabledCached}
 * instead — daemons now send a floor-cadence heartbeat (and, on the Deno
 * transport, get acked on the cell ping) so this is on a per-minute path.
 */
export async function loadServerContainerLogsEnabled(
  db: Db,
  serverId: string,
): Promise<boolean> {
  try {
    const rows = await db
      .select({ options: organization.options })
      .from(server)
      .innerJoin(organization, eq(server.organizationId, organization.id))
      .where(eq(server.id, serverId))
      .limit(1);
    if (rows.length === 0) return false;
    return resolveContainerLogsEnabled(
      parseOrganizationOptions(rows[0]?.options),
    );
  } catch {
    return false;
  }
}

/**
 * How long a resolved flag is reused before the join runs again.
 *
 * Presence frames are no longer purely change-detected: an idle daemon sends a
 * refresh `heartbeat` every few minutes (`turbopaneld/src/instance/idle-presence.ts`)
 * and the Deno transport also acks the once-a-minute cell ping, both so an org
 * toggle reaches an otherwise-silent daemon. This window keeps that convergence
 * from turning into a per-minute-per-server join, at the cost of at most one
 * TTL of extra staleness on a toggle.
 */
export const CONTAINER_LOGS_FLAG_TTL_MS = 30_000;

/** Bound on cached servers — a cell/instance never tracks more than this. */
const MAX_CACHED_SERVERS = 2_000;

const flagCache = new Map<string, { value: boolean; expiresAtMs: number }>();

/**
 * In-memory flag only. `null` is a miss; a cached `false` is a hit.
 * Does not consult backend availability.
 */
function readFlagCache(
  serverId: string,
  nowMs: number,
): boolean | null {
  const cached = flagCache.get(serverId);
  if (cached && cached.expiresAtMs > nowMs) return cached.value;
  return null;
}

/** Cached {@link loadServerContainerLogsEnabled} for the presence paths. */
export async function loadServerContainerLogsEnabledCached(
  db: Db,
  serverId: string,
  nowMs: number = Date.now(),
): Promise<boolean> {
  const cached = readFlagCache(serverId, nowMs);
  if (cached !== null) return cached;

  const value = await loadServerContainerLogsEnabled(db, serverId);
  flagCache.delete(serverId);
  flagCache.set(serverId, {
    value,
    expiresAtMs: nowMs + CONTAINER_LOGS_FLAG_TTL_MS,
  });
  while (flagCache.size > MAX_CACHED_SERVERS) {
    const oldest = flagCache.keys().next();
    if (oldest.done) break;
    flagCache.delete(oldest.value);
  }
  return value;
}

/** Test-only: drop every cached flag so suites do not bleed into each other. */
export function resetContainerLogsFlagCacheForTests(): void {
  flagCache.clear();
}

/**
 * Whether *this deployment* has a container-log backend that can retain
 * anything (`deno-server.ts` / `workers.ts` set it from the resolved store).
 *
 * This is the platform-level kill switch, and it is a different question from
 * `organization.options.containerLogsEnabled`: the org switch says whether a
 * tenant asked for retention, this says whether the control plane could honour
 * it at all. Both must be true before a daemon is told to collect — otherwise
 * daemons stream output into an ingest route that only drops it.
 *
 * Defaults to `true` (assume available) so an isolate that never ran the boot
 * wiring — a Durable Object woken before any request touched the resolver —
 * degrades to today's behaviour instead of silently switching every tenant off.
 */
let backendAvailable = true;

/**
 * Presence-ack flag without opening a database.
 *
 * `null` means a projection read is required. When the platform backend is
 * unavailable this returns `false` without a read; otherwise it returns the
 * cached org switch. Workers `#sendPresenceAck` must call this *before*
 * `#withProjectionDbResult` — a cache hit that still mints a postgres.js
 * client keeps the Durable Object non-hibernatable.
 */
export function peekDaemonContainerLogsFlag(
  serverId: string,
  nowMs: number = Date.now(),
): boolean | null {
  if (!backendAvailable) return false;
  return readFlagCache(serverId, nowMs);
}

/** Record the resolved backend's availability at boot. */
export function setContainerLogBackendAvailable(available: boolean): void {
  backendAvailable = available;
}

/** Current platform-level availability (test/diagnostic use). */
export function containerLogBackendAvailable(): boolean {
  return backendAvailable;
}

/** Test-only: restore the "assume available" default. */
export function resetContainerLogBackendAvailabilityForTests(): void {
  backendAvailable = true;
}

/**
 * The flag a presence ack should carry: the org switch **and** a backend that
 * can retain what the daemon would send.
 */
export async function resolveDaemonContainerLogsFlag(
  db: Db,
  serverId: string,
  nowMs: number = Date.now(),
): Promise<boolean> {
  if (!backendAvailable) return false;
  return await loadServerContainerLogsEnabledCached(db, serverId, nowMs);
}
