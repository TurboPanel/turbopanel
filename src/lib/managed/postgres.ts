/**
 * Tenant managed PostgreSQL engine spec.
 *
 * Completely independent of the control-plane `turbopanel-database` container —
 * this is a per-environment tenant service provisioned via the managed registry.
 */

import { applyResourcesToComposeService } from '../compose/apply-service-options.ts'
import {
  DEFAULT_MANAGED_SETTINGS,
  parseManagedSettingsBase,
  POSTGRES_RESERVED_ENV_KEYS,
  type ManagedSettings,
} from './settings.ts'
import {
  ManagedSecretPlaceholder,
  type BuildConnectionInfoInput,
  type BuildRuntimeSpecInput,
  type ManagedConnectionInfo,
  type ManagedEngineSpec,
  type ManagedRuntimeHealthcheck,
  type ManagedRuntimeSpec,
  type ManagedUserOperations,
} from './types.ts'

const DEFAULT_IMAGE = 'docker.io/library/postgres:18-alpine'
const DEFAULT_PORT = 5432
const ROOT_USERNAME = 'postgres'
const DEFAULT_DATABASE = 'postgres'
const IDENTIFIER_RE = /^[A-Za-z_]\w*$/
const MAX_IDENTIFIER_LENGTH = 63

const TLS_CERT_PATH = '/etc/postgresql/tls/server.crt'
const TLS_KEY_PATH = '/etc/postgresql/tls/server.key'
const CONFIG_CONTAINER_PATH = '/etc/postgresql/postgresql.conf'
const CONFIG_DIR_CONTAINER = '/etc/postgresql'
const TLS_DIR_CONTAINER = '/etc/postgresql/tls'
const DATA_VOLUME_TARGET = '/var/lib/postgresql'

const INCLUDE_DIRECTIVE_RE =
  /^\s*(include|include_if_exists|include_dir)\b/i
/** Non-comment, non-blank postgresql.conf setting line. */
const CONF_SETTING_LINE_RE = /^\s*[A-Za-z_]\w*\s*=\s*.+$/
/** Captures the setting name from a `CONF_SETTING_LINE_RE`-matched line. */
const CONF_SETTING_KEY_RE = /^\s*([A-Za-z_]\w*)\s*=/

/**
 * postgresql.conf keys owned by the platform base block in
 * {@link buildPlatformPostgresqlConf} (network/port, TLS, and on-disk
 * layout/control settings). The operator snippet is appended after that
 * block, so allowing these here would let an operator silently override
 * platform invariants (or repoint Postgres at attacker-controlled paths).
 */
const RESERVED_CONF_KEYS = new Set([
  'port',
  'listen_addresses',
  'ssl',
  'ssl_cert_file',
  'ssl_key_file',
  'ssl_ca_file',
  'ssl_crl_file',
  'ssl_crl_dir',
  'data_directory',
  'config_file',
  'hba_file',
  'ident_file',
  'external_pid_file',
  'unix_socket_directories',
])

export type PostgresManagedSettings = ManagedSettings & {
  initialDatabase: string
}

const USER_OPERATIONS: ManagedUserOperations = {
  supported: [
    'create-user',
    'drop-user',
    'set-password',
    'create-database',
    'drop-database',
    'grant-database',
  ],
  privileges: ['owner', 'read-write', 'read-only'],
  identifier: {
    quote: '"',
    maxLength: MAX_IDENTIFIER_LENGTH,
    pattern: IDENTIFIER_RE,
  },
  executor: { kind: 'docker-exec', client: 'psql' },
}

function isValidIdentifier(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_IDENTIFIER_LENGTH &&
    IDENTIFIER_RE.test(value)
  )
}

/**
 * Reject `include*` directives (so snippets cannot pull arbitrary container
 * files) and any {@link RESERVED_CONF_KEYS} key (so snippets cannot override
 * the platform's port/TLS/path invariants set in
 * {@link buildPlatformPostgresqlConf}). Keys are matched case-insensitively —
 * Postgres itself is case-insensitive about config parameter names.
 */
function isValidPostgresqlConfSnippet(snippet: string): boolean {
  const lines = snippet.split('\n')
  for (const line of lines) {
    if (INCLUDE_DIRECTIVE_RE.test(line)) return false
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue
    if (!CONF_SETTING_LINE_RE.test(line)) return false
    const match = CONF_SETTING_KEY_RE.exec(line)
    if (match === null || RESERVED_CONF_KEYS.has(match[1].toLowerCase())) {
      return false
    }
  }
  return true
}

