import { assertEquals } from '@std/assert'
import {
  CLIENT_VERSION_HEADER,
  compareSemver,
  daemonUnsupportedReason,
  INSTANCE_VERSION_HEADER,
  MIN_SUPPORTED_DAEMON_VERSION,
  parseSemver,
  resolveDaemonSupport,
} from './version-wire.ts'
import { INSTANCE_VERSION } from '../app/version.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

function cmp(a: string, b: string): number {
  const pa = parseSemver(a)
  const pb = parseSemver(b)
  if (!pa || !pb) throw new Error(`unparsable: ${a} / ${b}`)
  return Math.sign(compareSemver(pa, pb))
}

test('parseSemver accepts release, pre-release, build metadata and a leading v', () => {
  assertEquals(parseSemver('0.1.0'), { major: 0, minor: 1, patch: 0, prerelease: [] })
  assertEquals(parseSemver('v1.2.3'), { major: 1, minor: 2, patch: 3, prerelease: [] })
  assertEquals(parseSemver('0.1.0-rc.1+build.7')?.prerelease, ['rc', '1'])
  assertEquals(parseSemver(' 0.1.0 ')?.patch, 0)
  for (const bad of ['', '  ', 'dev', '0.1', '1.2.3.4', 'unstamped', undefined, null]) {
    assertEquals(parseSemver(bad), null, String(bad))
  }
})

test('compareSemver follows semver precedence, pre-releases before their release', () => {
  assertEquals(cmp('0.1.0', '0.1.0'), 0)
  assertEquals(cmp('0.1.1', '0.1.0'), 1)
  assertEquals(cmp('0.2.0', '0.1.9'), 1)
  assertEquals(cmp('1.0.0', '0.9.9'), 1)
  assertEquals(cmp('0.1.0-rc.1', '0.1.0'), -1)
  assertEquals(cmp('0.1.0-rc.2', '0.1.0-rc.1'), 1)
  assertEquals(cmp('0.1.0-rc.10', '0.1.0-rc.9'), 1)
  assertEquals(cmp('0.1.0-alpha', '0.1.0-alpha.1'), -1)
  assertEquals(cmp('0.1.0-1', '0.1.0-alpha'), -1)
  assertEquals(cmp('0.1.0+a', '0.1.0+b'), 0)
})

test('resolveDaemonSupport: at or above the floor is supported, below is unsupported, absent is unknown', () => {
  assertEquals(resolveDaemonSupport('0.1.0'), {
    status: 'supported',
    version: '0.1.0',
    minVersion: MIN_SUPPORTED_DAEMON_VERSION,
  })
  assertEquals(resolveDaemonSupport('0.4.2').status, 'supported')
  assertEquals(resolveDaemonSupport('0.1.0-rc.1').status, 'unsupported')
  assertEquals(resolveDaemonSupport('0.0.9').status, 'unsupported')
  assertEquals(resolveDaemonSupport(undefined), {
    status: 'unknown',
    version: null,
    minVersion: MIN_SUPPORTED_DAEMON_VERSION,
  })
  assertEquals(resolveDaemonSupport('unstamped').status, 'unknown')
  assertEquals(resolveDaemonSupport('0.0.1', '0.0.1').status, 'supported')
})

test('daemonUnsupportedReason names both numbers and the fix', () => {
  assertEquals(
    daemonUnsupportedReason(resolveDaemonSupport('0.0.9')),
    'Daemon version 0.0.9 is below the supported minimum 0.1.0 — update the daemon',
  )
})

test('the floor is a semver no newer than this instance', () => {
  const floor = parseSemver(MIN_SUPPORTED_DAEMON_VERSION)
  const mine = parseSemver(INSTANCE_VERSION)
  if (!floor || !mine) throw new Error('unparsable')
  assertEquals(compareSemver(floor, mine) <= 0, true)
})

test('header names are lower-case, as Hono and fetch normalize them', () => {
  assertEquals(INSTANCE_VERSION_HEADER, INSTANCE_VERSION_HEADER.toLowerCase())
  assertEquals(CLIENT_VERSION_HEADER, CLIENT_VERSION_HEADER.toLowerCase())
})
