/**
 * `resolveCopyBackupSource`: which storage copies can be backed up, and the
 * volume or directory each one's bytes live in (the same one deploy mounts).
 */

import { assertEquals } from '@std/assert'
import { type CopyTargetRow, resolveCopyBackupSource } from './copy-targets.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const COPY_ID = '0192d6a0-0000-7000-8000-0000000000c1'
const STORAGE_ID = '0192d6a0-0000-7000-8000-0000000000d1'
const ORG_ID = '0192d6a0-0000-7000-8000-0000000000f1'
const SERVER_ID = '0192d6a0-0000-7000-8000-00000000000a'

function row(overrides: Partial<CopyTargetRow> = {}): CopyTargetRow {
  return {
    copyId: COPY_ID,
    serverId: SERVER_ID,
    provider: 'docker',
    copyPath: null,
    copyOptions: { managed: true },
    storageId: STORAGE_ID,
    organizationId: ORG_ID,
    storageKind: 'volume',
    storageMetadata: null,
    principalUsername: null,
    ...overrides,
  }
}

test('a docker copy is its storage-id volume, or the pinned name, or the external name', () => {
  assertEquals(resolveCopyBackupSource(row()), {
    ok: true,
    source: { copyId: COPY_ID, copyProvider: 'docker', volumeName: STORAGE_ID },
  })
  assertEquals(
    resolveCopyBackupSource(row({ storageMetadata: { dockerVolumeName: 'shop_uploads' } })),
    { ok: true, source: { copyId: COPY_ID, copyProvider: 'docker', volumeName: 'shop_uploads' } }
  )
  assertEquals(
    resolveCopyBackupSource(row({ copyOptions: { managed: false, externalName: 'legacy-data' } })),
    { ok: true, source: { copyId: COPY_ID, copyProvider: 'docker', volumeName: 'legacy-data' } }
  )
  // An external name only counts for an unmanaged volume.
  assertEquals(
    resolveCopyBackupSource(row({ copyOptions: { managed: true, externalName: 'ignored' } })),
    { ok: true, source: { copyId: COPY_ID, copyProvider: 'docker', volumeName: STORAGE_ID } }
  )
})

test('a docker copy with an unusable volume name is refused', () => {
  const external = resolveCopyBackupSource(
    row({ copyOptions: { managed: false, externalName: 'bad name' } })
  )
  assertEquals(external.ok, false)
  const pinned = resolveCopyBackupSource(row({ storageMetadata: { dockerVolumeName: '-x' } }))
  assertEquals(pinned.ok, false)
})

test('a path copy is its own path, the principal volume, or the default directory', () => {
  const directory = { provider: 'path', storageKind: 'directory' }
  assertEquals(resolveCopyBackupSource(row({ ...directory, copyPath: '/srv/users/acme/data' })), {
    ok: true,
    source: { copyId: COPY_ID, copyProvider: 'path', hostPath: '/srv/users/acme/data' },
  })
  assertEquals(resolveCopyBackupSource(row({ ...directory, principalUsername: 'acme' })), {
    ok: true,
    source: {
      copyId: COPY_ID,
      copyProvider: 'path',
      hostPath: `/srv/users/acme/volumes/${STORAGE_ID}`,
    },
  })
  assertEquals(resolveCopyBackupSource(row(directory)), {
    ok: true,
    source: {
      copyId: COPY_ID,
      copyProvider: 'path',
      organizationId: ORG_ID,
      storageId: STORAGE_ID,
    },
  })
})

test('copies outside the backup-able shapes are refused with a reason', () => {
  const cases: Partial<CopyTargetRow>[] = [
    { serverId: null },
    { storageKind: 'file' },
    { storageKind: 'object' },
    { provider: 'nfs' },
    { provider: 's3' },
    { provider: 'path', storageKind: 'volume' },
    { provider: 'path', storageKind: 'directory', copyPath: '/etc' },
    { provider: 'path', storageKind: 'directory', copyPath: '/var/lib/docker/volumes/x' },
    { provider: 'path', storageKind: 'directory', copyPath: '/srv/users/../etc' },
    { provider: 'path', storageKind: 'directory', copyPath: 'srv/users/a' },
    { provider: 'path', storageKind: 'directory', copyPath: '/srv/users/a,b' },
  ]
  for (const overrides of cases) {
    const result = resolveCopyBackupSource(row(overrides))
    assertEquals(result.ok, false, JSON.stringify(overrides))
  }
})
