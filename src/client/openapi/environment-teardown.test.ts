import { assertEquals, assertExists } from '@std/assert'
import { CLIENT_API_PREFIX } from '../../app/surfaces.ts'
import { getClientOpenApiSpec } from './index.ts'

/** Sonar typescript:S2187 only recognizes `test()`; alias Deno.test so analysis sees it. */
const test = Deno.test.bind(Deno)

type SpecPath = { post?: { tags?: string[]; requestBody?: unknown } }

test('the client OpenAPI spec documents the environment stop and lifecycle routes', () => {
  const spec = getClientOpenApiSpec('https://panel.example.com', { runtime: 'deno' }) as {
    paths: Record<string, SpecPath>
  }

  const stop = spec.paths[`${CLIENT_API_PREFIX}/environments/{id}/stop`]
  assertExists(stop?.post)
  assertEquals(stop.post.tags, ['Environments'])
  assertEquals(stop.post.requestBody, undefined)

  const lifecycle = spec.paths[`${CLIENT_API_PREFIX}/environments/{id}/lifecycle`]
  assertExists(lifecycle?.post)
  assertExists(lifecycle.post.requestBody)
})
