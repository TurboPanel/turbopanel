/**
 * Tenant managed PostgreSQL engine spec.
 *
 * Completely independent of the control-plane `turbopanel-database` container —
 * this is a per-environment tenant service provisioned via the managed registry.
 *
 * **Image:** PostgreSQL 18 (approved — see `POSTGRES_ALLOWED_IMAGES` in
 * `./settings.ts`). The official Alpine variant stays the default for its
 * smaller footprint; the Debian-based variant is the documented alternative.
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
const CONF_SETTING_LINE_RE = /^\s*[A-Za-z_]\w*\s*=.+$/
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
  'wal_level',
  'max_wal_senders',
  'max_replication_slots',
  'hot_standby',
  'wal_log_hints',
  'primary_conninfo',
  'primary_slot_name',
])

/** Docker bridge CIDR for hostssl ProxySQL client access on turbopanel-managed. */
const MANAGED_DOCKER_NETWORK_CIDR = '172.16.0.0/12' // NOSONAR typescript:S1313 — Docker's default bridge-network address space, not a real host

const HBA_FILE_PATH = '/etc/postgresql/pg_hba.conf'
const SSL_ROOTCERT_PATH = '/etc/postgresql/tls/ca.crt'

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
  const base = parseManagedSettingsBase(value, POSTGRES_RESERVED_ENV_KEYS, 'postgres')
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
  input: BuildRuntimeSpecInput,
): string {
  const lines = [
    "# TurboPanel managed PostgreSQL — platform base (do not edit above the operator block)",
    "listen_addresses = '*'",
    'port = 5432',
    "hba_file = '/etc/postgresql/pg_hba.conf'",
    // Streaming replication (primary and standby) — always on so a single-member
    // cluster can grow to multi-member without a restart-level wal_level change.
    "wal_level = replica",
    'max_wal_senders = 10',
    // MANAGED_MAX_REPLICAS (2) + 1 headroom for resync / promotion.
    'max_replication_slots = 4',
    'hot_standby = on',
    'wal_log_hints = on',
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

  if (settings.ssl.enabled || input.useOrgTls || input.member?.privateListener) {
    lines.push(
      'ssl = on',
      `ssl_cert_file = '${TLS_CERT_PATH}'`,
      `ssl_key_file = '${TLS_KEY_PATH}'`,
    )
    if (input.useOrgTls) {
      lines.push(`ssl_ca_file = '${SSL_ROOTCERT_PATH}'`)
    }
  }

  const replication = input.member?.replication
  if (input.member?.role === 'standby' && replication?.primary && replication.slotName) {
    // No password/passfile in conf — durable plaintext secrets under managed
    // state are forbidden. `pg_basebackup -R` seeds password-bearing
    // primary_conninfo into the data volume's postgresql.auto.conf (not under
    // managed/<id>/auth). Platform conf supplies host / hostaddr / TLS paths
    // so re-apply can retarget the primary without re-storing secrets.
    const primary = replication.primary
    const hostaddr =
      primary.hostaddr !== undefined
        ? ` hostaddr=${primary.hostaddr}`
        : ''
    const conninfo =
      `user=${replication.username} host=${primary.host}${hostaddr} ` +
      `port=${primary.port} sslmode=verify-full sslrootcert=${SSL_ROOTCERT_PATH}`
    lines.push(
      `primary_conninfo = '${conninfo.replaceAll("'", "''")}'`,
      `primary_slot_name = '${replication.slotName}'`,
    )
  }

  lines.push('', '# --- operator config ---')
  if (settings.engineConfig !== undefined && settings.engineConfig.length > 0) {
    lines.push(settings.engineConfig.replace(/\n$/, ''))
  }

  return `${lines.join('\n')}\n`
}

/**
 * Host-specific HBA address for a peer literal.
 * IPv4 → /32, IPv6 → /128. Co-resident container names are not address literals.
 */
function peerHbaAddress(peer: string): string | null {
  if (peer.includes('.')) {
    // IPv4 literal (possibly with zone/port already absent).
    return `${peer}/32`
  }
  if (peer.includes(':')) {
    // IPv6 literal — host-specific rules use /128, not /32.
    return `${peer}/128`
  }
  return null
}

/**
 * Platform-owned pg_hba.conf. Owning HBA is required so the private listener
 * can be published safely (replication entries + SSL-only managed-net users).
 *
 * Note: `hostssl all …` does **not** match physical replication connections
 * (`database = replication`). Co-resident standbys need an explicit
 * `hostssl replication …` rule on the managed Docker network CIDR.
 */
function buildPlatformPgHba(
  input: BuildRuntimeSpecInput,
  rootUsername: string,
): string {
  const lines = [
    '# TurboPanel managed PostgreSQL — platform pg_hba (do not edit)',
    '# local socket for engine admin',
    `local   all             ${rootUsername}                                trust`,
    'local   all             all                                     peer',
    `# ProxySQL / co-resident clients on turbopanel-managed (${MANAGED_DOCKER_NETWORK_CIDR})`,
    `hostssl all             all             ${MANAGED_DOCKER_NETWORK_CIDR}       scram-sha-256`,
  ]

  const peerAddresses = input.member?.replication?.peerAddresses ?? []
  const replUser = input.member?.replication?.username
  if (replUser && peerAddresses.length > 0) {
    let hasLocalPeer = false
    for (const peer of peerAddresses) {
      const addr = peerHbaAddress(peer)
      if (addr) {
        lines.push(
          `hostssl replication     ${replUser}        ${addr}                 scram-sha-256`,
        )
      } else {
        hasLocalPeer = true
      }
    }
    if (hasLocalPeer) {
      // Co-resident standbys dial via Docker DNS (container name). Physical
      // replication uses database=replication, which is not covered by
      // `hostssl all` above.
      lines.push(
        `hostssl replication     ${replUser}        ${MANAGED_DOCKER_NETWORK_CIDR}       scram-sha-256`,
      )
    }
  }

  // Reject everything else over the published private listener.
  lines.push(
    'host    all             all             all                     reject',
    '',
  )
  return lines.join('\n')
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

  // `POSTGRES_USER` seeds the container's bootstrap superuser and is deliberately
  // the stable platform admin role (`ROOT_USERNAME` = "postgres"), never
  // `input.rootUsername`. The docker-library postgres image creates exactly one
  // bootstrap superuser named by `POSTGRES_USER` — it does not additionally
  // create a role called "postgres" when that variable differs. The daemon's
  // admin paths (waitReady/psql/pg_dump/pg_restore/promote/replication health —
  // `daemon/src/managed/apply.ts`, `backup.ts`, `promote.ts`, `containers.ts`)
  // all connect as the engine spec's static `rootUsername` ("postgres"), so
  // changing the container's actual superuser role out from under them would
  // leave every admin command targeting a role that no longer exists. The
  // user-facing "root" principal (`input.rootUsername`, suffixed when it
  // collides with another cluster in the same owning-org ProxySQL namespace —
  // see `resolveAvailableManagedRootUsername`) is instead created as a
  // *separate* SUPERUSER role via SQL in `applyOneCredential` (daemon
  // `engines/postgres.ts`, `credential.role === 'root'`), connecting as this
  // stable admin — the same platform-admin-vs-frontend-login split MySQL/
  // MariaDB already use (`root@localhost` auth_socket vs. a granted client
  // account). See `AGENTS.md` → "Managed root username" for the full contract.
  const env: Record<string, string> = {
    POSTGRES_USER: ROOT_USERNAME,
    POSTGRES_DB: initialDatabase,
    /** Placeholder only — plaintext must never appear in a runtime spec. */
    POSTGRES_PASSWORD: ManagedSecretPlaceholder,
  }

  const healthcheck = buildHealthcheck(ROOT_USERNAME, initialDatabase)

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

  const needTls =
    settings.ssl.enabled ||
    input.useOrgTls === true ||
    input.member?.privateListener !== undefined
  if (needTls) {
    const volumes = service.volumes as string[]
    volumes.push(`./tls:${TLS_DIR_CONTAINER}:ro`)
  }

  // Private listener: the one deliberate exception to "no published engine ports".
  // Multi-member only — binds solely on the member's private address at the
  // instance-allocated `private_port` (cross-host replication + ProxySQL backends).
  if (input.member?.privateListener) {
    const { address, port } = input.member.privateListener
    service.ports = [`${address}:${port}:5432`]
  }

  applyDockerOptions(service, env, settings)
  service.environment = { ...env }

  if (settings.resources) {
    applyResourcesToComposeService(service, settings.resources)
  }

  const configContents = buildPlatformPostgresqlConf(settings, input)
  // Local-socket trust is for the daemon's platform-admin exec path, not the
  // (possibly suffixed) user-facing root principal — see the `POSTGRES_USER`
  // comment above.
  const hbaContents = buildPlatformPgHba(input, ROOT_USERNAME)

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
      {
        path: 'pg_hba.conf',
        contents: hbaContents,
        mode: '0640',
      },
    ],
    env: { ...env },
    healthcheck,
    exposure: {
      enabled: settings.exposure.enabled,
      protocol: 'tcp',
      containerPort: DEFAULT_PORT,
      ...(settings.exposure.bind !== undefined
        ? { bind: settings.exposure.bind }
        : {}),
    },
  }

  if (needTls && !input.useOrgTls) {
    // Self-signed fallback for single-member clusters with no org material.
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
  // Match bindings / runtime: verify-full when TLS is on (default).
  const sslmode = input.settings.ssl.enabled ? 'verify-full' : 'prefer'
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

function buildBindingDsn(
  input: BuildConnectionInfoInput & { password: string },
): string {
  return (
    `postgresql://${encodeURIComponent(input.username)}:` +
    `${encodeURIComponent(input.password)}@` +
    `${input.host}:${input.port}/${encodeURIComponent(input.database)}` +
    `?sslmode=verify-full`
  )
}

export const postgresEngineSpec: ManagedEngineSpec = {
  engine: 'postgres',
  displayName: 'PostgreSQL',
  defaultImage: DEFAULT_IMAGE,
  defaultPort: DEFAULT_PORT,
  principalProvider: 'postgres',
  rootUsername: ROOT_USERNAME,
  exposeProtocol: 'tcp',
  defaultSettings: {
    ...DEFAULT_MANAGED_SETTINGS,
    exposure: { enabled: false },
  },
  parseSettings: parsePostgresSettings,
  buildRuntimeSpec,
  buildConnectionInfo,
  userOperations: USER_OPERATIONS,
  binding: {
    scheme: 'postgresql',
    unprefixed: {
      host: 'PGHOST',
      port: 'PGPORT',
      database: 'PGDATABASE',
      user: 'PGUSER',
      password: 'PGPASSWORD', // NOSONAR typescript:S2068 — env var name, not a credential
      sslMode: 'PGSSLMODE',
    },
    buildBindingDsn,
  },
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
