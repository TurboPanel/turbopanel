import { assertEquals } from '@std/assert'
import { collectComposeExternalDockerNetworkNames } from './docker-external-networks.ts'

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
