import { generatePassword } from '../../../generate-secret.ts'
import type { ComposeDocument } from '../../../lib/compose/index.ts'

export const CREATE_PROJECT_TYPES = ['docker-compose', 'template', 'managed'] as const
export type CreateProjectType = (typeof CREATE_PROJECT_TYPES)[number]

/**
 * Catalog variable declaration.
 *
 * Secret variables omit `value` — scaffold generates a high-entropy plaintext
 * at create time (never ship static placeholders like `changeme`). Variables
 * that must share one credential set the same `sharedCredentialId`.
 */
export type CatalogVariable = {
  key: string
  isSecret: boolean
  /** Plaintext default for non-secret variables only. */
  value?: string
  /**
   * When set on secret variables, all variables sharing this id reuse one
   * generated credential within a single scaffold pass.
   */
  sharedCredentialId?: string
}

export type CatalogEnvironment = {
  displayName: string
  description?: string
  compose?: ComposeDocument
  variables?: CatalogVariable[]
}

export type CatalogEntry = {
  code: string
  kind: 'managed' | 'template'
  displayName: string
  description: string
  compose: ComposeDocument
  options?: Record<string, unknown>
  environments: CatalogEnvironment[]
}

export type CatalogSummary = {
  code: string
  kind: CatalogEntry['kind']
  displayName: string
  description: string
}

/** Managed engine codes — environment-scoped services, not project-scoped catalog apps. */
export const MANAGED_ENGINE_CODES = [
  'postgres',
  'mysql',
  'mariadb',
  'redis',
  'clickhouse',
] as const

export type ManagedEngineCode = (typeof MANAGED_ENGINE_CODES)[number]

function composeDocument(data: Record<string, unknown>): ComposeDocument {
  return {
    version: 1,
    data,
    presentation: {
      keyOrder: Object.keys(data),
      comments: {},
    },
  }
}

/**
 * True for environment-scoped managed engine catalog entries (Postgres, MySQL,
 * …). These scaffold a project + first environment only — no project-scoped
 * `managed` row / `managed_id`. Legacy catalog apps (e.g. wordpress-mysql)
 * remain on the project-scoped managed marker path.
 */
export function isManagedEngineCatalogEntry(
  entry: CatalogEntry,
): entry is CatalogEntry & { code: ManagedEngineCode } {
  return (
    entry.kind === 'managed' &&
    (MANAGED_ENGINE_CODES as readonly string[]).includes(entry.code)
  )
}

/**
 * Engine metadata stored on managed-engine catalog `options`.
 *
 * `provider` is the `principal.provider` CHECK value (`pam` \| `postgres` \|
 * `mysql` \| `redis`) — not necessarily the same string as `engine`. ClickHouse
 * uses `provider: 'postgres'` because `principal_provider_check` has no
 * clickhouse variant; engine ≠ provider by design.
 */
export type ManagedEngineOptions = {
  engine: ManagedEngineCode
  rootUsername: string
  provider: string
  port: number
}

const PRINCIPAL_PROVIDERS = new Set(['pam', 'postgres', 'mysql', 'redis'])

/**
 * Validate and return managed-engine options from a catalog entry, or `null`
 * when the entry is not an engine catalog row / fields are incomplete.
 */
export function readManagedEngineOptions(
  entry: CatalogEntry,
): ManagedEngineOptions | null {
  if (!isManagedEngineCatalogEntry(entry)) return null
  const options = entry.options
  if (!options || typeof options !== 'object') return null

  const engine = options.engine
  const rootUsername = options.rootUsername
  const provider = options.provider
  const port = options.port

  if (engine !== entry.code) return null
  if (typeof rootUsername !== 'string' || rootUsername.length === 0) return null
  if (typeof provider !== 'string' || !PRINCIPAL_PROVIDERS.has(provider)) {
    return null
  }
  if (typeof port !== 'number' || !Number.isFinite(port) || port <= 0) {
    return null
  }

  return { engine, rootUsername, provider, port }
}

