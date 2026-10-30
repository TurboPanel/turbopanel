import { assertEquals } from '@std/assert'
import { type HostingTunnelDoorway, matchHostingTunnelPaths } from './hosting-tunnel-paths.ts'

/** Sonar typescript:S2187 only recognizes `test()`; keep this alias so analysis sees real tests. */
const test = Deno.test.bind(Deno)

const SITE = '00000000-0000-4000-8000-000000000001'
const OTHER = '00000000-0000-4000-8000-000000000002'
const TUNNEL = '00000000-0000-4000-8000-0000000000aa'

function door(overrides: Partial<HostingTunnelDoorway>): HostingTunnelDoorway {
  return {
    hostname: 'shop.example.com',
    hostingId: SITE,
    tunnelId: TUNNEL,
    tunnelName: 'Edge',
    provider: 'cloudflare',
    isLocalOnly: true,
    status: 'live',
    ...overrides,
  }
}

test('matchHostingTunnelPaths: a linked doorway belongs to its hosting, an unlinked one to the hosting naming it', () => {
  const paths = matchHostingTunnelPaths(
    [
      { id: SITE, hostnames: ['Shop.example.com', 'www.shop.example.com'] },
      { id: OTHER, hostnames: ['blog.example.com'] },
    ],
    [
      door({ hostname: 'www.shop.example.com', hostingId: null, isLocalOnly: false }),
      door({}),
      door({ hostname: 'api.example.com', hostingId: null }),
    ],
    new Set()
  )
  assertEquals(
    paths.get(SITE)?.map((p) => [p.hostname, p.tunnelOnly, p.originVerified]),
    [
      ['shop.example.com', true, false],
      ['www.shop.example.com', false, false],
    ]
  )
  assertEquals(paths.has(OTHER), false)
})

test('matchHostingTunnelPaths: a doorway linked to another hosting is not taken by name', () => {
  const paths = matchHostingTunnelPaths(
    [{ id: OTHER, hostnames: ['shop.example.com'] }],
    [door({})],
    new Set()
  )
  assertEquals(paths.size, 0)
})

test('matchHostingTunnelPaths: originVerified follows the tunnel whose verified connection is in effect', () => {
  const paths = matchHostingTunnelPaths(
    [{ id: SITE, hostnames: ['shop.example.com'] }],
    [door({})],
    new Set([TUNNEL])
  )
  assertEquals(paths.get(SITE)?.[0]?.originVerified, true)
})
