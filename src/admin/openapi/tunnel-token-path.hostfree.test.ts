import { assertEquals } from '@std/assert'
import { ADMIN_API_PREFIX } from '../../app/surfaces.ts'
import { getAdminOpenApiSpec } from './index.ts'

const test = Deno.test.bind(Deno)

const TUNNEL_PATH = `${ADMIN_API_PREFIX}/instance/tunnel-token`

function pathsFor(runtime: 'deno' | 'workers'): Record<string, unknown> {
  const spec = getAdminOpenApiSpec('https://localhost:8443', { runtime }) as {
    paths: Record<string, unknown>
  }
  return spec.paths
}

test('the tunnel token path is documented on Deno and left out on Workers', () => {
  assertEquals(TUNNEL_PATH in pathsFor('deno'), true)
  assertEquals(TUNNEL_PATH in pathsFor('workers'), false)
})
