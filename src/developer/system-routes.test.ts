import { join } from '@std/path'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const SYSTEM_ROUTES_PATH = join(
  new URL('.', import.meta.url).pathname,
  'system-routes.ts',
)

const RETIRED_GIT_USER_FALLBACK = /\|\|\s*['"]turbopanel['"]/

test('system-routes defaults managed git user to tp, not turbopanel', async () => {
  const source = await Deno.readTextFile(SYSTEM_ROUTES_PATH)
  if (RETIRED_GIT_USER_FALLBACK.test(source)) {
    throw new Error(
      `${SYSTEM_ROUTES_PATH}: PRODUCTION_GIT_USER must default to tp (inject TURBOPANEL_USER from Ansible)`,
    )
  }
  if (!source.includes("|| 'tp'")) {
    throw new Error(
      `${SYSTEM_ROUTES_PATH}: expected PRODUCTION_GIT_USER fallback to tp`,
    )
  }
})
