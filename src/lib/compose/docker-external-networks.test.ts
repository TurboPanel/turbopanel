import { assertEquals } from '@std/assert'
import {
  buildNetworkDockerOptions,
  isValidDockerNetworkName,
  normalizeDockerNetworkOptions,
  readNetworkDockerNetworkName,
} from '../docker-network-name.ts'
import {
  collectComposeExternalDockerNetworkNames,
  collectServiceComposeNetworkKeys,
  pruneUnreferencedComposeNetworks,
  readComposeExternalDockerNetworkName,
} from './docker-external-networks.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('collectComposeExternalDockerNetworkNames reads external name overrides', () => {
  const yaml = `
services:
  api:
    image: node:22
    networks:
      - backend
networks:
  backend:
    external: true
    name: turbopanel-shared
  internal:
    driver: bridge
`
  assertEquals(collectComposeExternalDockerNetworkNames(yaml), ['turbopanel-shared'])
})

test('collectComposeExternalDockerNetworkNames uses mapping key when name omitted', () => {
  const yaml = `
networks:
  legacy_shared:
    external: true
`
  assertEquals(collectComposeExternalDockerNetworkNames(yaml), ['legacy_shared'])
})

test('collectComposeExternalDockerNetworkNames reads Compose Spec object form', () => {
  const yaml = `
networks:
  backend:
    external:
      name: turbopanel-shared
  bare:
    external: {}
  internal:
    driver: bridge
`
  assertEquals(collectComposeExternalDockerNetworkNames(yaml), [
    'bare',
    'turbopanel-shared',
  ])
})

test('readComposeExternalDockerNetworkName rejects non-external entries', () => {
  assertEquals(
    readComposeExternalDockerNetworkName('backend', { driver: 'bridge' }),
    null,
  )
  assertEquals(
    readComposeExternalDockerNetworkName('backend', { external: false }),
    null,
  )
})

test('collectServiceComposeNetworkKeys supports list and map forms', () => {
  assertEquals(
    collectServiceComposeNetworkKeys({ networks: ['a', 'b'] }).sort((a, b) =>
      a.localeCompare(b)
    ),
    ['a', 'b'],
  )
  assertEquals(
    collectServiceComposeNetworkKeys({ networks: { backend: {}, edge: null } })
      .sort((a, b) => a.localeCompare(b)),
    ['backend', 'edge'],
  )
})

test('pruneUnreferencedComposeNetworks drops networks only traditional-web used', () => {
  const pruned = pruneUnreferencedComposeNetworks(
    {
      api: { image: 'node:22', networks: ['shared'] },
    },
    {
      shared: { external: true, name: 'turbopanel-shared' },
      web_only: { driver: 'bridge' },
    },
  )
  assertEquals(pruned, {
    shared: { external: true, name: 'turbopanel-shared' },
  })
})

test('pruneUnreferencedComposeNetworks returns undefined when none remain', () => {
  assertEquals(
    pruneUnreferencedComposeNetworks(
      { api: { image: 'node:22' } },
      { orphan: { driver: 'bridge' } },
    ),
    undefined,
  )
})

test('collectComposeExternalDockerNetworkNames ignores invalid external names', () => {
  const yaml = `
networks:
  bad name:
    external: true
`
  assertEquals(collectComposeExternalDockerNetworkNames(yaml), [])
})

test('collectServiceComposeNetworkKeys supports string and object list entries', () => {
  assertEquals(collectServiceComposeNetworkKeys({ networks: ' solo ' }), ['solo'])
  assertEquals(
    collectServiceComposeNetworkKeys({ networks: [{ backend: {} }, 'edge'] }),
    ['backend', 'edge'],
  )
  assertEquals(collectServiceComposeNetworkKeys({ image: 'node:22' }), [])
})

test('collectComposeExternalDockerNetworkNames returns empty for blank yaml', () => {
  assertEquals(collectComposeExternalDockerNetworkNames(''), [])
})

test('docker-network-name helpers validate and normalize names', () => {
  assertEquals(isValidDockerNetworkName('turbopanel-shared'), true)
  assertEquals(isValidDockerNetworkName('-bad'), false)
  assertEquals(readNetworkDockerNetworkName({ dockerNetworkName: '  net-a  ' }, null), 'net-a')
  assertEquals(readNetworkDockerNetworkName(null, { dockerNetworkName: 'meta-net' }), 'meta-net')
  assertEquals(buildNetworkDockerOptions(' net-b '), { dockerNetworkName: 'net-b' })
  assertEquals(normalizeDockerNetworkOptions({ dockerNetworkName: 'valid-net', extra: true }), {
    extra: true,
    dockerNetworkName: 'valid-net',
  })
  assertEquals(normalizeDockerNetworkOptions({ dockerNetworkName: ' bad name' }), null)
})

test('readComposeExternalDockerNetworkName rejects invalid mapping keys', () => {
  assertEquals(
    readComposeExternalDockerNetworkName('bad name', { external: {} }),
    null,
  )
})

test('readComposeExternalDockerNetworkName rejects non-mapping entries', () => {
  assertEquals(readComposeExternalDockerNetworkName('backend', 'bad'), null)
})

test('readComposeExternalDockerNetworkName falls back to sibling name', () => {
  assertEquals(
    readComposeExternalDockerNetworkName('backend', {
      external: {},
      name: 'turbopanel-shared',
    }),
    'turbopanel-shared',
  )
})

test('collectServiceComposeNetworkKeys returns empty for null networks', () => {
  assertEquals(collectServiceComposeNetworkKeys({ networks: null }), [])
})

test('pruneUnreferencedComposeNetworks returns undefined for empty networks input', () => {
  assertEquals(
    pruneUnreferencedComposeNetworks({ api: { image: 'node:22' } }, undefined),
    undefined,
  )
  assertEquals(
    pruneUnreferencedComposeNetworks({ api: { image: 'node:22' } }, {}),
    undefined,
  )
})
