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
