/**
 * Tenant managed MySQL engine spec.
 *
 * Completely independent of any control-plane MySQL container — this is a
 * per-environment tenant service provisioned via the managed registry.
 *
 * Socket-auth platform accounts (see `initdb/00-turbopanel.sql`) are the
 * MySQL analogue of Postgres `local … trust` so daemon SQL/backup paths stay
 * credential-free. MySQL has no replication slots — bounded
 * `binlog_expire_logs_seconds` is the disk-fill hazard that slots cover on
 * Postgres.
 *
 * **Image:** the default MySQL LTS series from the release catalog
 * (`./releases.ts`). The Docker Official `mysql` image has never published an
 * Alpine variant (it was Debian-only even before 8.0, and Oracle explicitly
 * ships only glibc-linked builds), so the default stays on the upstream
 * Debian-based tag; the Oracle Linux 9 variant is the documented alternative
 * for hosts standardizing on an RPM-based/UBI-compatible base.
 */

import { applyResourcesToComposeService } from '../compose/apply-service-options.ts'
import {
  formatInnoDbBufferPoolSize,
  isValidMysqlCnfSnippet,
  isValidMysqlIdentifier,
  MYSQL_ACCOUNT_MAX_LENGTH,
  MYSQL_IDENTIFIER_PATTERN,
} from './mysql-family.ts'
import { requireDefaultManagedImage } from './releases.ts'
import { mysqlFamilySslMode } from './ssl.ts'
import {
  DEFAULT_MANAGED_SETTINGS,
  type ManagedSettings,
  MYSQL_RESERVED_ENV_KEYS,
  parseManagedSettingsBase,
} from './settings.ts'
import {
  type BuildConnectionInfoInput,
  type BuildRuntimeSpecInput,
  type ManagedConnectionInfo,
  type ManagedEngineSpec,
  type ManagedRuntimeHealthcheck,
  type ManagedRuntimeSpec,
  ManagedSecretPlaceholder,
  type ManagedUserOperations,
} from './types.ts'

const DEFAULT_IMAGE = requireDefaultManagedImage('mysql')
const DEFAULT_PORT = 3306
const ROOT_USERNAME = 'root'
const DEFAULT_DATABASE = 'appdb'
const COMPOSE_SERVICE_NAME = 'mysql'

/**
 * Platform socket-auth admin used by waitReady / healthcheck / SQL paths.
 * Matches the default `docker exec` OS user (root) via auth_socket.
 */
const PLATFORM_SOCKET_ADMIN = 'root'
/** Container engine user used by backup.ts `docker exec -u mysql`. */
const CONTAINER_USER = 'mysql'

const TLS_CERT_PATH = '/etc/mysql/tls/server.crt'
const TLS_KEY_PATH = '/etc/mysql/tls/server.key'
const TLS_CA_PATH = '/etc/mysql/tls/ca.crt'
const TLS_DIR_CONTAINER = '/etc/mysql/tls'
const DATA_VOLUME_TARGET = '/var/lib/mysql'

/**
 * Bounded binlog retention (7 days). MySQL has no physical replication slots;
 * without this the binary log grows unbounded under continuous write load and
 * is the disk-fill hazard that slots represent on Postgres.
 */
const BINLOG_EXPIRE_LOGS_SECONDS = 7 * 24 * 60 * 60

export type MysqlManagedSettings = ManagedSettings & {
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
    quote: '`',
    maxLength: MYSQL_ACCOUNT_MAX_LENGTH,
    pattern: MYSQL_IDENTIFIER_PATTERN,
  },
  executor: { kind: 'docker-exec', client: 'mysql' },
}

const MYSQL_FAMILY_SYSTEM_SCHEMAS = new Set([
  'mysql',
  'information_schema',
  'performance_schema',
  'sys',
])

function parseInitialDatabase(value: unknown): string | null {
  if (value === undefined) return DEFAULT_DATABASE
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!isValidMysqlIdentifier(trimmed)) return null
  // Never default/store a system schema as the application database.
  if (MYSQL_FAMILY_SYSTEM_SCHEMAS.has(trimmed.toLowerCase())) return null
  return trimmed
}

