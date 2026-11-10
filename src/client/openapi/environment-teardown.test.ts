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
  // Optional body: `{ deleteVolumes, confirmName }` for a Destroy that deletes data.
  assertExists(stop.post.requestBody)

  const volumes = spec.paths[`${CLIENT_API_PREFIX}/environments/{id}/data-volumes`] as
    { get?: { tags?: string[] } } | undefined
  assertExists(volumes?.get)
  assertEquals(volumes.get.tags, ['Environments'])

  const lifecycle = spec.paths[`${CLIENT_API_PREFIX}/environments/{id}/lifecycle`]
  assertExists(lifecycle?.post)
  assertExists(lifecycle.post.requestBody)
})
