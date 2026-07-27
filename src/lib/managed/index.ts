/**
 * Managed engine registry — single source of truth for engine identity,
 * defaults, settings validation, runtime-spec generation, and connection info.
 *
 * Extension contract: a new engine = one spec file + one registry entry + one
 * status entry, nothing else.
 */

import { postgresEngineSpec } from './postgres.ts'
import {
  isManagedEngineCode,
  type ManagedEngineCode,
  type ManagedEngineSpec,
  type ManagedEngineStatus,
} from './types.ts'

export {
  MANAGED_BACKUP_ARTIFACT_EXTENSIONS,
  MANAGED_ENGINE_CODES,
  MANAGED_STATUSES,
  ManagedSecretPlaceholder,
  isManagedBackupArtifactExtension,
  isManagedEngineCode,
  parseManagedStatus,
  type BuildConnectionInfoInput,
  type BuildRuntimeSpecInput,
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
  type ManagedStatus,
  type ManagedTlsMaterialRequest,
  type ManagedUserOperationKind,
  type ManagedUserOperations,
} from './types.ts'

export {
  DEFAULT_MANAGED_SETTINGS,
  MANAGED_DOCKER_OPTION_DENYLIST,
  MANAGED_EXTRA_ENV_KEY_RE,
  POSTGRES_RESERVED_ENV_KEYS,
  RESERVED_PUBLISHED_PORTS,
  clampManagedResources,
  parseBackupSettings,
  parseManagedDockerOptions,
  parseManagedSettingsBase,
  type ManagedBackupSettings,
  type ManagedDockerOptions,
  type ManagedSettings,
} from './settings.ts'

export { postgresEngineSpec } from './postgres.ts'
export type { PostgresManagedSettings } from './postgres.ts'

/** Registry keyed by engine code. Only engines with a shipped spec appear here. */
export const MANAGED_ENGINE_SPECS: Partial<
  Record<ManagedEngineCode, ManagedEngineSpec>
> = {
  postgres: postgresEngineSpec,
}

/** Availability for every managed engine code (UI / API source of truth). */
export const MANAGED_ENGINE_STATUS: Record<
  ManagedEngineCode,
  ManagedEngineStatus
> = {
  postgres: 'available',
  mysql: 'coming-soon',
  mariadb: 'coming-soon',
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

export function listManagedEngineSpecs(): ManagedEngineSpec[] {
  return Object.values(MANAGED_ENGINE_SPECS).filter(
    (spec): spec is ManagedEngineSpec => spec !== undefined,
  )
}

export function isManagedEngineAvailable(code: string): boolean {
  return isManagedEngineCode(code) &&
    MANAGED_ENGINE_STATUS[code] === 'available'
}
