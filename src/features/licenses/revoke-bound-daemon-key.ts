/**
 * Optional revoke-daemon-key port.
 *
 * License helpers must not import the daemon authn surface. The composition
 * root registers `revokeDaemonKey`; unset (host-free tests) is a no-op.
 */

import type { Db } from '../../db/connection.ts'

export type RevokeBoundDaemonKey = (db: Db, serverId: string) => Promise<void>

let revokeBound: RevokeBoundDaemonKey | null = null

export function setRevokeBoundDaemonKey(fn: RevokeBoundDaemonKey | null): void {
  revokeBound = fn
}

export async function revokeBoundDaemonKey(db: Db, serverId: string): Promise<void> {
  if (!revokeBound) return
  await revokeBound(db, serverId)
}
