import { assertEquals } from '@std/assert'
import { createMemoryDb } from '../../test-fixtures/memory-db.ts'
import { license, setting } from '../../db/schema.ts'
import {
  clearLicenseEnrollAttempt,
  licenseEnrollAttemptKey,
  listProvisioningLicenses,
  parseLicenseEnrollAttempt,
  recordLicenseEnrollAttempt,
} from './enroll-attempt.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const ORG = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'
const NOW_MS = Date.parse('2026-09-27T01:00:00.000Z')

test('parseLicenseEnrollAttempt accepts only a version-1 record with a real date', () => {
  assertEquals(
    parseLicenseEnrollAttempt({ version: 1, at: '2026-09-27T01:00:00.000Z', hostname: ' pi ' }),
    {
      version: 1,
      at: '2026-09-27T01:00:00.000Z',
      hostname: 'pi',
    }
  )
  assertEquals(
    parseLicenseEnrollAttempt({ version: 1, at: '2026-09-27T01:00:00.000Z' })?.hostname,
    null
  )
  assertEquals(parseLicenseEnrollAttempt({ version: 2, at: '2026-09-27T01:00:00.000Z' }), null)
  assertEquals(parseLicenseEnrollAttempt({ version: 1, at: 'yesterday' }), null)
  assertEquals(parseLicenseEnrollAttempt(null), null)
  assertEquals(parseLicenseEnrollAttempt('x'), null)
})

test('record → list → clear: an enrolling unbound key is provisioning until it binds or is revoked', async () => {
  const db = createMemoryDb([
    [
      license,
      [
        { id: 'lic-1', organizationId: ORG, serverId: null, revokedAt: null },
        { id: 'lic-2', organizationId: ORG, serverId: null, revokedAt: null },
      ],
    ],
    [setting, []],
  ])
  assertEquals((await listProvisioningLicenses(db, ORG)).size, 0)

  await recordLicenseEnrollAttempt(db, 'lic-1', 'adrastea', NOW_MS)
  // A second attempt overwrites, never duplicates.
  await recordLicenseEnrollAttempt(db, 'lic-1', '  ', NOW_MS + 5000)
  const listed = await listProvisioningLicenses(db, ORG)
  assertEquals([...listed.keys()], ['lic-1'])
  assertEquals(listed.get('lic-1'), {
    version: 1,
    at: new Date(NOW_MS + 5000).toISOString(),
    hostname: null,
  })

  await clearLicenseEnrollAttempt(db, 'lic-1')
  assertEquals((await listProvisioningLicenses(db, ORG)).size, 0)
  assertEquals(licenseEnrollAttemptKey('lic-9'), 'LICENSE_ENROLL_ATTEMPT:lic-9')
})

test('only active, unbound keys of the organization with a valid record are provisioning', async () => {
  const attempt = { version: 1, at: '2026-09-27T01:00:00.000Z', hostname: 'adrastea' }
  const db = createMemoryDb([
    [
      license,
      [
        { id: 'lic-1', organizationId: ORG, serverId: 'srv-1', revokedAt: null },
        // Its daemon enrolled and was refused (or is still enrolling): provisioning.
        { id: 'lic-2', organizationId: ORG, serverId: null, revokedAt: null },
        // Never used: an unused key.
        { id: 'lic-3', organizationId: ORG, serverId: null, revokedAt: null },
        // Revoked, with a stale record: not counted.
        { id: 'lic-4', organizationId: ORG, serverId: null, revokedAt: '2026-09-27T02:00:00.000Z' },
        // Another organization's key.
        {
          id: 'lic-5',
          organizationId: '00000000-0000-4000-8000-000000000000',
          serverId: null,
          revokedAt: null,
        },
      ],
    ],
    [
      setting,
      [
        { id: 'set-1', key: 'LICENSE_ENROLL_ATTEMPT:lic-2', value: attempt },
        { id: 'set-2', key: 'LICENSE_ENROLL_ATTEMPT:lic-4', value: attempt },
        // A bound key's stale record changes nothing.
        { id: 'set-3', key: 'LICENSE_ENROLL_ATTEMPT:lic-1', value: attempt },
        // Garbage is ignored.
        { id: 'set-4', key: 'LICENSE_ENROLL_ATTEMPT:lic-3', value: { version: 9 } },
        { id: 'set-5', key: 'LICENSE_ENROLL_ATTEMPT:lic-5', value: attempt },
      ],
    ],
  ])
  assertEquals([...(await listProvisioningLicenses(db, ORG)).keys()], ['lic-2'])
})