const CATALOG: CatalogEntry[] = [
  {
    code: 'wordpress-mysql',
    kind: 'managed',
    displayName: 'WordPress with MySQL',
    description: 'Managed WordPress site with MySQL database',
    compose: composeDocument({
      services: {
        wordpress: { image: 'wordpress:latest', depends_on: ['db'] },
        db: { image: 'mysql:8' },
      },
    }),
    options: { stack: 'wordpress-mysql' },
    environments: [
      {
        displayName: 'production',
        description: 'Production environment',
        variables: [
          { key: 'MYSQL_ROOT_PASSWORD', isSecret: true },
          { key: 'WORDPRESS_DB_PASSWORD', isSecret: true },
        ],
      },
    ],
  },
  {
    code: 'static-site',
    kind: 'template',
    displayName: 'Static Site',
    description: 'Basic static web server template',
    compose: composeDocument({
      services: {
        web: { image: 'nginx:alpine' },
      },
    }),
    environments: [
      {
        displayName: 'production',
        description: 'Production environment',
      },
    ],
  },
  {
    code: 'postgres',
    kind: 'managed',
    displayName: 'PostgreSQL',
    description: 'Managed PostgreSQL database',
    compose: composeDocument({
      services: {
        postgres: { image: 'postgres:16' },
      },
    }),
    options: {
      engine: 'postgres',
      rootUsername: 'postgres',
      provider: 'postgres',
      port: 5432,
    },
    environments: [
      {
        displayName: 'production',
        description: 'Production environment',
        variables: [{ key: 'POSTGRES_PASSWORD', isSecret: true }],
      },
    ],
  },
  {
    code: 'mysql',
    kind: 'managed',
    displayName: 'MySQL',
    description: 'Managed MySQL database',
    compose: composeDocument({
      services: {
        mysql: { image: 'mysql:8' },
      },
    }),
    options: {
      engine: 'mysql',
      rootUsername: 'root',
      provider: 'mysql',
      port: 3306,
    },
    environments: [
      {
        displayName: 'production',
        description: 'Production environment',
        variables: [{ key: 'MYSQL_ROOT_PASSWORD', isSecret: true }],
      },
    ],
  },
  {
    code: 'mariadb',
    kind: 'managed',
    displayName: 'MariaDB',
    description: 'Managed MariaDB database',
    compose: composeDocument({
      services: {
        mariadb: { image: 'mariadb:11' },
      },
    }),
    options: {
      engine: 'mariadb',
      rootUsername: 'root',
      provider: 'mysql',
      port: 3306,
    },
    environments: [
      {
        displayName: 'production',
        description: 'Production environment',
        variables: [{ key: 'MYSQL_ROOT_PASSWORD', isSecret: true }],
      },
    ],
  },
  {
    code: 'redis',
    kind: 'managed',
    displayName: 'Redis',
    description: 'Managed Redis cache',
    compose: composeDocument({
      services: {
        redis: { image: 'redis:7' },
      },
    }),
    options: {
      engine: 'redis',
      rootUsername: 'default',
      provider: 'redis',
      port: 6379,
    },
    environments: [
      {
        displayName: 'production',
        description: 'Production environment',
        variables: [{ key: 'REDIS_PASSWORD', isSecret: true }],
      },
    ],
  },
  {
    code: 'clickhouse',
    kind: 'managed',
    displayName: 'ClickHouse',
    description: 'Managed ClickHouse analytics database',
    compose: composeDocument({
      services: {
        clickhouse: { image: 'clickhouse/clickhouse-server:24' },
      },
    }),
    // provider is 'postgres' (not 'clickhouse'): principal_provider_check only
    // permits pam|postgres|mysql|redis — engine ≠ provider by design.
    options: {
      engine: 'clickhouse',
      rootUsername: 'default',
      provider: 'postgres',
      port: 8123,
    },
    environments: [
      {
        displayName: 'production',
        description: 'Production environment',
        variables: [{ key: 'CLICKHOUSE_PASSWORD', isSecret: true }],
      },
    ],
  },
]

/**
 * Resolve the plaintext to store for a catalog variable at scaffold time.
 * Secret values are generated here; never read static secret defaults from
 * the catalog entry.
 */
export function resolveCatalogVariablePlaintext(
  variable: CatalogVariable,
  sharedCredentials: Map<string, string>,
): string {
  if (!variable.isSecret) {
    if (variable.value === undefined) {
      throw new TypeError(`catalog variable ${variable.key} missing value`)
    }
    return variable.value
  }

  if (variable.sharedCredentialId !== undefined) {
    const existing = sharedCredentials.get(variable.sharedCredentialId)
    if (existing !== undefined) {
      return existing
    }
    const generated = generatePassword()
    sharedCredentials.set(variable.sharedCredentialId, generated)
    return generated
  }

  return generatePassword()
}

export function getCatalogEntry(code: string): CatalogEntry | undefined {
  return CATALOG.find((entry) => entry.code === code)
}

export function listCatalog(): CatalogSummary[] {
  return CATALOG.map(({ code, kind, displayName, description }) => ({
    code,
    kind,
    displayName,
    description,
  }))
}

export function isCreateProjectType(value: string): value is CreateProjectType {
  return (CREATE_PROJECT_TYPES as readonly string[]).includes(value)
}

export function listManagedCatalogEntries(): CatalogEntry[] {
  return CATALOG.filter((entry) => entry.kind === 'managed')
}
