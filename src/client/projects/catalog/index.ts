export const CREATE_PROJECT_TYPES = ['docker-compose', 'template', 'managed'] as const
export type CreateProjectType = (typeof CREATE_PROJECT_TYPES)[number]

export type CatalogVariable = {
  key: string
  value: string
  isSecret: boolean
}

export type CatalogEnvironment = {
  displayName: string
  description?: string
  compose?: Record<string, unknown>
  variables?: CatalogVariable[]
}

export type CatalogEntry = {
  code: string
  kind: 'managed' | 'template'
  displayName: string
  description: string
  compose: Record<string, unknown>
  options?: Record<string, unknown>
  environments: CatalogEnvironment[]
}

export type CatalogSummary = {
  code: string
  kind: CatalogEntry['kind']
  displayName: string
  description: string
}

const CATALOG: CatalogEntry[] = [
  {
    code: 'wordpress-mysql',
    kind: 'managed',
    displayName: 'WordPress with MySQL',
    description: 'Managed WordPress site with MySQL database',
    compose: {
      services: {
        wordpress: { image: 'wordpress:latest', depends_on: ['db'] },
        db: { image: 'mysql:8' },
      },
    },
    options: { stack: 'wordpress-mysql' },
    environments: [
      {
        displayName: 'production',
        description: 'Production environment',
        variables: [
          { key: 'MYSQL_ROOT_PASSWORD', value: 'changeme', isSecret: true },
          { key: 'WORDPRESS_DB_PASSWORD', value: 'changeme', isSecret: true },
        ],
      },
    ],
  },
  {
    code: 'static-site',
    kind: 'template',
    displayName: 'Static Site',
    description: 'Basic static web server template',
    compose: {
      services: {
        web: { image: 'nginx:alpine' },
      },
    },
    environments: [
      {
        displayName: 'production',
        description: 'Production environment',
      },
    ],
  },
]

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