function parseInitialDatabase(value: unknown): string | null {
  if (value === undefined) return DEFAULT_DATABASE
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!isValidIdentifier(trimmed)) return null
  return trimmed
}

function asSettingsRecord(
  value: unknown,
): Record<string, unknown> | undefined | null {
  if (value === null || value === undefined) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function parsePostgresSettings(value: unknown): PostgresManagedSettings | null {
  const base = parseManagedSettingsBase(value, POSTGRES_RESERVED_ENV_KEYS)
  if (base === null) return null

  const record = asSettingsRecord(value)
  if (record === null) return null

  const initialDatabase = parseInitialDatabase(record?.initialDatabase)
  if (initialDatabase === null) return null

  if (
    base.engineConfig !== undefined &&
    !isValidPostgresqlConfSnippet(base.engineConfig)
  ) {
    return null
  }

  return { ...base, initialDatabase }
}

function formatStopGracePeriod(seconds: number): string {
  return `${seconds}s`
}

function buildPlatformPostgresqlConf(
  settings: PostgresManagedSettings,
): string {
  const lines = [
    "# TurboPanel managed PostgreSQL — platform base (do not edit above the operator block)",
    "listen_addresses = '*'",
    'port = 5432',
  ]

  const memoryBytes = settings.resources?.memoryBytes
  if (memoryBytes !== undefined && memoryBytes > 0) {
    const sharedBuffers = Math.max(16, Math.floor(memoryBytes / (4 * 1024 * 1024)))
    const effectiveCache = Math.max(48, Math.floor(memoryBytes / (2 * 1024 * 1024)))
    lines.push(
      `shared_buffers = '${sharedBuffers}MB'`,
      `effective_cache_size = '${effectiveCache}MB'`,
    )
  }

  if (settings.ssl.enabled) {
    lines.push(
      'ssl = on',
      `ssl_cert_file = '${TLS_CERT_PATH}'`,
      `ssl_key_file = '${TLS_KEY_PATH}'`,
    )
  }

  lines.push('', '# --- operator config ---')
  if (settings.engineConfig !== undefined && settings.engineConfig.length > 0) {
    lines.push(settings.engineConfig.replace(/\n$/, ''))
  }

  return `${lines.join('\n')}\n`
}

function buildHealthcheck(
  rootUsername: string,
  database: string,
): ManagedRuntimeHealthcheck {
  return {
    test: [
      'CMD-SHELL',
      `pg_isready -U ${rootUsername} -d ${database}`,
    ],
    interval: '10s',
    timeout: '5s',
    retries: 5,
    start_period: '30s',
  }
}

function applyDockerOptions(
  service: Record<string, unknown>,
  env: Record<string, string>,
  settings: PostgresManagedSettings,
): void {
  const opts = settings.dockerOptions
  if (!opts) return

  if (opts.restart !== undefined) {
    service.restart = opts.restart
  }
  if (opts.stopGracePeriodSeconds !== undefined) {
    service.stop_grace_period = formatStopGracePeriod(
      opts.stopGracePeriodSeconds,
    )
  }
  if (opts.shmSizeBytes !== undefined) {
    service.shm_size = opts.shmSizeBytes
  }
  if (opts.ulimits?.nofile !== undefined) {
    service.ulimits = {
      nofile: {
        soft: opts.ulimits.nofile.soft,
        hard: opts.ulimits.nofile.hard,
      },
    }
  }
  if (opts.labels !== undefined) {
    service.labels = { ...opts.labels }
  }
  if (opts.extraEnv !== undefined) {
    for (const [key, value] of Object.entries(opts.extraEnv)) {
      env[key] = value
    }
  }
}

function buildRuntimeSpec(input: BuildRuntimeSpecInput): ManagedRuntimeSpec {
  const settings = input.settings as PostgresManagedSettings
  const initialDatabase = settings.initialDatabase ?? DEFAULT_DATABASE
  const image = settings.image ?? DEFAULT_IMAGE
  // Underscore-safe: SAFE_IDENTIFIER_RE / SAFE_VOLUME_NAME_RE disallow hyphens.
  const volumeName =
    `managed_${input.managedId.replaceAll('-', '_')}_data`
  const composeServiceName = 'postgres'

  const env: Record<string, string> = {
    POSTGRES_USER: input.rootUsername,
    POSTGRES_DB: initialDatabase,
    /** Placeholder only — plaintext must never appear in a runtime spec. */
    POSTGRES_PASSWORD: ManagedSecretPlaceholder,
  }

  const healthcheck = buildHealthcheck(input.rootUsername, initialDatabase)

  const service: Record<string, unknown> = {
    image,
    restart: settings.dockerOptions?.restart ?? 'unless-stopped',
    environment: env,
    command: ['postgres', '-c', `config_file=${CONFIG_CONTAINER_PATH}`],
    // Named volume at the parent path — PG18 stores data under $PGDATA
    // (mirrors daemon/orchestration/roles/postgres volume convention).
    volumes: [
      `${volumeName}:${DATA_VOLUME_TARGET}`,
      `./config:${CONFIG_DIR_CONTAINER}:ro`,
    ],
    healthcheck: {
      test: healthcheck.test,
      interval: healthcheck.interval,
      timeout: healthcheck.timeout,
      retries: healthcheck.retries,
      start_period: healthcheck.start_period,
    },
  }

  if (settings.ssl.enabled) {
    const volumes = service.volumes as string[]
    volumes.push(`./tls:${TLS_DIR_CONTAINER}:ro`)
  }

  applyDockerOptions(service, env, settings)
  service.environment = { ...env }

  if (settings.resources) {
    applyResourcesToComposeService(service, settings.resources)
  }

  // No `ports:` key ever — container listens on native 5432; exposure is
  // entirely the managed Traefik's job.
  const configContents = buildPlatformPostgresqlConf(settings)

  const spec: ManagedRuntimeSpec = {
    composeServiceName,
    service,
    volumes: [{ name: volumeName, target: DATA_VOLUME_TARGET }],
    configFiles: [
      {
        path: 'postgresql.conf',
        contents: configContents,
        mode: '0640',
      },
    ],
    env: { ...env },
    healthcheck,
    exposure: {
      enabled: settings.exposure.enabled,
      protocol: 'tcp',
      containerPort: DEFAULT_PORT,
      ...(settings.exposure.publishedPort !== undefined
        ? { publishedPort: settings.exposure.publishedPort }
        : {}),
      ...(settings.exposure.bind !== undefined
        ? { bind: settings.exposure.bind }
        : {}),
    },
  }

  if (settings.ssl.enabled) {
    spec.tlsMaterial = {
      selfSigned: true,
      commonName: 'managed-postgres',
      certPath: 'tls/server.crt',
      keyPath: 'tls/server.key',
    }
  }

  return spec
}

function buildConnectionInfo(
  input: BuildConnectionInfoInput,
): ManagedConnectionInfo {
  const sslmode = input.settings.ssl.enabled ? 'require' : 'prefer'
  const dsn =
    `postgresql://${encodeURIComponent(input.username)}:***@` +
    `${input.host}:${input.port}/${encodeURIComponent(input.database)}` +
    `?sslmode=${sslmode}`
  return {
    dsn,
    host: input.host,
    port: input.port,
    database: input.database,
    username: input.username,
  }
}

export const postgresEngineSpec: ManagedEngineSpec = {
  engine: 'postgres',
  displayName: 'PostgreSQL',
  defaultImage: DEFAULT_IMAGE,
  defaultPort: DEFAULT_PORT,
  principalProvider: 'postgres',
  rootUsername: ROOT_USERNAME,
  exposeProtocol: 'tcp',
  supportsSni: false,
  defaultSettings: {
    ...DEFAULT_MANAGED_SETTINGS,
    ssl: { enabled: false },
    exposure: { enabled: false },
  },
  parseSettings: parsePostgresSettings,
  buildRuntimeSpec,
  buildConnectionInfo,
  userOperations: USER_OPERATIONS,
  backup: {
    // Custom-format `pg_dump -Fc` — per-database only; whole-instance
    // `pg_dumpall` is a documented future seam (no `supportsInstanceScope`).
    artifactExtension: 'dump',
    supportsDatabaseScope: true,
    supportsInstanceScope: false,
    executor: {
      kind: 'docker-exec',
      dumpClient: 'pg_dump',
      restoreClient: 'pg_restore',
    },
    defaultRetentionKeep: 7,
    maxRetentionKeep: 50,
  },
}
