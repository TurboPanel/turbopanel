import { assertEquals } from '@std/assert'
import {
  createIdentityChainCache,
  IDENTITY_CHAIN_CACHE_MS,
  IDENTITY_CHAIN_PAGE_LIMIT,
} from './document-cache.ts'
import type { IdentityChainState } from './document.ts'
import type { PanelIdentity } from './identity.ts'

const test = Deno.test.bind(Deno)

const identityOf = (kid: string, keyset = 1) =>
  ({ current: { kid }, keyset }) as unknown as PanelIdentity

function setup() {
  let clock = 1_000_000
  let reads = 0
  const cache = createIdentityChainCache(() => clock)
  const load = (keyset: number) => (): Promise<IdentityChainState> => {
    reads += 1
    return Promise.resolve({ keyset, rotation: null })
  }
  return {
    cache,
    load,
    reads: () => reads,
    advance: (ms: number) => {
      clock += ms
    },
  }
}

test('the chain state is read once per window, not once per request', async () => {
  const { cache, load, reads, advance } = setup()
  const identity = identityOf('kid-a')
  assertEquals((await cache.state(identity, load(2))).keyset, 2)
  assertEquals((await cache.state(identity, load(3))).keyset, 2)
  assertEquals(reads(), 1)
  advance(IDENTITY_CHAIN_CACHE_MS - 1)
  await cache.state(identity, load(3))
  assertEquals(reads(), 1)
  advance(1)
  assertEquals((await cache.state(identity, load(3))).keyset, 3)
  assertEquals(reads(), 2)
})

test('a new key or key set reads again at once and drops the held pages', async () => {
  const { cache, load, reads } = setup()
  const first = identityOf('kid-a')
  await cache.state(first, load(2))
  cache.keepPage(first, 0, '{"statements":["one"]}')
  assertEquals(cache.page(first, 0), '{"statements":["one"]}')
  // The loaded key changed (a rotation, or a new High Availability secret).
  const second = identityOf('kid-b')
  assertEquals(cache.page(second, 0), null)
  assertEquals((await cache.state(second, load(3))).keyset, 3)
  assertEquals(reads(), 2)
  // Self-hosted reloads the identity with a higher key set after a passkey change.
  assertEquals((await cache.state(identityOf('kid-b', 4), load(4))).keyset, 4)
  assertEquals(reads(), 3)
})

test('statement pages expire and their number is bounded', () => {
  const { cache, advance } = setup()
  const identity = identityOf('kid-a')
  for (let after = 0; after <= IDENTITY_CHAIN_PAGE_LIMIT; after += 1) {
    cache.keepPage(identity, after, `page-${after}`)
  }
  // The oldest page made room for the newest.
  assertEquals(cache.page(identity, 0), null)
  assertEquals(cache.page(identity, 1), 'page-1')
  assertEquals(cache.page(identity, IDENTITY_CHAIN_PAGE_LIMIT), `page-${IDENTITY_CHAIN_PAGE_LIMIT}`)
  advance(IDENTITY_CHAIN_CACHE_MS)
  assertEquals(cache.page(identity, 1), null)
})
