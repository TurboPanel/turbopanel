import { assertEquals } from '@std/assert'

import {
  DEFAULT_RUNTIMES_DIR,
  DEFAULT_TURBOPANEL_HOME,
  resolveManagedDenoBin,
  resolveManagedNodeBin,
  resolveRuntimesDir,
} from './runtime-paths.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('default runtimes root is the FHS vendor path', () => {
  assertEquals(DEFAULT_TURBOPANEL_HOME, '/opt/turbopanel')
  assertEquals(DEFAULT_RUNTIMES_DIR, '/opt/turbopanel/vendor')
  assertEquals(resolveRuntimesDir({}), '/opt/turbopanel/vendor')
})

test('resolveRuntimesDir honors TURBOPANEL_RUNTIMES_DIR and strips trailing slashes', () => {
  assertEquals(
    resolveRuntimesDir({ TURBOPANEL_RUNTIMES_DIR: '/opt/custom/vendor/' }),
    '/opt/custom/vendor',
  )
  assertEquals(
    resolveRuntimesDir({ TURBOPANEL_RUNTIMES_DIR: '///' }),
    '/',
  )
  assertEquals(
    resolveRuntimesDir({ TURBOPANEL_RUNTIMES_DIR: '  /tmp/runtimes  ' }),
    '/tmp/runtimes',
  )
})

test('resolveManagedNodeBin prefers TURBOPANEL_NODE then managed current', () => {
  assertEquals(
    resolveManagedNodeBin({ TURBOPANEL_NODE: ' /usr/local/bin/node ' }),
    '/usr/local/bin/node',
  )
  assertEquals(
    resolveManagedNodeBin({ TURBOPANEL_RUNTIMES_DIR: '/opt/tp/vendor' }),
    '/opt/tp/vendor/node/current/bin/node',
  )
})

test('resolveManagedDenoBin prefers TURBOPANEL_DENO then managed current', () => {
  assertEquals(
    resolveManagedDenoBin({ TURBOPANEL_DENO: ' /opt/deno/deno ' }),
    '/opt/deno/deno',
  )
  assertEquals(
    resolveManagedDenoBin({}),
    '/opt/turbopanel/vendor/deno/current/deno',
  )
})
