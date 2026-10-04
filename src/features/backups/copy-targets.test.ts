/**
 * `resolveCopyBackupSource`: which storage copies can be backed up, and the
 * volume or directory each one's bytes live in (the same one deploy mounts).
 */

import { assertEquals } from '@std/assert'
import {
  type CopyTargetRow,
  copyHostPathError,
  copyOptionsError,
  resolveCopyBackupSource,
} from './copy-targets.ts'

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

const PROJECT_ID = '0192d6a0-0000-7000-8000-0000000000a9'

test('a docker copy is the storage-id volume, or an external volume of the storage project', () => {
  assertEquals(resolveCopyBackupSource(row()), {
    ok: true,
    source: {
      copyId: COPY_ID,
      copyProvider: 'docker',
      volumeName: STORAGE_ID,
      storageId: STORAGE_ID,
    },
  })
  // The host gets the compose project so it can check an external volume's label.
  assertEquals(
    resolveCopyBackupSource(
      row({ copyOptions: { managed: false, externalName: 'legacy-data' }, projectId: PROJECT_ID })
    ),
    {
      ok: true,
      source: {
        copyId: COPY_ID,
        copyProvider: 'docker',
        volumeName: 'legacy-data',
        storageId: STORAGE_ID,
        composeProject: PROJECT_ID,
      },
    }
  )
  // An external name only counts for an unmanaged volume.
  assertEquals(
    resolveCopyBackupSource(row({ copyOptions: { managed: true, externalName: 'ignored' } })),
    {
      ok: true,
      source: {
        copyId: COPY_ID,
        copyProvider: 'docker',
        volumeName: STORAGE_ID,
        storageId: STORAGE_ID,
      },
    }
  )
})

test('a docker copy naming a foreign or unusable volume is refused', () => {
  const cases: Partial<CopyTargetRow>[] = [
    // A pinned name that is not the storage's own id (another site's volume).
    { storageMetadata: { dockerVolumeName: 'shop_uploads' } },
    { storageMetadata: { dockerVolumeName: '-x' } },
    // An external volume with no project to check its label against.
    { copyOptions: { managed: false, externalName: 'someone-elses' } },
    { copyOptions: { managed: false, externalName: 'bad name' }, projectId: PROJECT_ID },
  ]
  for (const overrides of cases) {
    assertEquals(resolveCopyBackupSource(row(overrides)).ok, false, JSON.stringify(overrides))
  }
})

test('a path copy is inside its own site owner volumes, the principal volume, or the default directory', () => {
  const directory = { provider: 'path', storageKind: 'directory', principalUsername: 'acme' }
  assertEquals(
    resolveCopyBackupSource(row({ ...directory, copyPath: '/srv/users/acme/volumes/data' })),
    {
      ok: true,
      source: {
        copyId: COPY_ID,
        copyProvider: 'path',
        hostPath: '/srv/users/acme/volumes/data',
        ownerUsername: 'acme',
      },
    }
  )
  assertEquals(resolveCopyBackupSource(row(directory)), {
    ok: true,
    source: {
      copyId: COPY_ID,
      copyProvider: 'path',
      hostPath: `/srv/users/acme/volumes/${STORAGE_ID}`,
      ownerUsername: 'acme',
    },
  })
  assertEquals(resolveCopyBackupSource(row({ provider: 'path', storageKind: 'directory' })), {
    ok: true,
    source: {
      copyId: COPY_ID,
      copyProvider: 'path',
      organizationId: ORG_ID,
      storageId: STORAGE_ID,
    },
  })
})

test('a path copy in another site owner tree, or with no owner, is refused', () => {
  const directory = { provider: 'path', storageKind: 'directory' }
  const cases: Partial<CopyTargetRow>[] = [
    { copyPath: '/srv/users/victim/volumes/x', principalUsername: 'acme' },
    { copyPath: '/srv/users/acme2/volumes/x', principalUsername: 'acme' },
    { copyPath: '/srv/users/acme/volumes', principalUsername: 'acme' },
    { copyPath: '/srv/users/acme/volumes/', principalUsername: 'acme' },
    { copyPath: '/srv/users/acme/.ssh', principalUsername: 'acme' },
    { copyPath: '/srv/users/acme/volumes/x', principalUsername: null },
  ]
  for (const overrides of cases) {
    assertEquals(resolveCopyBackupSource(row({ ...directory, ...overrides })).ok, false)
  }
})

test('copyHostPathError names the reason', () => {
  assertEquals(copyHostPathError('acme', '/srv/users/acme/volumes/a'), null)
  assertEquals(typeof copyHostPathError('acme', '/srv/users/victim/volumes/a'), 'string')
  assertEquals(typeof copyHostPathError(null, '/srv/users/acme/volumes/a'), 'string')
  assertEquals(typeof copyHostPathError('acme', '/srv/users/acme/volumes/../../victim'), 'string')
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
    { provider: 'path', storageKind: 'directory', copyPath: '/srv/users/acme/data' },
    { provider: 'path', storageKind: 'directory', copyPath: 'srv/users/a' },
    { provider: 'path', storageKind: 'directory', copyPath: '/srv/users/a,b' },
  ]
  for (const overrides of cases) {
    const result = resolveCopyBackupSource(row(overrides))
    assertEquals(result.ok, false, JSON.stringify(overrides))
  }
})

test('copyOptionsError refuses an external volume name or an unmanaged flag', () => {
  assertEquals(copyOptionsError(null), null)
  assertEquals(copyOptionsError({}), null)
  assertEquals(copyOptionsError({ managed: true }), null)
  assertEquals(typeof copyOptionsError({ externalName: 'other-site-data' }), 'string')
  assertEquals(typeof copyOptionsError({ managed: false }), 'string')
})
