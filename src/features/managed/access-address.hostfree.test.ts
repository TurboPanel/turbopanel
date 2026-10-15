import { assertEquals } from '@std/assert'
import type { Db } from '../../db/connection.ts'
import {
  ALL_INTERFACES_BIND,
  LOOPBACK_BIND,
  type ManagedAddressLoaders,
  resolveManagedExternalDialHost,
} from './access-address.ts'
import { type ClientAddressFacts, resolveClientAddresses } from '../net/client-addresses-pure.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('bind constants stay loopback and all-interfaces wildcards', () => {
  assertEquals(LOOPBACK_BIND, '127.0.0.1')
  assertEquals(ALL_INTERFACES_BIND, '0.0.0.0')
})

const SERVER_ID = '550e8400-e29b-41d4-a716-446655440000'
const unusedDb = {} as Db

function loaders(facts: Partial<ClientAddressFacts>): ManagedAddressLoaders {
  return {
    loadAddresses: async () =>
      resolveClientAddresses({
        linuxHostname: 'omega',
        saved: [],
        publicIp: { v4: null, v6: null },
        reportedIps: [],
        pins: [],
        ...facts,
      }),
  }
}

test('resolveManagedExternalDialHost prefers the operator name, then an address', async () => {
  const dial = (facts: Partial<ClientAddressFacts>) =>
    resolveManagedExternalDialHost(unusedDb, SERVER_ID, loaders(facts))
  const publicIp = { v4: '203.0.113.50', v6: null }
  assertEquals(await dial({ publicIp }), '203.0.113.50')
  assertEquals(
    await dial({
      publicIp,
      saved: [
        {
          scope: 'public',
          datacenterId: null,
          hostname: 'omega.example.com',
          addressV4: null,
          addressV6: null,
          ports: {},
          primary: false,
        },
      ],
    }),
    'omega.example.com'
  )
  assertEquals(await dial({ linuxHostname: 'edge.example' }), 'edge.example')
})

test('resolveManagedExternalDialHost never gives out a one-word Linux hostname', async () => {
  assertEquals(
    await resolveManagedExternalDialHost(unusedDb, SERVER_ID, loaders({ linuxHostname: 'omega' })),
    null
  )
})
