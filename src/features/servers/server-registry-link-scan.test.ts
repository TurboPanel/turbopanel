import { assertEquals } from '@std/assert'
import { mergeServerMetadataIdentity } from './server-registry.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const clean = { scannedAt: '2026-10-04T00:00:00.000Z', findingCount: 0, findings: [] }

test('mergeServerMetadataIdentity stores the link scan without clobbering other keys', () => {
  const merged = mergeServerMetadataIdentity({ geo: { country: 'US' } }, { releaseLinkScan: clean })
  assertEquals(merged?.releaseLinkScan, clean)
  assertEquals(merged?.geo, { country: 'US' })
})

test('mergeServerMetadataIdentity ignores an unchanged link scan and replaces a changed one', () => {
  assertEquals(
    mergeServerMetadataIdentity({ releaseLinkScan: clean }, { releaseLinkScan: clean }),
    null
  )
  const flagged = {
    scannedAt: '2026-10-05T00:00:00.000Z',
    findingCount: 1,
    findings: [{ username: 'appuser', serviceId: 'svc-a', releaseId: 'r1', linkCount: 1 }],
  }
  assertEquals(
    mergeServerMetadataIdentity({ releaseLinkScan: clean }, { releaseLinkScan: flagged })
      ?.releaseLinkScan,
    flagged
  )
})

test('mergeServerMetadataIdentity drops a malformed link scan', () => {
  assertEquals(
    mergeServerMetadataIdentity({}, { releaseLinkScan: { findings: [] } as never }),
    null
  )
})
