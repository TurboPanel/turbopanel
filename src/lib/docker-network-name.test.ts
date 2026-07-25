import { assertEquals } from 'jsr:@std/assert'
import {
  buildNetworkDockerOptions,
  isValidDockerNetworkName,
  normalizeDockerNetworkOptions,
  readNetworkDockerNetworkName,
} from './docker-network-name.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('readNetworkDockerNetworkName prefers options.dockerNetworkName', () => {
  assertEquals(
    readNetworkDockerNetworkName({ dockerNetworkName: '  shared-net  ' }, null),
    'shared-net',
  )
})

test('buildNetworkDockerOptions wraps docker network name', () => {
  assertEquals(buildNetworkDockerOptions('shared-net'), { dockerNetworkName: 'shared-net' })
})

test('isValidDockerNetworkName matches Docker Engine allowlist', () => {
  assertEquals(isValidDockerNetworkName('turbopanel-shared'), true)
  assertEquals(isValidDockerNetworkName('a.b_c-1'), true)
  assertEquals(isValidDockerNetworkName('-bad'), false)
  assertEquals(isValidDockerNetworkName('has space'), false)
})

test('normalizeDockerNetworkOptions trims and requires a valid name', () => {
  assertEquals(
    normalizeDockerNetworkOptions({ dockerNetworkName: '  shared  ', label: 'x' }),
    { dockerNetworkName: 'shared', label: 'x' },
  )
  assertEquals(normalizeDockerNetworkOptions({}), null)
  assertEquals(normalizeDockerNetworkOptions({ dockerNetworkName: '-bad' }), null)
})
