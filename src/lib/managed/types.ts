/**
 * Canonical managed-engine vocabulary and runtime-spec contracts.
 *
 * Secrets never appear in a {@link ManagedRuntimeSpec}: credential values in
 * `env` are the literal {@link ManagedSecretPlaceholder} token. The daemon
 * substitutes plaintext from the decrypted `credentials[]` envelope.
 */

import type { ManagedSettings } from './settings.ts'

/** Managed engine codes — environment-scoped services. */
export const MANAGED_ENGINE_CODES = [
  'postgres',
  'mysql',
  'mariadb',
  'redis',
  'clickhouse',
] as const

export type ManagedEngineCode = (typeof MANAGED_ENGINE_CODES)[number]

export function isManagedEngineCode(value: string): value is ManagedEngineCode {
  return (MANAGED_ENGINE_CODES as readonly string[]).includes(value)
}

export type ManagedEngineStatus = 'available' | 'coming-soon'

/** Lifecycle statuses persisted on `managed.status` (DB CHECK mirrors this set). */
export const MANAGED_STATUSES = [
  'provisioning',
  'applying',
  'ready',
  'stopped',
  'failed',
] as const

export type ManagedStatus = (typeof MANAGED_STATUSES)[number]

export function parseManagedStatus(value: unknown): ManagedStatus | null {
  if (typeof value !== 'string') return null
  return (MANAGED_STATUSES as readonly string[]).includes(value)
    ? (value as ManagedStatus)
    : null
}

/**
 * Placeholder token written into runtime-spec `env` for credential values.
 *
 * **Plaintext passwords must never appear in a runtime spec.** The daemon
 * substitutes this token from the decrypted credentials envelope at apply time.
 */
export const ManagedSecretPlaceholder =
  '${TURBOPANEL_MANAGED_ROOT_PASSWORD}' as const

export type ManagedSecretPlaceholder = typeof ManagedSecretPlaceholder

export type ManagedRuntimeVolume = {
  name: string
  /** Absolute path inside the container (named Docker volume only — never a host bind). */
  target: string
}

export type ManagedConfigFile = {
  /** Relative path under the managed state `config/` directory. */
  path: string
  contents: string
  mode: '0640' | '0600'
}

export type ManagedTlsMaterialRequest = {
  selfSigned: true
  commonName: string
  certPath: string
  keyPath: string
}

export type ManagedRuntimeHealthcheck = {
  test: string[]
  interval: string
  timeout: string
  retries: number
  start_period: string
}

export type ManagedExposure = {
  enabled: boolean
  protocol: 'tcp' | 'udp' | 'http'
  containerPort: number
  bind?: 'public' | 'datacenter' | 'local'
}

/**
 * Everything the daemon needs to materialize a managed service — and nothing
 * secret. Credential slots in `env` use {@link ManagedSecretPlaceholder} only.
 */
export type ManagedRuntimeSpec = {
  composeServiceName: string
  /** Generated Compose service fragment (no `ports:` — exposure is Traefik's job). */
  service: Record<string, unknown>
  volumes: ManagedRuntimeVolume[]
  configFiles: ManagedConfigFile[]
  /**
   * Environment map. Credential values MUST be {@link ManagedSecretPlaceholder};
   * plaintext passwords must never appear here.
   */
  env: Record<string, string>
  /** Request for the daemon to generate key material — instance never ships private keys. */
  tlsMaterial?: ManagedTlsMaterialRequest
  /** Mirrored summary of the compose `healthcheck` for tests and diagnostics. */
  healthcheck: ManagedRuntimeHealthcheck
  exposure: ManagedExposure
}

export type ManagedConnectionInfo = {
  /** DSN with password masked as `***`. */
  dsn: string
  host: string
  port: number
  database: string
  username: string
}

export type ManagedUserOperationKind =
  | 'create-user'
  | 'drop-user'
  | 'set-password'
  | 'create-database'
  | 'drop-database'
  | 'grant-database'

export type ManagedDatabasePrivilege = 'owner' | 'read-write' | 'read-only'

/**
 * Declarative user/database ops — **no SQL text**. The daemon owns statement
 * construction and quoting at execution time.
 */
