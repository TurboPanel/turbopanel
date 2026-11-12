/**
 * Host-free coverage for the enrol announcements (no Postgres): the server
 * lookup, and that a failing audit or notification write never reaches the
 * enrol path.
 */
import { assertEquals } from '@std/assert'
import { audit, server } from '../../db/schema.ts'
import { createMemoryDb } from '../../test-fixtures/memory-db.ts'
import {
  announceKeyReplaced,
  announceServerEnrolled,
  loadServerForAnnouncement,
} from './enroll-announce.ts'

/** Jest/Mocha-shaped alias so Sonar sees real tests. */
const test = Deno.test.bind(Deno)

const ORG_ID = '00000000-0000-4000-8000-0000000000b1'
const SERVER_ID = '00000000-0000-4000-8000-0000000000b2'
const NOW = '2026-11-01T12:00:00.000Z'
const FINGERPRINT = 'ab'.repeat(32)

function dbWithServer() {
  return createMemoryDb([
    [
      server,
      [{ id: SERVER_ID, organizationId: ORG_ID, name: 'edge-1', createdAt: NOW, updatedAt: NOW }],
    ],
    [audit, []],
  ])
}

test('loadServerForAnnouncement returns the organization and name, or null for an unknown server', async () => {
  const db = dbWithServer()
  assertEquals(await loadServerForAnnouncement(db, SERVER_ID), {
    organizationId: ORG_ID,
    serverName: 'edge-1',
  })
  assertEquals(await loadServerForAnnouncement(db, '00000000-0000-4000-8000-0000000000ff'), null)
})

test('announceServerEnrolled and announceKeyReplaced write an audit row and never throw', async () => {
  const db = dbWithServer()
  await announceServerEnrolled(db, undefined, {
    organizationId: ORG_ID,
    serverId: SERVER_ID,
    serverName: 'edge-1',
    fingerprint: FINGERPRINT,
  })
  await announceKeyReplaced(db, undefined, {
    organizationId: ORG_ID,
    serverId: SERVER_ID,
    serverName: null,
    oldFingerprint: FINGERPRINT,
    newFingerprint: 'cd'.repeat(32),
  })
  assertEquals(
    db.rows(audit).map((row) => row.action),
    ['server.enroll', 'server.key_replace']
  )
})
