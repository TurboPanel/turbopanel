/**
 * Host-free coverage for datacenter membership address/CIDR helpers.
 */

import { assertEquals } from '@std/assert'
import {
  reportedCidrForAddress,
  siteCidrForAddress,
  validateMemberPinAddress,
} from './datacenter-membership.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('reportedCidrForAddress uses the aligned interface prefix', () => {
  const metadata = {
    ips: [
      { address: '10.0.0.10', version: 4, scope: 'private', cidr: '10.0.0.10/24' },
    ],
  }
  assertEquals(reportedCidrForAddress(metadata, '10.0.0.10'), '10.0.0.0/24')
  assertEquals(reportedCidrForAddress(metadata, '10.0.0.11'), null)
  assertEquals(
    reportedCidrForAddress(
      { ips: [{ address: '10.0.0.10', version: 4, scope: 'private' }] },
      '10.0.0.10',
    ),
    null,
  )
  assertEquals(reportedCidrForAddress(null, '10.0.0.10'), null)
})

test('siteCidrForAddress infers a typical LAN when the prefix is omitted', () => {
  const withoutPrefix = {
    ips: [{ address: '10.0.0.10', version: 4, scope: 'private' }],
  }
  assertEquals(siteCidrForAddress(withoutPrefix, '10.0.0.10'), '10.0.0.0/24')
  assertEquals(reportedCidrForAddress(withoutPrefix, '10.0.0.10'), null)
  assertEquals(
    siteCidrForAddress(
      {
        ips: [
          {
            address: '10.0.0.10',
            version: 4,
            scope: 'private',
            cidr: '10.0.0.10/16',
          },
        ],
      },
      '10.0.0.10',
    ),
    '10.0.0.0/16',
  )
  assertEquals(siteCidrForAddress(withoutPrefix, '10.0.0.11'), null)
})

test('validateMemberPinAddress still requires a reported host IP in CIDR', () => {
  const metadata = {
    ips: [
      { address: '10.0.0.10', version: 4, scope: 'private', cidr: '10.0.0.0/24' },
    ],
  }
  assertEquals(
    validateMemberPinAddress('10.0.0.10', '10.0.0.0/24', metadata),
    { ok: true, address: '10.0.0.10' },
  )
  assertEquals(
    validateMemberPinAddress('10.0.0.10', '10.0.1.0/24', metadata).ok,
    false,
  )
  assertEquals(
    validateMemberPinAddress('10.0.0.11', '10.0.0.0/24', metadata).ok,
    false,
  )
})
