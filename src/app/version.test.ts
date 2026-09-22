import { assertEquals, assertMatch } from '@std/assert'
import { dirname, fromFileUrl, join } from '@std/path'
import { INSTANCE_VERSION } from './version.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const ROOT = dirname(dirname(dirname(fromFileUrl(import.meta.url))))

test('INSTANCE_VERSION is deno.json\'s version and is a semver', async () => {
  const denoJson = JSON.parse(await Deno.readTextFile(join(ROOT, 'deno.json')))
  assertEquals(INSTANCE_VERSION, denoJson.version)
  assertMatch(INSTANCE_VERSION, /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/)
})

test('package.json and sonar.projectVersion agree with deno.json', async () => {
  const pkg = JSON.parse(await Deno.readTextFile(join(ROOT, 'package.json')))
  assertEquals(pkg.version, INSTANCE_VERSION)
  const props = await Deno.readTextFile(join(ROOT, 'sonar-project.properties'))
  const m = props.match(/^sonar\.projectVersion=(.+)$/m)
  assertEquals(m?.[1]?.trim(), INSTANCE_VERSION)
})
