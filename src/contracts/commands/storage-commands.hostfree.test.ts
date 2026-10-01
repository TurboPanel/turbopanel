import { assertEquals, assertThrows } from '@std/assert'
import { parseCommandPayload, parseCommandResult } from './schemas.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const COPY_ID = '0192f0a4-1c2b-7d3e-8f40-5a6b7c8d9e04'
const POLICY_ID = '0192f0a4-1c2b-7d3e-8f40-5a6b7c8d9e01'

const BACKUP = {
  copyId: COPY_ID,
  copyProvider: 'docker',
  volumeName: 'shop_uploads',
  action: 'create',
  backupId: 'bk_0123abcd',
}

test('storage.backup carries a copy source and a backup id', () => {
  const created: unknown = parseCommandPayload('storage.backup', BACKUP)
  assertEquals(created, BACKUP)
  const removal = { ...BACKUP, action: 'delete', policyId: POLICY_ID }
  const removed: unknown = parseCommandPayload('storage.backup', removal)
  assertEquals(removed, removal)
})

test('storage.backup refuses a policy id on create, bad ids and unsafe sources', () => {
  for (const bad of [
    { ...BACKUP, policyId: POLICY_ID },
    { ...BACKUP, action: 'delete', policyId: 'not-a-uuid' },
    { ...BACKUP, action: 'restore' },
    { ...BACKUP, backupId: '../x' },
    { ...BACKUP, copyProvider: 'nfs' },
    { ...BACKUP, volumeName: 'bad name' },
    { ...BACKUP, copyProvider: 'path', volumeName: undefined, hostPath: '/srv/users/../etc' },
  ]) {
    assertThrows(
      () => parseCommandPayload('storage.backup', bad),
      Error,
      undefined,
      JSON.stringify(bad)
    )
  }
})

test('storage.backup results keep only well-formed fields', () => {
  assertEquals(
    parseCommandResult('storage.backup', {
      backupId: 'bk_0123abcd',
      path: '/var/lib/turbopanel/backups/copies/x/bk_0123abcd.tar.gz',
      sizeBytes: 12,
      checksum: 'a'.repeat(64),
      completedAt: '2026-09-30T04:00:00.000Z',
    }),
    {
      backupId: 'bk_0123abcd',
      path: '/var/lib/turbopanel/backups/copies/x/bk_0123abcd.tar.gz',
      sizeBytes: 12,
      checksum: 'a'.repeat(64),
      completedAt: '2026-09-30T04:00:00.000Z',
    }
  )
  assertEquals(
    parseCommandResult('storage.backup', {
      backupId: 'bk_0123abcd',
      sizeBytes: -1,
      checksum: 'nope',
    }),
    { backupId: 'bk_0123abcd' }
  )
  assertEquals(parseCommandResult('storage.backup', null), { backupId: '' })
})
