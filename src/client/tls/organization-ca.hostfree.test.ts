/**
 * Host-free coverage for Organization CA lifecycle loader + trust-bundle order.
 */

import { assertEquals } from '@std/assert'
import type { Db } from '../../db.ts'
import {
  concatenateOrganizationCaTrustBundle,
  loadOrganizationCaSet,
  nextOrganizationCaGeneration,
} from './organization-ca.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const ACTIVE_PEM =
  '-----BEGIN CERTIFICATE-----\nACTIVE\n-----END CERTIFICATE-----'
const RETIRED_NEW_PEM =
  '-----BEGIN CERTIFICATE-----\nRETIRED2\n-----END CERTIFICATE-----'
const RETIRED_OLD_PEM =
  '-----BEGIN CERTIFICATE-----\nRETIRED1\n-----END CERTIFICATE-----'

function selectWhereDb(rows: unknown[]): Pick<Db, 'select'> {
  return {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(rows),
      }),
    }),
  } as unknown as Pick<Db, 'select'>
}

function lifecycleRow(overrides: {
  id: string
  caState: string
  caGeneration: number
  certificatePem: string
  privateKeyPem?: string
}) {
  return {
    id: overrides.id,
    name: 'Organization CA',
    source: 'organization_ca',
    organizationId: 'org-1',
    status: 'ready',
    notAfter: '2099-01-01T00:00:00.000Z',
    fingerprintSha256: 'a'.repeat(64),
    metadata: {},
    options: null,
    certificatePem: overrides.certificatePem,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    privateKeyPem: overrides.privateKeyPem ?? 'tpsecret.sealed',
    caState: overrides.caState,
    caGeneration: overrides.caGeneration,
  }
}

test('concatenateOrganizationCaTrustBundle puts active first then retired by generation descending', () => {
  const pem = concatenateOrganizationCaTrustBundle([
    { certificatePem: RETIRED_OLD_PEM, caState: 'retired', caGeneration: 1 },
    { certificatePem: ACTIVE_PEM, caState: 'active', caGeneration: 3 },
    { certificatePem: RETIRED_NEW_PEM, caState: 'retired', caGeneration: 2 },
    { certificatePem: 'not-a-pem', caState: 'retired', caGeneration: 4 },
  ])
  assertEquals(
    pem,
    `${ACTIVE_PEM}\n${RETIRED_NEW_PEM}\n${RETIRED_OLD_PEM}\n`,
  )
})

test('loadOrganizationCaSet returns the active signer plus the overlap trust bundle', async () => {
  const set = await loadOrganizationCaSet(
    selectWhereDb([
      lifecycleRow({
        id: 'retired-1',
        caState: 'retired',
        caGeneration: 1,
        certificatePem: RETIRED_OLD_PEM,
      }),
      lifecycleRow({
        id: 'active-2',
        caState: 'active',
        caGeneration: 2,
        certificatePem: ACTIVE_PEM,
        privateKeyPem: 'tpsecret.active',
      }),
    ]),
    'org-1',
  )
  if (!set) throw new TypeError('expected Organization CA set')
  assertEquals(set.signer.id, 'active-2')
  assertEquals(set.signer.certificatePem, ACTIVE_PEM)
  assertEquals(set.signer.privateKeyPemSealed, 'tpsecret.active')
  assertEquals(set.signer.caGeneration, 2)
  assertEquals(set.tls.id, 'active-2')
  assertEquals(set.trustBundlePem, `${ACTIVE_PEM}\n${RETIRED_OLD_PEM}\n`)
})

test('loadOrganizationCaSet returns null when no active Organization CA exists', async () => {
  const set = await loadOrganizationCaSet(
    selectWhereDb([
      lifecycleRow({
        id: 'retired-1',
        caState: 'retired',
        caGeneration: 1,
        certificatePem: RETIRED_OLD_PEM,
      }),
    ]),
    'org-1',
  )
  assertEquals(set, null)
})

test('nextOrganizationCaGeneration is max existing plus one', async () => {
  assertEquals(
    await nextOrganizationCaGeneration(selectWhereDb([{ value: 4 }]), 'org-1'),
    5,
  )
  assertEquals(
    await nextOrganizationCaGeneration(selectWhereDb([{ value: null }]), 'org-1'),
    1,
  )
})