export type ManagedUserOperations = {
  supported: ManagedUserOperationKind[]
  privileges: ManagedDatabasePrivilege[]
  identifier: {
    quote: '"' | '`'
    maxLength: number
    pattern: RegExp
  }
  executor: {
    kind: 'docker-exec'
    client: 'psql' | 'mysql' | 'mariadb'
  }
}

export type BuildRuntimeSpecInput = {
  managedId: string
  settings: ManagedSettings
  rootUsername: string
  /**
   * Per-member identity for multi-member clusters (private listener, role,
   * streaming replication). Omitted for single-member / non-replicated apply.
   */
  member?: {
    role: 'primary' | 'standby'
    ordinal: number
    replication?: {
      username: string
      slotName?: string
      desiredSlots?: string[]
      peerAddresses?: string[]
      primary?: {
        host: string
        hostaddr?: string
        port: number
      }
    }
    privateListener?: {
      address: string
      port: number
    }
  }
  /** When true, use org-CA leaf paths for engine SSL (multi-member / verify-full). */
  useOrgTls?: boolean
}

export type BuildConnectionInfoInput = {
  host: string
  port: number
  database: string
  username: string
  settings: ManagedSettings
}

/** Allowlisted artifact extensions for managed backup dumps. */
export const MANAGED_BACKUP_ARTIFACT_EXTENSIONS = ['dump', 'sql'] as const

export type ManagedBackupArtifactExtension =
  (typeof MANAGED_BACKUP_ARTIFACT_EXTENSIONS)[number]

export function isManagedBackupArtifactExtension(
  value: string,
): value is ManagedBackupArtifactExtension {
  return (MANAGED_BACKUP_ARTIFACT_EXTENSIONS as readonly string[]).includes(value)
}

/**
 * Optional backup capability on an engine spec. **Declarative only** — the
 * `executor` names the client binaries; the daemon owns argv construction
 * (mirrors the `userOperations` "no SQL text" rule). Engines without this
 * field are simply unsupported for backup/restore.
 */
export type ManagedBackupDescriptor = {
  artifactExtension: ManagedBackupArtifactExtension
  supportsDatabaseScope: boolean
  supportsInstanceScope: boolean
  executor: {
    kind: 'docker-exec'
    dumpClient: string
    restoreClient: string
  }
  defaultRetentionKeep: number
  maxRetentionKeep: number
}

/**
 * Conventional unprefixed env keys a binding may emit when
 * `emit_engine_defaults` is true (at most one binding per service). The CA
 * arrives as PEM text on `<PREFIX>_CA_CERT` — there is no on-disk path, so
 * engines do not emit `PGSSLROOTCERT` / equivalent file-path keys.
 */
export type ManagedBindingDescriptor = {
  /** DSN scheme segment (`postgresql`, `mysql`). */
  scheme: string
  /** Unprefixed keys (e.g. `PGHOST` / `MYSQL_HOST`). */
  unprefixed: {
    host: string
    port: string
    database: string
    user: string
    password: string
    /** Optional SSL mode key (`PGSSLMODE`); value is forced to verify-full. */
    sslMode?: string
  }
  /**
   * Build a plaintext DSN with the real password (secrets materialization).
   * Forces TLS verify semantics (`sslmode=verify-full` / MySQL-family equivalent).
   */
  buildBindingDsn(input: BuildConnectionInfoInput & { password: string }): string
}

export type ManagedEngineSpec = {
  engine: ManagedEngineCode
  displayName: string
  defaultImage: string
  defaultPort: number
  principalProvider: string
  rootUsername: string
  exposeProtocol: 'tcp' | 'udp' | 'http'
  defaultSettings: ManagedSettings
  parseSettings(value: unknown): ManagedSettings | null
  buildRuntimeSpec(input: BuildRuntimeSpecInput): ManagedRuntimeSpec
  buildConnectionInfo(input: BuildConnectionInfoInput): ManagedConnectionInfo
  userOperations: ManagedUserOperations
  /** Present only when the engine supports backup/restore. */
  backup?: ManagedBackupDescriptor
  /** Present when the engine participates in service bindings. */
  binding?: ManagedBindingDescriptor
}
