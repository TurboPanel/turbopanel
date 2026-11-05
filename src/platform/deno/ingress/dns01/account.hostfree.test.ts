import { assertEquals } from '@std/assert'
import {
  ACME_PRODUCTION_DIRECTORY,
  ACME_STAGING_DIRECTORY,
} from '../../../../lib/acme/directories.ts'
import { dns01Directory } from './account.ts'

/** Jest/Mocha-shaped alias so Sonar sees real tests (typescript:S2187). */
const test = Deno.test.bind(Deno)

const CUSTOM = 'https://ca.example.com/directory'

test("an empty directory setting means the production Let's Encrypt directory", () => {
  assertEquals(dns01Directory({ directoryUrl: '', useStaging: false }), ACME_PRODUCTION_DIRECTORY)
  assertEquals(dns01Directory({ directoryUrl: '  ', useStaging: false }), ACME_PRODUCTION_DIRECTORY)
  assertEquals(
    dns01Directory({ directoryUrl: ACME_PRODUCTION_DIRECTORY, useStaging: false }),
    ACME_PRODUCTION_DIRECTORY
  )
})

test('staging replaces only the default directory', () => {
  assertEquals(dns01Directory({ directoryUrl: '', useStaging: true }), ACME_STAGING_DIRECTORY)
  assertEquals(
    dns01Directory({ directoryUrl: ACME_PRODUCTION_DIRECTORY, useStaging: true }),
    ACME_STAGING_DIRECTORY
  )
  assertEquals(dns01Directory({ directoryUrl: CUSTOM, useStaging: true }), CUSTOM)
  assertEquals(dns01Directory({ directoryUrl: CUSTOM, useStaging: false }), CUSTOM)
})
