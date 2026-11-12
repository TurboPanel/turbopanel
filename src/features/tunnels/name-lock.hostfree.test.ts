import { assertEquals } from '@std/assert'
import { parseDeployHostingTunnel } from '../../contracts/commands/tunnel-routes.ts'
import { buildNameLock, LOOPBACK_PEER } from './name-lock.ts'

/** Sonar typescript:S2187 only recognizes `test()`; keep this alias so analysis sees real tests. */
const test = Deno.test.bind(Deno)

const HERE = '00000000-0000-4000-8000-00000000000a'
const CARRIER = '00000000-0000-4000-8000-00000000000b'
const OTHER = '00000000-0000-4000-8000-00000000000c'
const T1 = '00000000-0000-4000-8000-0000000000a1'
const T2 = '00000000-0000-4000-8000-0000000000a2'

const addresses = new Map([
  [HERE, ['10.0.0.10', 'fd00::a']],
  [CARRIER, ['10.0.0.11']],
  [OTHER, ['10.0.0.12']],
])

test('a tunnel name is locked to the servers that carry its tunnel', () => {
  const lock = buildNameLock({
    siteHostnames: ['shop.example.com', 'www.shop.example.com'],
    doorways: [{ hostname: 'shop.example.com', tunnelId: T1, isLocalOnly: true }],
    carryingByTunnel: new Map([[T1, [CARRIER, HERE]]]),
    serverId: HERE,
    addresses,
  })
  assertEquals(lock.lockedHostnames, ['shop.example.com'])
  assertEquals(lock.tunnel, {
    hostnames: ['shop.example.com'],
    peers: ['10.0.0.11'],
    extraBind: ['10.0.0.10', 'fd00::a'],
  })
  // The contract the daemon applies accepts what is sent.
  parseDeployHostingTunnel(lock.tunnel, ['shop.example.com', 'www.shop.example.com'])
})

test('a server that is the only carrier gets loopback as its one peer and no extra bind', () => {
  const lock = buildNameLock({
    siteHostnames: ['shop.example.com'],
    doorways: [{ hostname: 'shop.example.com', tunnelId: T1, isLocalOnly: true }],
    carryingByTunnel: new Map([[T1, [HERE]]]),
    serverId: HERE,
    addresses,
  })
  assertEquals(lock.tunnel, { hostnames: ['shop.example.com'], peers: [LOOPBACK_PEER] })
  parseDeployHostingTunnel(lock.tunnel, ['shop.example.com'])
})

test('a name that is also public stays open and is not counted as locked', () => {
  const lock = buildNameLock({
    siteHostnames: ['a.example.com', 'b.example.com'],
    doorways: [
      { hostname: 'a.example.com', tunnelId: T1, isLocalOnly: true },
      { hostname: 'b.example.com', tunnelId: T1, isLocalOnly: false },
    ],
    carryingByTunnel: new Map([[T1, [CARRIER]]]),
    serverId: HERE,
    addresses,
  })
  assertEquals(lock.lockedHostnames, ['a.example.com'])
  assertEquals(lock.tunnel?.openHostnames, ['b.example.com'])
  const allOpen = buildNameLock({
    siteHostnames: ['b.example.com'],
    doorways: [{ hostname: 'b.example.com', tunnelId: T1, isLocalOnly: false }],
    carryingByTunnel: new Map([[T1, [CARRIER]]]),
    serverId: HERE,
    addresses,
  })
  assertEquals(allOpen.lockedHostnames, [])
  assertEquals(allOpen.tunnel?.openHostnames, ['b.example.com'])
})

test('peers from every tunnel of the hosting are joined, once each and in a stable order', () => {
  const lock = buildNameLock({
    siteHostnames: ['a.example.com', 'b.example.com'],
    doorways: [
      { hostname: 'b.example.com', tunnelId: T2, isLocalOnly: true },
      { hostname: 'a.example.com', tunnelId: T1, isLocalOnly: true },
    ],
    carryingByTunnel: new Map([
      [T1, [OTHER, CARRIER]],
      [T2, [CARRIER]],
    ]),
    serverId: HERE,
    addresses,
  })
  assertEquals(lock.tunnel?.hostnames, ['a.example.com', 'b.example.com'])
  assertEquals(lock.tunnel?.peers, ['10.0.0.11', '10.0.0.12'])
})

test('a name the hosting does not serve, and a hosting with no tunnel name, send nothing', () => {
  const none = buildNameLock({
    siteHostnames: ['plain.example.com'],
    doorways: [{ hostname: 'shop.example.com', tunnelId: T1, isLocalOnly: true }],
    carryingByTunnel: new Map([[T1, [CARRIER]]]),
    serverId: HERE,
    addresses,
  })
  assertEquals(none, { lockedHostnames: [], tunnel: undefined })
  assertEquals(
    buildNameLock({
      siteHostnames: ['plain.example.com'],
      doorways: [],
      carryingByTunnel: new Map(),
      serverId: HERE,
      addresses,
    }).tunnel,
    undefined
  )
})

test('names are matched without regard to letter case and keep the hosting spelling', () => {
  const lock = buildNameLock({
    siteHostnames: ['Shop.Example.com'],
    doorways: [{ hostname: 'shop.example.com', tunnelId: T1, isLocalOnly: true }],
    carryingByTunnel: new Map([[T1, [CARRIER]]]),
    serverId: HERE,
    addresses,
  })
  assertEquals(lock.tunnel?.hostnames, ['Shop.Example.com'])
})
