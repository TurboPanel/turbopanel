/**
 * Tenant managed MariaDB engine spec.
 *
 * Own SQL dialect module on the daemon side — never an alias of MySQL.
 * Spec shares only pure helpers (`mysql-family.ts`) with the MySQL engine.
 *
 * **Image:** the default MariaDB LTS series from the release catalog
 * (`./releases.ts`). MariaDB has never published an official Alpine-based
 * image, so the default stays on the upstream Debian-based tag; the
 * vendor-published UBI (Red Hat Universal Base Image) variant is the
 * documented alternative for hosts standardizing on an RPM-based/UBI-compatible
 * base.
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
  MARIADB_RESERVED_ENV_KEYS,
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

const DEFAULT_IMAGE = requireDefaultManagedImage('mariadb')
const DEFAULT_PORT = 3306
const ROOT_USERNAME = 'root'
const DEFAULT_DATABASE = 'appdb'
const COMPOSE_SERVICE_NAME = 'mariadb'
const PLATFORM_SOCKET_ADMIN = 'root'
const CONTAINER_USER = 'mysql'

const TLS_CERT_PATH = '/etc/mysql/tls/server.crt'
const TLS_KEY_PATH = '/etc/mysql/tls/server.key'
const TLS_CA_PATH = '/etc/mysql/tls/ca.crt'
const TLS_DIR_CONTAINER = '/etc/mysql/tls'
const DATA_VOLUME_TARGET = '/var/lib/mysql'

/** Same retention rationale as MySQL — MariaDB has no physical slots either. */
const BINLOG_EXPIRE_LOGS_SECONDS = 7 * 24 * 60 * 60

export type MariadbManagedSettings = ManagedSettings & {
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
  executor: { kind: 'docker-exec', client: 'mariadb' },
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

function parseMariadbSettings(value: unknown): MariadbManagedSettings | null {
  const base = parseManagedSettingsBase(
    value,
    MARIADB_RESERVED_ENV_KEYS,
    'mariadb',
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
  settings: MariadbManagedSettings,
  input: BuildRuntimeSpecInput,
): string {
  const serverId = input.member?.ordinal ?? 1
  const lines = [
    '# TurboPanel managed MariaDB — platform base (do not edit above the operator block)',
    '[mysqld]',
    'bind-address=0.0.0.0',
    'port=3306',
    'skip_name_resolve=ON',
    `server_id=${serverId}`,
    'log_bin=ON',
    'binlog_format=ROW',
    // MariaDB GTID vocabulary (not gtid_mode / enforce_gtid_consistency).
    'log_slave_updates=ON',
    'gtid_strict_mode=ON',
    `gtid_domain_id=${serverId}`,
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
 * MariaDB ships `unix_socket` built-in — no INSTALL PLUGIN required.
 */
function buildInitdbSql(): string {
  return [
    '-- TurboPanel managed MariaDB — platform socket-auth admin accounts',
    "CREATE USER IF NOT EXISTS 'root'@'localhost' IDENTIFIED VIA unix_socket;",
    "ALTER USER 'root'@'localhost' IDENTIFIED VIA unix_socket;",
    "GRANT ALL PRIVILEGES ON *.* TO 'root'@'localhost' WITH GRANT OPTION;",
    `CREATE USER IF NOT EXISTS '${CONTAINER_USER}'@'localhost' IDENTIFIED VIA unix_socket;`,
    `GRANT ALL PRIVILEGES ON *.* TO '${CONTAINER_USER}'@'localhost' WITH GRANT OPTION;`,
    'FLUSH PRIVILEGES;',
    '',
  ].join('\n')
}

function buildHealthcheck(): ManagedRuntimeHealthcheck {
  return {
    test: [
      'CMD-SHELL',
      `mariadb-admin ping --protocol=socket -u ${PLATFORM_SOCKET_ADMIN}`,
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
  settings: MariadbManagedSettings,
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
  const settings = input.settings as MariadbManagedSettings
  const initialDatabase = settings.initialDatabase ?? DEFAULT_DATABASE
  const image = settings.image ?? DEFAULT_IMAGE
  const volumeName = `managed_${input.managedId.replaceAll('-', '_')}_data`

  const env: Record<string, string> = {
    MARIADB_ROOT_PASSWORD: ManagedSecretPlaceholder,
    MARIADB_DATABASE: initialDatabase,
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

  if (input.member?.privateListener) {
    const { address, port } = input.member.privateListener
    service.ports = [`${address}:${port}:3306`]
  }

  applyDockerOptions(service, env, settings)
  service.environment = { ...env }

  if (settings.resources) {
    applyResourcesToComposeService(service, settings.resources)
  }

  const spec: ManagedRuntimeSpec = {
    composeServiceName: COMPOSE_SERVICE_NAME,
    service,
    volumes: [{ name: volumeName, target: DATA_VOLUME_TARGET }],
    configFiles: [
      {
        path: 'my.cnf',
        contents: buildPlatformMycnf(settings, input),
        mode: '0640',
      },
      {
        path: 'initdb/00-turbopanel.sql',
        contents: buildInitdbSql(),
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
      commonName: 'managed-mariadb',
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

export const mariadbEngineSpec: ManagedEngineSpec = {
  engine: 'mariadb',
  displayName: 'MariaDB',
  defaultImage: DEFAULT_IMAGE,
  defaultPort: DEFAULT_PORT,
  principalProvider: 'mysql',
  rootUsername: ROOT_USERNAME,
  exposeProtocol: 'tcp',
  defaultSettings: {
    ...DEFAULT_MANAGED_SETTINGS,
    exposure: { enabled: false },
  },
  parseSettings: parseMariadbSettings,
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
      dumpClient: 'mariadb-dump',
      restoreClient: 'mariadb',
    },
    defaultRetentionKeep: 7,
    maxRetentionKeep: 50,
  },
}
