/**
 * Managed engine registry — single source of truth for engine identity,
 * defaults, settings validation, runtime-spec generation, and connection info.
 *
 * Extension contract: a new engine = one spec file + one registry entry + one
 * status entry, nothing else.
 */

import { mariadbEngineSpec } from './mariadb.ts'
import { mysqlEngineSpec } from './mysql.ts'
import { postgresEngineSpec } from './postgres.ts'
import {
  isManagedEngineCode,
  type ManagedEngineCode,
  type ManagedEngineSpec,
  type ManagedEngineStatus,
} from './types.ts'

export {
  type BuildConnectionInfoInput,
  type BuildRuntimeSpecInput,
  isManagedBackupArtifactExtension,
  isManagedEngineCode,
  MANAGED_BACKUP_ARTIFACT_EXTENSIONS,
  MANAGED_ENGINE_CODES,
  MANAGED_STATUSES,
  type ManagedBackupArtifactExtension,
  type ManagedBackupDescriptor,
  type ManagedConfigFile,
  type ManagedConnectionInfo,
  type ManagedDatabasePrivilege,
  type ManagedEngineCode,
  type ManagedEngineSpec,
  type ManagedEngineStatus,
  type ManagedExposure,
  type ManagedRuntimeHealthcheck,
  type ManagedRuntimeSpec,
  type ManagedRuntimeVolume,
  ManagedSecretPlaceholder,
  type ManagedStatus,
  type ManagedTlsMaterialRequest,
  type ManagedUserOperationKind,
  type ManagedUserOperations,
  parseManagedStatus,
} from './types.ts'

export {
  clampManagedResources,
  DEFAULT_MANAGED_SETTINGS,
  getManagedAllowedImages,
  isManagedImageAllowed,
  MANAGED_DOCKER_OPTION_DENYLIST,
  MANAGED_EXTRA_ENV_KEY_RE,
  type ManagedBackupSettings,
  type ManagedDockerOptions,
  type ManagedSettings,
  MARIADB_ALLOWED_IMAGES,
  MARIADB_RESERVED_ENV_KEYS,
  MYSQL_ALLOWED_IMAGES,
  MYSQL_RESERVED_ENV_KEYS,
  parseBackupSettings,
  parseManagedDockerOptions,
  parseManagedSettingsBase,
  POSTGRES_ALLOWED_IMAGES,
  POSTGRES_RESERVED_ENV_KEYS,
} from './settings.ts'

export {
  defaultManagedImage,
  defaultManagedRelease,
  describeManagedImage,
  isSameManagedSeries,
  MANAGED_ENGINE_RELEASES,
  managedAllowedImagesForEngine,
  managedCreatableReleasesForEngine,
  type ManagedEngineLifecycle,
  type ManagedEngineRelease,
  type ManagedImageDescriptor,
  type ManagedImageVariant,
  managedReleasesForEngine,
  type ManagedReleaseGate,
  requireDefaultManagedImage,
  resolveManagedImage,
} from './releases.ts'

export { postgresEngineSpec } from './postgres.ts'
export type { PostgresManagedSettings } from './postgres.ts'
export { mysqlEngineSpec } from './mysql.ts'
export type { MysqlManagedSettings } from './mysql.ts'
export { mariadbEngineSpec } from './mariadb.ts'
export type { MariadbManagedSettings } from './mariadb.ts'

/** Registry keyed by engine code. Only engines with a shipped spec appear here. */
export const MANAGED_ENGINE_SPECS: Partial<
  Record<ManagedEngineCode, ManagedEngineSpec>
> = {
  postgres: postgresEngineSpec,
  mysql: mysqlEngineSpec,
  mariadb: mariadbEngineSpec,
}

/** Availability for every managed engine code (UI / API source of truth). */
export const MANAGED_ENGINE_STATUS: Record<
  ManagedEngineCode,
  ManagedEngineStatus
> = {
  postgres: 'available',
  mysql: 'available',
  mariadb: 'available',
  redis: 'coming-soon',
  clickhouse: 'coming-soon',
}

export function getManagedEngineSpec(code: string): ManagedEngineSpec | null {
  if (!isManagedEngineCode(code)) return null
  return MANAGED_ENGINE_SPECS[code] ?? null
}

/** Convenience accessor for the optional backup descriptor of an engine. */
export function getManagedBackupDescriptor(
  code: string,
): ManagedEngineSpec['backup'] | null {
  return getManagedEngineSpec(code)?.backup ?? null
}

/** `true` when `code` names an available engine whose spec declares a `backup` descriptor. */
export function isManagedBackupSupported(code: string): boolean {
  return getManagedBackupDescriptor(code) !== null
}

export function listManagedEngineSpecs(): ManagedEngineSpec[] {
  return Object.values(MANAGED_ENGINE_SPECS).filter(
    (spec): spec is ManagedEngineSpec => spec !== undefined,
  )
}

export function isManagedEngineAvailable(code: string): boolean {
  return isManagedEngineCode(code) &&
    MANAGED_ENGINE_STATUS[code] === 'available'
}
