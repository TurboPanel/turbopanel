import { assertEquals, assertExists } from 'jsr:@std/assert'
import { ADMIN_API_PREFIX } from '../../surfaces.ts'
import { getAdminOpenApiSpec } from './index.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

type SchemaObject = {
  properties?: Record<string, unknown>
  required?: string[]
  enum?: string[]
  const?: unknown
}

test('getAdminOpenApiSpec exposes OpenAPI 3.1 metadata and cookie auth', () => {
  const spec = getAdminOpenApiSpec('https://panel.example.com:8443') as {
    openapi: string
    info: { title: string }
    servers: { url: string }[]
    components: { securitySchemes: { cookieAuth: { name: string } } }
    tags: { name: string }[]
  }
  assertEquals(spec.openapi, '3.1.0')
  assertEquals(spec.info.title, 'TurboPanel Admin API')
  assertEquals(spec.servers[0]?.url, 'https://panel.example.com:8443')
  assertExists(spec.components.securitySchemes.cookieAuth.name)
  assertEquals(
    spec.tags.map((tag) => tag.name).sort((a, b) => a.localeCompare(b)),
    ['Daemon Fleet', 'Instance', 'Settings'],
  )
})

test('getAdminOpenApiSpec documents public URL and reencrypt paths', () => {
  const spec = getAdminOpenApiSpec('https://localhost:8443') as {
    paths: Record<string, unknown>
    components: { schemas: Record<string, SchemaObject> }
  }
  assertExists(spec.paths[`${ADMIN_API_PREFIX}/instance/public-urls`])
  assertExists(spec.paths[`${ADMIN_API_PREFIX}/instance/public-urls/apply`])
  assertExists(spec.paths[`${ADMIN_API_PREFIX}/secrets/reencrypt`])
  assertExists(spec.paths[`${ADMIN_API_PREFIX}/cells/purge-batch`])

  const reencryptCursor = spec.components.schemas.SecretsReencryptCursor
  assertEquals(reencryptCursor?.required, ['stage'])
  assertEquals(
    (reencryptCursor?.properties?.stage as SchemaObject).enum,
    ['variables', 'tls', 'principals', 'storage', 'credentials', 'email'],
  )

  const publicUrls = spec.components.schemas.PublicUrlsPutResponse
  assertEquals((publicUrls?.properties?.applied as SchemaObject).const, false)
})

test('getAdminOpenApiSpec accepts devSurface option without changing core paths', () => {
  const withDev = getAdminOpenApiSpec('https://localhost:8443', { devSurface: true }) as {
    paths: Record<string, unknown>
  }
  const withoutDev = getAdminOpenApiSpec('https://localhost:8443') as {
    paths: Record<string, unknown>
  }
  assertEquals(Object.keys(withDev.paths).sort((a, b) => a.localeCompare(b)), Object.keys(withoutDev.paths).sort((a, b) => a.localeCompare(b)))
})
