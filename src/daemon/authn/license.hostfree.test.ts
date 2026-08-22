/**
 * Host-free coverage for verifyDaemonLicense (no Postgres).
 */

import { assertEquals } from '@std/assert'
import type { Db } from '../../db.ts'
import {
  generateLicenseToken,
  verifyLicenseToken,
} from '../../client/authn/license.ts'
import { verifyDaemonLicense } from './license.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const ORG_ID = '00000000-0000-4000-8000-0000000000a1'
const LICENSE_ID = '00000000-0000-4000-8000-0000000000a2'

function queryResult<T>(rows: T[]) {
  return {
    limit: (_n: number) => Promise.resolve(rows),
  }
}

function createLicenseLookupDb(
  row: { organizationId: string; token: string } | null,
): Db {
  return {
    select: () => ({
      from: () => ({
        where: () => queryResult(row ? [row] : []),
      }),
    }),
  } as unknown as Db
}

test('verifyDaemonLicense returns null for blank id or token', async () => {
  const db = createLicenseLookupDb(null)
  assertEquals(await verifyDaemonLicense(db, null, 'token'), null)
  assertEquals(await verifyDaemonLicense(db, '  ', 'token'), null)
  assertEquals(await verifyDaemonLicense(db, LICENSE_ID, null), null)
  assertEquals(await verifyDaemonLicense(db, LICENSE_ID, '   '), null)
})

test('verifyDaemonLicense returns null when no active license row', async () => {
  const db = createLicenseLookupDb(null)
  assertEquals(await verifyDaemonLicense(db, LICENSE_ID, 'any-token'), null)
})

test('verifyDaemonLicense returns null when the token does not verify', async () => {
  const { hashed } = await generateLicenseToken()
  const db = createLicenseLookupDb({
    organizationId: ORG_ID,
    token: hashed,
  })
  assertEquals(
    await verifyDaemonLicense(db, LICENSE_ID, 'wrong-token-value'),
    null,
  )
})

test('verifyDaemonLicense returns organizationId for a valid pair', async () => {
  const { plaintext, hashed } = await generateLicenseToken()
  assertEquals(await verifyLicenseToken(plaintext, hashed), true)
  const db = createLicenseLookupDb({
    organizationId: ORG_ID,
    token: hashed,
  })
  assertEquals(await verifyDaemonLicense(db, `  ${LICENSE_ID}  `, plaintext), {
    organizationId: ORG_ID,
  })
})
