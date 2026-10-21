/**
 * Host-free coverage for the addresses a managed root login may be used from.
 */

import { assertEquals } from '@std/assert'
import { organizationRootAllowedSources } from './root-login-sources.ts'

Deno.test(
  'organizationRootAllowedSources gathers reported, stored and mesh addresses once, sorted',
  () => {
    assertEquals(
      organizationRootAllowedSources({
        reported: [
          { address: '203.0.113.5', interface: 'eth0' },
          { address: '2001:db8::5', interface: 'eth0' },
          { address: '10.1.0.5/24', interface: 'enp1s0' },
          // Loopback, link-local and Docker bridges say nothing about a server.
          { address: '127.0.0.1', interface: 'lo' },
          { address: 'fe80::1', interface: 'eth0' },
          { address: '172.17.0.1', interface: 'docker0' },
          { address: '172.19.0.1', interface: 'br-1234abcd' },
        ],
        stored: ['203.0.113.5', '203.0.113.9', ''],
        mesh: ['100.64.0.7'],
      }),
      ['10.1.0.5', '100.64.0.7', '2001:db8::5', '203.0.113.5', '203.0.113.9']
    )
  }
)

Deno.test('organizationRootAllowedSources is empty when nothing is known', () => {
  assertEquals(organizationRootAllowedSources({ reported: [], stored: [], mesh: [] }), [])
})
