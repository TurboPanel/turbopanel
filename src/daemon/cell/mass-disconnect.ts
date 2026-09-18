/**
 * When a batch of hosts going offline stops looking like N unrelated failures.
 *
 * Its own module because both sweeps need it and they belong to different
 * runtimes: the Workers cron (`offline-sweep.ts`, typed against Cloudflare
 * ambients) and the self-hosted Deno/Redis timer
 * (`control-plane-monitor.ts`). Importing one into the other to reach a pure
 * predicate would drag a whole runtime's module graph across the boundary.
 */

/** Hosts lost in one sweep before the aggregate signal is worth sending. */
export const MASS_DISCONNECT_MIN_SERVERS = 3;
export const MASS_DISCONNECT_RATIO = 0.5;
export const MASS_DISCONNECT_ABSOLUTE = 10;

/**
 * A bad daemon release, a WebSocket ingress break or a Durable Object
 * regional outage takes hosts down together, and per-server notices report
 * that as noise — one line per host, no signal that they share a cause.
 * Either bound crossing is enough: the ratio catches a small fleet going dark
 * at once, the absolute count catches a large one losing a chunk.
 */
export function isMassDisconnect(
  staleCount: number,
  connectedBefore: number,
): boolean {
  if (staleCount < MASS_DISCONNECT_MIN_SERVERS) return false;
  if (staleCount >= MASS_DISCONNECT_ABSOLUTE) return true;
  return connectedBefore > 0 &&
    staleCount / connectedBefore >= MASS_DISCONNECT_RATIO;
}

/** The one-line aggregate an operator greps for and a pager rule keys on. */
export function massDisconnectText(
  staleCount: number,
  connectedBefore: number,
): string {
  return `Mass disconnect: ${staleCount} of ${connectedBefore} connected servers went offline in one sweep — suspect a shared cause (daemon release, ingress, or cell outage) rather than ${staleCount} unrelated hosts`;
}

/** The per-host line. */
export function serverOfflineText(serverId: string): string {
  return `Server ${serverId} stopped answering and has been marked offline`;
}
