/**
 * An older daemon would serve a tunnel-only name to everyone (it knows no
 * local-only lock) and would ignore the forwarding table. So nothing tunnel
 * related is sent to a server, and no name is marked tunnel-only there, unless
 * the daemon has advertised the feature on its `hello`.
 */
import type { Db } from '../../db/connection.ts'
import {
  TUNNEL_FORWARDING_FEATURE,
  TUNNEL_LOCK_FOLLOW_FEATURE,
  TUNNEL_STATUS_FEATURE,
} from '../../lib/version-wire.ts'
import { getServerDaemonStateByServerId } from '../servers/server-identity-db.ts'

export function daemonCanCarryTunnels(features: readonly string[] | undefined): boolean {
  return features?.includes(TUNNEL_FORWARDING_FEATURE) === true
}

/**
 * Only a daemon that advertises `tunnel-lock-follow-v1` takes `inbound` on the
 * forwarding table, so the lock on its sites' tunnel names follows the servers
 * that carry the tunnel. An older one keeps the lock its last deploy wrote.
 */
export function daemonLockFollowsTable(features: readonly string[] | undefined): boolean {
  return features?.includes(TUNNEL_LOCK_FOLLOW_FEATURE) === true
}

/** Only a daemon that advertises `tunnel-status-v1` knows `server.tunnel.status`. */
export function daemonCanReportTunnelStatus(features: readonly string[] | undefined): boolean {
  return features?.includes(TUNNEL_STATUS_FEATURE) === true
}

/** Servers of the list whose daemon cannot carry tunnels, for a plain-words refusal or warning. */
export async function serversWithoutTunnelSupport(
  db: Db,
  serverIds: readonly string[]
): Promise<string[]> {
  const states = await Promise.all(
    serverIds.map((serverId) => getServerDaemonStateByServerId(db, serverId))
  )
  return serverIds.filter((_, index) => !daemonCanCarryTunnels(states[index]?.projection?.features))
}

/** Servers of the list whose daemon applies the name lock only at a site's next deploy. */
export async function serversWithDeployOnlyLock(
  db: Db,
  serverIds: readonly string[]
): Promise<string[]> {
  const states = await Promise.all(
    serverIds.map((serverId) => getServerDaemonStateByServerId(db, serverId))
  )
  return serverIds.filter(
    (_, index) => !daemonLockFollowsTable(states[index]?.projection?.features)
  )
}
