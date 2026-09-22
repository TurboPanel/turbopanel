/**
 * Fleet-presence resolver. Registered at the composition root so
 * `features/commands` never imports `daemon/cell/server-status`.
 */

import type { Db } from '../../db/connection.ts'

/** Minimal presence shape command dispatch reads through this port. */
export type FleetPresencePortSnapshot = {
  connected: boolean
  daemonBuild?: {
    version?: string
  }
}

export type ResolveFleetPresence = (
  db: Db,
  registry: unknown,
  serverIds: string[],
) => Promise<Map<string, FleetPresencePortSnapshot>>

let resolver: ResolveFleetPresence | null = null

export function setResolveFleetPresence(next: ResolveFleetPresence | null): void {
  resolver = next
}

export function getResolveFleetPresence(): ResolveFleetPresence {
  if (!resolver) {
    throw new Error('resolveFleetPresence port is not registered')
  }
  return resolver
}
