/** The fixed settings of an admin tool's login. Pure, so the choices are pinned by tests. */

import { DATABASE_ADMIN_PRIVILEGE } from '../owner-role.ts'
import { isReservedDatabaseName } from '../routes-helpers.ts'
import type { AdminToolAccess } from './projects.ts'

/** Where a tool login may connect from: the server itself (its loopback and Docker networks). */
export const ADMIN_TOOL_LOGIN_SOURCES: readonly string[] = ['internal']

export type AdminToolLoginGrants = {
  privileges: string[]
  connectionRole: 'read-write' | 'read-only'
  /** Every database of the cluster except the engine's reserved names. */
  databases: string[]
  tool: true
  allDatabases: false
  grantMode: 'recipe'
}

/**
 * Explicit grants on every current database, never All Databases, so the
 * organization and cluster switches keep governing ordinary logins only.
 */
export function adminToolLoginGrants(input: {
  access: AdminToolAccess
  engine: string
  clusterDatabases: readonly string[]
}): AdminToolLoginGrants {
  const isAdmin = input.access === 'admin'
  return {
    privileges: isAdmin ? [DATABASE_ADMIN_PRIVILEGE] : ['read-only'],
    connectionRole: isAdmin ? 'read-write' : 'read-only',
    databases: input.clusterDatabases.filter((name) => !isReservedDatabaseName(input.engine, name)),
    tool: true,
    allDatabases: false,
    grantMode: 'recipe',
  }
}
