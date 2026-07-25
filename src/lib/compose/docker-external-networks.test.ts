import { assertEquals } from '@std/assert'
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
