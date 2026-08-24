import { assertEquals } from '@std/assert'
import {
  extractComposeOverlays,
  isComposeChainError,
  MAX_COMPOSE_OVERLAYS,
  PROJECT_COMPOSE_FILENAME,
  resolveComposeLayerChain,
} from './layer-chain.ts'
import { emptyComposeDocument } from './index.ts'

const test = Deno.test.bind(Deno)

const doc = (data: Record<string, unknown>) => ({
  ...emptyComposeDocument(),
  data,
})

test('with no overlays the chain is exactly the two layers it always was', () => {
  // This is the guard on "no compose override, just env vars" staying the
  // untouched default path. If this changes, that flow changed.
  const chain = resolveComposeLayerChain({
    projectOptions: { compose: doc({ services: { web: { image: 'nginx' } } }) },
    environmentOptions: {},
    environmentFilename: 'docker-compose.staging.yml',
  })
  if (isComposeChainError(chain)) throw new Error('unexpected error')
  assertEquals(chain.length, 2)
  assertEquals(chain[0]?.role, 'project')
  assertEquals(chain[0]?.filename, PROJECT_COMPOSE_FILENAME)
  assertEquals(chain[1]?.role, 'environment')
  assertEquals(chain[1]?.filename, 'docker-compose.staging.yml')
})

test('an environment with no compose at all still yields two layers', () => {
  const chain = resolveComposeLayerChain({
    projectOptions: null,
    environmentOptions: null,
    environmentFilename: 'docker-compose.prod.yml',
  })
  if (isComposeChainError(chain)) throw new Error('unexpected error')
  assertEquals(chain.length, 2)
})

test('overlays order after their own tier, never across tiers', () => {
  const chain = resolveComposeLayerChain({
    projectOptions: {
      compose: doc({ services: {} }),
      composeOverlays: [
        { id: 'a', name: 'tooling', filename: 'docker-compose.tooling.yml', document: doc({}) },
      ],
    },
    environmentOptions: {
      compose: doc({ services: {} }),
      composeOverlays: [
        { id: 'b', name: 'debug', filename: 'docker-compose.debug.yml', document: doc({}) },
      ],
    },
    environmentFilename: 'docker-compose.staging.yml',
  })
  if (isComposeChainError(chain)) throw new Error('unexpected error')
  assertEquals(chain.map((layer) => layer.filename), [
    PROJECT_COMPOSE_FILENAME,
    'docker-compose.tooling.yml',
    'docker-compose.staging.yml',
    'docker-compose.debug.yml',
  ])
  // Roles stay the closed union — a role is a tier, not a per-file identity.
  assertEquals(chain.map((layer) => layer.role), [
    'project',
    'project',
    'environment',
    'environment',
  ])
})

test('extractComposeOverlays caps the list and drops malformed entries', () => {
  const many = Array.from({ length: MAX_COMPOSE_OVERLAYS + 4 }, (_, i) => ({
    id: `o${i}`,
    name: `o${i}`,
    filename: `docker-compose.o${i}.yml`,
    document: doc({}),
  }))
  assertEquals(extractComposeOverlays({ composeOverlays: many }).length, MAX_COMPOSE_OVERLAYS)
  assertEquals(
    extractComposeOverlays({ composeOverlays: [{ name: 'no id' }] }),
    [],
  )
  assertEquals(extractComposeOverlays({}), [])
  assertEquals(extractComposeOverlays(null), [])
})

test('a malformed compose document fails the whole chain', () => {
  const chain = resolveComposeLayerChain({
    projectOptions: { compose: 'not a document' },
    environmentOptions: {},
    environmentFilename: 'docker-compose.staging.yml',
  })
  assertEquals(isComposeChainError(chain), true)
})
