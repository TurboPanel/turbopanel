import { assertEquals } from '@std/assert'
import { ADMIN_API_PREFIX } from '../../app/surfaces.ts'
import { getAdminOpenApiSpec } from './index.ts'
import { getWorkersAdminOpenApiSpec } from './workers.ts'

const test = Deno.test.bind(Deno)

/**
 * The Build and Push Daemon routes are mounted only by the development entry
 * (`src/deno-dev.ts`), never on a real install, so the admin spec leaves them
 * out on purpose; their contract lives in `src/admin/AGENTS.md`.
 */
const DEVELOPMENT_ONLY_PATHS = [
  `${ADMIN_API_PREFIX}/instance/updates/development`,
  `${ADMIN_API_PREFIX}/instance/updates/development/push`,
]

test('the development-only update paths stay out of every admin spec', () => {
  const specs = [
    getAdminOpenApiSpec('https://localhost:8443', { runtime: 'deno' }),
    getAdminOpenApiSpec('https://localhost:8443', { runtime: 'deno', devSurface: true }),
    getWorkersAdminOpenApiSpec('https://localhost:8443'),
  ] as { paths: Record<string, unknown> }[]
  for (const spec of specs) {
    for (const path of DEVELOPMENT_ONLY_PATHS) {
      assertEquals(path in spec.paths, false, path)
    }
  }
})
