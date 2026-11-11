/**
 * The admin tools TurboPanel can run for one Database Cluster: phpMyAdmin,
 * Adminer and pgAdmin, each as an ordinary compose deploy.
 *
 * Everything here is constant data and pure functions (no I/O at module load),
 * so it is safe to import from Workers-reachable code. Each tool is one service
 * named `tool`, bound to its own login with binding prefix `DB` and no preset,
 * so the only database names it sees are `{$DB_HOST}`, `{$DB_PORT}`,
 * `{$DB_NAME}`, `{$DB_USER}`, `{$DB_PASSWORD}` and `{$DB_CA_CERT}`.
 *
 * Every tool verifies the proxy's certificate and its name against the
 * Organization CA file, whatever the cluster's SSL mode: the proxy always
 * offers TLS and its certificate names its own container.
 */

import {
  type ComposeDocument,
  emptyComposeDocument,
  escapeLiteralComposeValue,
} from '../../compose/index.ts'

export type AdminToolId = 'phpmyadmin' | 'adminer' | 'pgadmin'

export type AdminToolDefinition = {
  /** Shown in the web interface and used in the project name. */
  label: string
  /** Managed engine codes the tool can talk to. */
  engines: readonly string[]
  /** The pinned image. Updating a pin is a one-line change plus a canary check. */
  image: string
  /** Port inside the container the hosting forwards to. */
  port: number
}

export const ADMIN_TOOLS: Readonly<Record<AdminToolId, AdminToolDefinition>> = {
  phpmyadmin: {
    label: 'phpMyAdmin',
    engines: ['mysql', 'mariadb'],
    image: 'phpmyadmin:5.2.3',
    port: 80,
  },
  adminer: {
    label: 'Adminer',
    engines: ['mysql', 'mariadb', 'postgres'],
    image: 'adminer:6.3.0',
    port: 8080,
  },
  pgadmin: {
    label: 'pgAdmin',
    engines: ['postgres'],
    image: 'dpage/pgadmin4:9.19',
    port: 8080,
  },
}

/** The compose service name every tool uses. */
export const ADMIN_TOOL_SERVICE = 'tool'
/** The binding key prefix every tool uses. */
export const ADMIN_TOOL_BINDING_PREFIX = 'DB'
/** `project.metadata.code` that marks a project as an admin tool. */
export const ADMIN_TOOL_PROJECT_CODE = 'admin-tool'
/** The environment secret that holds pgAdmin's web sign-in password. */
export const ADMIN_TOOL_WEB_PASSWORD_KEY = 'TOOL_WEB_PASSWORD'

export type AdminToolComposeInput = {
  tool: AdminToolId
  /** The engine code of the cluster (`mysql`, `mariadb` or `postgres`). */
  engine: string
  hostname: string
  /** pgAdmin's sign-in email; ignored by the other tools. */
  email?: string
  /** Bumped on Reset Password and Update Tool so the container is recreated. */
  revision: number
}

type ComposeData = Record<string, unknown>

export function isAdminToolId(value: unknown): value is AdminToolId {
  return typeof value === 'string' && Object.hasOwn(ADMIN_TOOLS, value)
}

export function adminToolFitsEngine(tool: AdminToolId, engine: string): boolean {
  return ADMIN_TOOLS[tool].engines.includes(engine)
}

function hostingFor(tool: AdminToolId, hostname: string): ComposeData {
  return {
    hosting: [{ hostname, targetPort: ADMIN_TOOLS[tool].port }],
  }
}

function baseService(input: AdminToolComposeInput): ComposeData {
  return {
    image: ADMIN_TOOLS[input.tool].image,
    restart: 'unless-stopped',
    'x-turbopanel': hostingFor(input.tool, input.hostname),
  }
}

function phpmyadminData(input: AdminToolComposeInput): ComposeData {
  return {
    services: {
      [ADMIN_TOOL_SERVICE]: {
        ...baseService(input),
        environment: {
          PMA_HOST: '{$DB_HOST}',
          PMA_PORT: '{$DB_PORT}',
          PMA_SSL: '1',
          PMA_SSL_VERIFY: '1',
          PMA_SSL_CA: '/run/secrets/DB_CA_CERT',
          UPLOAD_LIMIT: '64M',
          ADMIN_TOOL_REVISION: String(input.revision),
        },
      },
    },
  }
}

const ADMINER_PLUGIN_DIR = '/var/www/html/plugins-enabled'

function adminerServersPlugin(driver: 'server' | 'pgsql'): string {
  return [
    '<?php',
    "require_once 'plugins/login-servers.php';",
    `return new AdminerLoginServers(['Database Cluster' => ['server' => '{$DB_HOST}:{$DB_PORT}', 'driver' => '${driver}']]);`,
    '',
  ].join('\n')
}

