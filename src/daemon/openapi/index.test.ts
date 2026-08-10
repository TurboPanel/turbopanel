import { assertEquals, assertExists } from 'jsr:@std/assert'
import { getDaemonOpenApiSpec } from './index.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('getDaemonOpenApiSpec exposes bearer auth and merged path modules', () => {
  const spec = getDaemonOpenApiSpec('https://panel.example.com:8443') as {
    openapi: string
    info: { title: string }
    servers: { url: string }[]
    components: {
      securitySchemes: { bearerAuth: { scheme: string } }
      schemas: Record<string, unknown>
    }
    paths: Record<string, unknown>
    tags: { name: string }[]
  }
  assertEquals(spec.openapi, '3.1.0')
  assertEquals(spec.info.title, 'TurboPanel Daemon API')
  assertEquals(spec.servers[0]?.url, 'https://panel.example.com:8443')
  assertEquals(spec.components.securitySchemes.bearerAuth.scheme, 'bearer')
  assertExists(spec.components.schemas.DaemonChallengeResponse ?? spec.components.schemas.ReadinessResponse)
  assertExists(spec.paths['/api/daemon/v1/readiness'])
  assertExists(spec.paths['/api/daemon/v1/instance/ca'])
  assertEquals(
    spec.tags.map((tag) => tag.name).sort((a, b) => a.localeCompare(b)),
    ['Authentication', 'Daemon'],
  )
})

test('getDaemonOpenApiSpec includes auth, metrics, version, and websocket paths', () => {
  const spec = getDaemonOpenApiSpec('https://localhost:8443') as { paths: Record<string, unknown> }
  const pathKeys = Object.keys(spec.paths).sort((a, b) => a.localeCompare(b))
  assertEquals(pathKeys.includes('/api/daemon/v1/auth/challenge'), true)
  assertEquals(pathKeys.includes('/api/daemon/v1/metrics'), true)
  assertEquals(pathKeys.includes('/api/daemon/v1/version'), true)
  assertEquals(pathKeys.some((key) => key.startsWith('/ws/daemon/v1')), true)
})