function asSettingsRecord(
  value: unknown,
): Record<string, unknown> | undefined | null {
  if (value === null || value === undefined) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function parseMysqlSettings(value: unknown): MysqlManagedSettings | null {
  const base = parseManagedSettingsBase(
    value,
    MYSQL_RESERVED_ENV_KEYS,
    'mysql',
  )
  if (base === null) return null

  const record = asSettingsRecord(value)
  if (record === null) return null

  const initialDatabase = parseInitialDatabase(record?.initialDatabase)
  if (initialDatabase === null) return null

  if (
    base.engineConfig !== undefined &&
    !isValidMysqlCnfSnippet(base.engineConfig)
  ) {
    return null
  }

  return { ...base, initialDatabase }
}

function formatStopGracePeriod(seconds: number): string {
  return `${seconds}s`
}

function buildPlatformMycnf(
  settings: MysqlManagedSettings,
  input: BuildRuntimeSpecInput,
): string {
  const serverId = input.member?.ordinal ?? 1
  const lines = [
    '# TurboPanel managed MySQL — platform base (do not edit above the operator block)',
    '[mysqld]',
    'bind-address=0.0.0.0',
    'port=3306',
    // Peers dial by IP — skip reverse DNS that would hang apply on private nets.
    'skip_name_resolve=ON',
    // Deterministic ProxySQL backend handshake (MySQL 8 default is caching_sha2).
    'authentication_policy=caching_sha2_password,,',
    `server_id=${serverId}`,
    'log_bin=ON',
    'binlog_format=ROW',
    'gtid_mode=ON',
    'enforce_gtid_consistency=ON',
    'log_replica_updates=ON',
    // No replication slots — retain binlogs long enough for a lagging standby
    // to catch up without unbounded disk growth (see module header).
    `binlog_expire_logs_seconds=${BINLOG_EXPIRE_LOGS_SECONDS}`,
  ]

  const memoryBytes = settings.resources?.memoryBytes
  if (memoryBytes !== undefined && memoryBytes > 0) {
    lines.push(
      `innodb_buffer_pool_size=${formatInnoDbBufferPoolSize(memoryBytes)}`,
    )
  }

  // Engine TLS is unconditional — ProxySQL dials backends with `use_ssl=1`,
  // so the engine leg always requires an encrypted transport. Client-facing
  // policy (`ManagedSslMode`) is enforced at the ProxySQL frontend.
  lines.push(
    `ssl_ca=${TLS_CA_PATH}`,
    `ssl_cert=${TLS_CERT_PATH}`,
    `ssl_key=${TLS_KEY_PATH}`,
    'require_secure_transport=ON',
  )

  if (input.member?.role === 'standby') {
    lines.push('read_only=ON', 'super_read_only=ON')
  }

  lines.push('', '# --- operator config ---')
  if (settings.engineConfig !== undefined && settings.engineConfig.length > 0) {
    lines.push(settings.engineConfig.replace(/\n$/, ''))
  }

  return `${lines.join('\n')}\n`
}

/**
 * Secret-free bootstrap: install auth_socket and create OS-user-matched
 * password-less platform accounts for docker exec (root) and backup
 * (`mysql` container user). Never embeds plaintext credentials.
 */
function buildInitdbSql(): string {
  return [
    '-- TurboPanel managed MySQL — platform socket-auth admin accounts',
    "INSTALL PLUGIN IF NOT EXISTS auth_socket SONAME 'auth_socket.so';",
    // default docker exec (root OS user) → password-less MySQL admin
    "CREATE USER IF NOT EXISTS 'root'@'localhost' IDENTIFIED WITH auth_socket;",
    "ALTER USER 'root'@'localhost' IDENTIFIED WITH auth_socket;",
    "GRANT ALL PRIVILEGES ON *.* TO 'root'@'localhost' WITH GRANT OPTION;",
    // backup.ts `docker exec -u mysql` → same shape for the engine OS user
    `CREATE USER IF NOT EXISTS '${CONTAINER_USER}'@'localhost' IDENTIFIED WITH auth_socket;`,
    `GRANT ALL PRIVILEGES ON *.* TO '${CONTAINER_USER}'@'localhost' WITH GRANT OPTION;`,
    'FLUSH PRIVILEGES;',
    '',
  ].join('\n')
}

function buildHealthcheck(): ManagedRuntimeHealthcheck {
  return {
    test: [
      'CMD-SHELL',
      `mysqladmin ping --protocol=socket -u ${PLATFORM_SOCKET_ADMIN}`,
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
  settings: MysqlManagedSettings,
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
  const settings = input.settings as MysqlManagedSettings
  const initialDatabase = settings.initialDatabase ?? DEFAULT_DATABASE
  const image = settings.image ?? DEFAULT_IMAGE
  // Underscore-safe: SAFE_IDENTIFIER_RE / SAFE_VOLUME_NAME_RE disallow hyphens.
  const volumeName = `managed_${input.managedId.replaceAll('-', '_')}_data`

  const env: Record<string, string> = {
    /** Placeholder only — plaintext must never appear in a runtime spec. */
    MYSQL_ROOT_PASSWORD: ManagedSecretPlaceholder,
    // Never MYSQL_USER / MYSQL_PASSWORD — client accounts come from applyCredentials.
    MYSQL_DATABASE: initialDatabase,
  }

  const healthcheck = buildHealthcheck()

  const service: Record<string, unknown> = {
    image,
    restart: settings.dockerOptions?.restart ?? 'unless-stopped',
    environment: env,
    volumes: [
      `${volumeName}:${DATA_VOLUME_TARGET}`,
      './config/my.cnf:/etc/mysql/conf.d/zz-turbopanel.cnf:ro',
      './config/initdb:/docker-entrypoint-initdb.d:ro',
    ],
    healthcheck: {
      test: healthcheck.test,
      interval: healthcheck.interval,
      timeout: healthcheck.timeout,
      retries: healthcheck.retries,
      start_period: healthcheck.start_period,
    },
  }

  const volumes = service.volumes as string[]
  volumes.push(`./tls:${TLS_DIR_CONTAINER}:ro`)

  // Private listener: multi-member only (shared platform rule — never remap
  // the native 3306 inside the container).
  if (input.member?.privateListener) {
    const { address, port } = input.member.privateListener
    service.ports = [`${address}:${port}:3306`]
  }

  applyDockerOptions(service, env, settings)
  service.environment = { ...env }

  if (settings.resources) {
    applyResourcesToComposeService(service, settings.resources)
  }

  const confContents = buildPlatformMycnf(settings, input)
  const initdbContents = buildInitdbSql()

  const spec: ManagedRuntimeSpec = {
    composeServiceName: COMPOSE_SERVICE_NAME,
    service,
    volumes: [{ name: volumeName, target: DATA_VOLUME_TARGET }],
    configFiles: [
      {
        path: 'my.cnf',
        contents: confContents,
        mode: '0640',
      },
      {
        path: 'initdb/00-turbopanel.sql',
        contents: initdbContents,
        mode: '0640',
      },
    ],
    env: { ...env },
    healthcheck,
    exposure: {
      enabled: settings.exposure.enabled,
      protocol: 'tcp',
      containerPort: DEFAULT_PORT,
      ...(settings.exposure.scope !== undefined ? { scope: settings.exposure.scope } : {}),
    },
  }

  if (!input.useOrgTls) {
    spec.tlsMaterial = {
      selfSigned: true,
      commonName: 'managed-mysql',
      certPath: 'tls/server.crt',
      keyPath: 'tls/server.key',
    }
  }

  return spec
}

function buildConnectionInfo(
  input: BuildConnectionInfoInput,
): ManagedConnectionInfo {
  const dsn = `mysql://${encodeURIComponent(input.username)}:***@` +
    `${input.host}:${input.port}/${encodeURIComponent(input.database)}` +
    `?ssl-mode=${mysqlFamilySslMode(input.sslMode)}`
  return {
    dsn,
    host: input.host,
    port: input.port,
    database: input.database,
    username: input.username,
  }
}

function buildBindingDsn(
  input: BuildConnectionInfoInput & { password: string },
): string {
  return (
    `mysql://${encodeURIComponent(input.username)}:` +
    `${encodeURIComponent(input.password)}@` +
    `${input.host}:${input.port}/${encodeURIComponent(input.database)}` +
    `?ssl-mode=${mysqlFamilySslMode(input.sslMode)}`
  )
}

export const mysqlEngineSpec: ManagedEngineSpec = {
  engine: 'mysql',
  displayName: 'MySQL',
  defaultImage: DEFAULT_IMAGE,
  defaultPort: DEFAULT_PORT,
  principalProvider: 'mysql',
  rootUsername: ROOT_USERNAME,
  exposeProtocol: 'tcp',
  defaultSettings: {
    ...DEFAULT_MANAGED_SETTINGS,
    exposure: { enabled: false },
  },
  parseSettings: parseMysqlSettings,
  buildRuntimeSpec,
  buildConnectionInfo,
  formatSslMode: mysqlFamilySslMode,
  userOperations: USER_OPERATIONS,
  binding: {
    scheme: 'mysql',
    unprefixed: {
      host: 'MYSQL_HOST',
      port: 'MYSQL_PORT',
      database: 'MYSQL_DATABASE',
      user: 'MYSQL_USER',
      password: 'MYSQL_PASSWORD', // NOSONAR typescript:S2068 — env var name, not a credential
    },
    buildBindingDsn,
  },
  backup: {
    artifactExtension: 'sql',
    supportsDatabaseScope: true,
    supportsInstanceScope: false,
    executor: {
      kind: 'docker-exec',
      dumpClient: 'mysqldump',
      restoreClient: 'mysql',
    },
    defaultRetentionKeep: 7,
    maxRetentionKeep: 50,
  },
}

export { BINLOG_EXPIRE_LOGS_SECONDS }
