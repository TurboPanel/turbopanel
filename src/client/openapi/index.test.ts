import { assertEquals, assertExists } from 'jsr:@std/assert'
import { CLIENT_API_PREFIX } from '../../surfaces.ts'
import { getClientOpenApiSpec } from './index.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('getClientOpenApiSpec workers runtime omits install tag and paths', () => {
  const spec = getClientOpenApiSpec('https://panel.example.com', { runtime: 'workers' }) as {
    tags: { name: string }[]
    paths: Record<string, unknown>
    components: { schemas: Record<string, unknown> }
  }
  const tagNames = spec.tags.map((tag) => tag.name)
  assertEquals(tagNames.includes('Install'), false)
  assertEquals(Object.keys(spec.paths).some((path) => path.startsWith('/api/install/v1')), false)
  assertExists(spec.paths[`${CLIENT_API_PREFIX}/licenses`])
  assertExists(spec.components.schemas.LicenseRecord)
})

test('getClientOpenApiSpec deno runtime includes install surface', () => {
  const spec = getClientOpenApiSpec('https://localhost:8443', { runtime: 'deno' }) as {
    tags: { name: string }[]
    paths: Record<string, unknown>
  }
  assertEquals(spec.tags.some((tag) => tag.name === 'Install'), true)
  assertEquals(Object.keys(spec.paths).some((path) => path.startsWith('/api/install/v1')), true)
})

test('getClientOpenApiSpec wires cookie auth and core resource paths', () => {
  const spec = getClientOpenApiSpec('https://localhost:8443') as {
    openapi: string
    info: { title: string }
    servers: { url: string }[]
    components: { securitySchemes: { cookieAuth: { name: string } } }
    paths: Record<string, unknown>
  }
  assertEquals(spec.openapi, '3.1.0')
  assertEquals(spec.info.title, 'TurboPanel Client API')
  assertEquals(spec.servers[0]?.url, 'https://localhost:8443')
  assertExists(spec.components.securitySchemes.cookieAuth.name)
  assertExists(spec.paths[`${CLIENT_API_PREFIX}/servers`])
  assertExists(spec.paths[`${CLIENT_API_PREFIX}/projects`])
  assertExists(spec.paths[`${CLIENT_API_PREFIX}/environments/{id}/managed`])
})