function adminerSslPlugin(engine: string): string {
  const options =
    engine === 'postgres'
      ? "['mode' => 'verify-full']"
      : "['ca' => '/run/secrets/DB_CA_CERT', 'verify' => true]"
  return [
    '<?php',
    "require_once 'plugins/login-ssl.php';",
    `return new AdminerLoginSsl(${options});`,
    '',
  ].join('\n')
}

function adminerData(input: AdminToolComposeInput): ComposeData {
  const isPostgres = input.engine === 'postgres'
  return {
    configs: {
      adminer_servers: { content: adminerServersPlugin(isPostgres ? 'pgsql' : 'server') },
      adminer_ssl: { content: adminerSslPlugin(input.engine) },
    },
    services: {
      [ADMIN_TOOL_SERVICE]: {
        ...baseService(input),
        environment: {
          ...(isPostgres ? { PGSSLROOTCERT: '/run/secrets/DB_CA_CERT' } : {}),
          ADMIN_TOOL_REVISION: String(input.revision),
        },
        configs: [
          { source: 'adminer_servers', target: `${ADMINER_PLUGIN_DIR}/login-servers.php` },
          { source: 'adminer_ssl', target: `${ADMINER_PLUGIN_DIR}/login-ssl.php` },
        ],
      },
    },
  }
}

const PGADMIN_SERVERS_JSON = [
  '{"Servers": {"1": {"Name": "Database Cluster", "Group": "Servers",',
  ' "Host": "{$DB_HOST}", "Port": {$DB_PORT}, "MaintenanceDB": "{$DB_NAME}",',
  ' "Username": "{$DB_USER}", "SSLMode": "verify-full",',
  ' "ConnectionParameters": {"sslmode": "verify-full",',
  '  "sslrootcert": "/run/secrets/DB_CA_CERT", "passfile": "/.pgpass"}}}}',
  '',
].join('\n')

const PGADMIN_PGPASS = '{$DB_HOST}:{$DB_PORT}:*:{$DB_USER}:{$DB_PASSWORD}\n'

function pgadminData(input: AdminToolComposeInput): ComposeData {
  return {
    configs: {
      pgadmin_servers: { content: PGADMIN_SERVERS_JSON },
      pgadmin_pgpass: { content: PGADMIN_PGPASS },
    },
    services: {
      [ADMIN_TOOL_SERVICE]: {
        ...baseService(input),
        environment: {
          PGADMIN_DEFAULT_EMAIL: escapeLiteralComposeValue(input.email ?? ''),
          // A secret reference: the container gets only the `_FILE` form.
          PGADMIN_DEFAULT_PASSWORD: `{$${ADMIN_TOOL_WEB_PASSWORD_KEY}}`,
          PGADMIN_LISTEN_PORT: String(ADMIN_TOOLS.pgadmin.port),
          PGADMIN_REPLACE_SERVERS_ON_STARTUP: 'True',
          PGADMIN_CONFIG_SERVER_MODE: 'True',
          PGPASS_FILE: '/pgadmin4/pgpass',
          ADMIN_TOOL_REVISION: String(input.revision),
        },
        configs: [
          { source: 'pgadmin_servers', target: '/pgadmin4/servers.json' },
          { source: 'pgadmin_pgpass', target: '/pgadmin4/pgpass' },
        ],
      },
    },
  }
}

const BUILDERS: Readonly<Record<AdminToolId, (input: AdminToolComposeInput) => ComposeData>> = {
  phpmyadmin: phpmyadminData,
  adminer: adminerData,
  pgadmin: pgadminData,
}

/**
 * The environment overlay for one tool. The tool must fit the engine (the
 * caller checks with {@link adminToolFitsEngine}); a mismatch throws so a
 * template never ships a wrong driver.
 */
export function adminToolCompose(input: AdminToolComposeInput): ComposeDocument {
  if (!adminToolFitsEngine(input.tool, input.engine)) {
    throw new TypeError(`${input.tool} does not work with ${input.engine}`)
  }
  const document = emptyComposeDocument()
  document.data = BUILDERS[input.tool](input)
  return document
}

/** Words a pgAdmin sign-in email may not end with (special-use names fail its own check). */
const SPECIAL_USE_SUFFIXES: readonly string[] = [
  '.test',
  '.example',
  '.invalid',
  '.localhost',
  '.local',
  '.internal',
  '.onion',
  '.arpa',
]

/** True when pgAdmin would accept the address as a sign-in email at first run. */
export function isAcceptablePgAdminEmail(email: string): boolean {
  const at = email.lastIndexOf('@')
  if (at < 1 || at === email.length - 1 || /\s/u.test(email)) return false
  const domain = email.slice(at + 1).toLowerCase()
  if (!domain.includes('.')) return false
  return !SPECIAL_USE_SUFFIXES.some((suffix) => domain.endsWith(suffix) || `.${domain}` === suffix)
}
