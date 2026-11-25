import { assertEquals } from '@std/assert'
import { connectorReportOf, portalsForCarrying } from './connector-reports.ts'

/** Sonar only recognises `test()`; see the note in the other suites. */
const test = Deno.test.bind(Deno)

const metadata = {
  tunnelConnectorReports: {
    abc: { reported: 'connected', lastSeenAt: '2026-11-21T16:30:00.000Z', connectorVersion: '1' },
    bad: { reported: 'nonsense' },
  },
}

test('a stored report is read back, and anything malformed reads as none', () => {
  assertEquals(connectorReportOf(metadata, 'abc')?.reported, 'connected')
  assertEquals(connectorReportOf(metadata, 'bad'), null)
  assertEquals(connectorReportOf(metadata, 'missing'), null)
  assertEquals(connectorReportOf(null, 'abc'), null)
})

test('carrying servers without a portal row are listed, the stored rows are kept', () => {
  const stored = [
    {
      serverId: 'skip',
      wanted: 'skip',
      reported: 'unknown',
      lastSeenAt: null,
      lastError: null,
      connectorVersion: null,
    },
  ]
  const shown = portalsForCarrying(['a', 'b'], stored, 'abc', new Map([['a', metadata]]))
  assertEquals(
    shown.map((p) => [p.serverId, p.wanted, p.reported]),
    [
      ['skip', 'skip', 'unknown'],
      ['a', 'run', 'connected'],
      ['b', 'run', 'unknown'],
    ]
  )
  assertEquals(shown[1]!.connectorVersion, '1')
  assertEquals(shown[2]!.lastSeenAt, null)
})
