/**
 * The two switches behind All Databases logins: one for the organization
 * (default on) and one for the Database Cluster (default off). A login may
 * use All Databases only when both allow it.
 */

import type { Db } from '../../db/connection.ts'
import { loadManagedOrgDefaults } from './load-org-defaults.ts'
import type { ManagedOrganizationDefaults } from './org-defaults.ts'
import type { ManagedSettings } from './settings.ts'

export type AllDatabasesSwitches = {
  organization: boolean
  cluster: boolean
}

/** The effective position of both switches (organization defaults on, cluster defaults off). */
export function allDatabasesSwitches(
  orgDefaults: Pick<ManagedOrganizationDefaults, 'allowAllDatabasesLogins'>,
  settings: Pick<ManagedSettings, 'allowAllDatabasesLogins'>
): AllDatabasesSwitches {
  return {
    organization: orgDefaults.allowAllDatabasesLogins !== false,
    cluster: settings.allowAllDatabasesLogins === true,
  }
}

/** True when a login may use All Databases right now. */
export function allDatabasesAllowed(switches: AllDatabasesSwitches): boolean {
  return switches.organization && switches.cluster
}

/** Plain sentence naming the switch that is off, or `null` when both allow it. */
export function allDatabasesRefusalMessage(switches: AllDatabasesSwitches): string | null {
  if (!switches.organization) {
    return 'All Databases logins are switched off for this organization. Turn on "Allow All Databases Logins" in the organization settings first.'
  }
  if (!switches.cluster) {
    return 'All Databases logins are switched off for this Database Cluster. Turn on "Allow All Databases Logins" on the Database Cluster first.'
  }
  return null
}

/** Reads the organization switch and returns the refusal sentence, or `null` when All Databases may be used. */
export async function loadAllDatabasesRefusal(
  db: Db,
  organizationId: string,
  settings: Pick<ManagedSettings, 'allowAllDatabasesLogins'>
): Promise<string | null> {
  const orgDefaults = await loadManagedOrgDefaults(db, organizationId)
  return allDatabasesRefusalMessage(allDatabasesSwitches(orgDefaults, settings))
}

/**
 * The databases a login is granted on at apply. An All Databases login gets
 * every database of the cluster (minus the engine's reserved names) while both
 * switches allow it; otherwise it gets the databases picked for it that the
 * cluster still has.
 */
export function loginDatabasesForApply(
  login: { allDatabases?: boolean; databases: readonly string[] },
  cluster: { databases: readonly string[]; active: boolean; isReserved: (name: string) => boolean }
): string[] {
  if (login.allDatabases !== true) return [...login.databases]
  // Switched off: only the picks, and never one the cluster no longer has.
  if (!cluster.active) return login.databases.filter((name) => cluster.databases.includes(name))
  return [...new Set(cluster.databases.filter((name) => !cluster.isReserved(name)))]
}
