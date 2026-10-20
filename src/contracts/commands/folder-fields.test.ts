import { assertEquals, assertThrows } from '@std/assert'
import { it } from '@std/testing/bdd'
import {
  FOLDERS_REMOVE_MAX,
  type FoldersRemoveCommandPayload,
  isReportedHome,
  parseCommandPayload,
  parseCommandResult,
  parseEnvironmentDeployPayload,
  parseEnvironmentDeployResult,
  parseEnvironmentStopPayload,
  parseEnvironmentStopResult,
  parseFoldersRemovePayload,
  parseFoldersRemoveResult,
  parsePrincipalIdReports,
  parsePrincipalsReconcileResult,
  parseReportedFolders,
} from './schemas.ts'

// The optional `folder` fields sit beside the fields they will replace. They
// carry components, never a path, and the parsers use the shared folder rules.

const STOP_BASE = { environmentId: 'env-1', projectId: 'proj-1', projectName: 'tp-demo' }

const DEPLOY_BASE = {
  environmentId: 'env-1',
  projectId: 'proj-1',
  organizationId: 'org-1',
  projectName: 'tp-demo',
  composeFiles: [{ filename: 'compose.yaml', role: 'runtime' as const, content: 'services: {}\n' }],
  hostings: [] as unknown[],
}

const VOLUME = {
  storageId: 'st1',
  locationId: 'loc1',
  kind: 'directory',
  name: 'uploads',
  provider: 'path',
  serverId: 'srv1',
  mounts: [],
}

it('keeps a service folder on a stop release and refuses a bad one', () => {
  const folder = { owner: 'alice', scope: 'production', slug: 'example.com' }
  assertEquals(
    parseEnvironmentStopPayload({
      ...STOP_BASE,
      siteReleases: [{ serviceId: 'svc-1', username: 'alice', folder }],
    }).siteReleases,
    [{ serviceId: 'svc-1', username: 'alice', folder }]
  )
  assertEquals(
    parseEnvironmentStopPayload({
      ...STOP_BASE,
      siteReleases: [{ serviceId: 'svc-1', username: 'alice' }],
    }).siteReleases,
    [{ serviceId: 'svc-1', username: 'alice' }]
  )
  for (const bad of [
    { ...folder, slug: '..' },
    { ...folder, scope: 'home' },
    { ...folder, owner: 'Alice' },
    { ...folder, kind: 'service' },
    { ...folder, path: '/etc' },
    'alice/production/example.com',
    null,
  ]) {
    assertThrows(
      () =>
        parseEnvironmentStopPayload({
          ...STOP_BASE,
          siteReleases: [{ serviceId: 'svc-1', username: 'alice', folder: bad }],
        }),
      TypeError
    )
  }
})

it('keeps a volume folder on storage material and refuses a bad one', () => {
  const folder = { owner: 'alice', scope: 'common', slug: 'uploads' }
  const parsed = parseEnvironmentDeployPayload({
    ...DEPLOY_BASE,
    storageMaterial: [{ ...VOLUME, sourcePath: '/srv/users/alice/volumes/st1', folder }],
  })
  assertEquals(parsed.storageMaterial?.[0]?.folder, folder)
  assertEquals(parsed.storageMaterial?.[0]?.sourcePath, '/srv/users/alice/volumes/st1')
  const without = parseEnvironmentDeployPayload({ ...DEPLOY_BASE, storageMaterial: [VOLUME] })
  assertEquals('folder' in (without.storageMaterial?.[0] ?? {}), false)
  assertThrows(
    () =>
      parseEnvironmentDeployPayload({
        ...DEPLOY_BASE,
        storageMaterial: [{ ...VOLUME, folder: { ...folder, slug: 'a/b' } }],
      }),
    TypeError
  )
})

it('keeps the service folders of a deploy and refuses a bad one', () => {
  const folder = { owner: 'alice', scope: 'production', slug: 'example.com' }
  const parsed = parseEnvironmentDeployPayload({
    ...DEPLOY_BASE,
    serviceFolders: [{ serviceId: 'svc-1', folder }],
  })
  assertEquals(parsed.serviceFolders, [{ serviceId: 'svc-1', folder }])
  assertEquals(
    parseEnvironmentDeployPayload({
      ...DEPLOY_BASE,
      serviceFolders: [{ serviceId: 'svc-1', composeServiceName: 'phpsite', folder }],
    }).serviceFolders,
    [{ serviceId: 'svc-1', composeServiceName: 'phpsite', folder }]
  )
  for (const composeServiceName of ['a/b', 7, '']) {
    assertThrows(() =>
      parseEnvironmentDeployPayload({
        ...DEPLOY_BASE,
        serviceFolders: [{ serviceId: 'svc-1', composeServiceName, folder }],
      })
    )
  }
  assertEquals(parseEnvironmentDeployPayload(DEPLOY_BASE).serviceFolders, undefined)
  for (const bad of [{ ...folder, slug: '..' }, { ...folder, scope: 'home' }, undefined]) {
    assertThrows(
      () =>
        parseEnvironmentDeployPayload({
          ...DEPLOY_BASE,
          serviceFolders: [{ serviceId: 'svc-1', folder: bad }],
        }),
      TypeError
    )
  }
})

it('keeps the folders a stop reports and drops entries that are not valid', () => {
  const folder = { owner: 'alice', scope: 'production', slug: 'example.com' }
  const result = parseEnvironmentStopResult({
    projectName: 'tp-demo',
    containers: [],
    folders: [
      { ...folder, kind: 'service', removed: true },
      { ...folder, kind: 'volume', removed: true },
      { ...folder, kind: 'service' },
      'x',
    ],
  })
  assertEquals(result.folders, [{ ...folder, kind: 'service', removed: true }])
  assertEquals(parseEnvironmentStopResult({ projectName: 'p' }).folders, undefined)
  assertEquals(parseEnvironmentStopResult({ projectName: 'p', folders: 'no' }).folders, undefined)
  assertEquals(
    parseEnvironmentStopResult({
      projectName: 'p',
      folders: [{ ...folder, scope: 'home', kind: 'service', removed: false }],
    }).folders,
    []
  )
})

it('keeps the reason a stop gives for a folder that stayed, and only then', () => {
  const folder = { owner: 'alice', scope: 'production', slug: 'example.com', kind: 'service' }
  const result = parseEnvironmentStopResult({
    projectName: 'p',
    folders: [
      { ...folder, removed: false, reason: 'The folder was not removed: device busy' },
      { ...folder, slug: 'other', removed: true, reason: 'ignored' },
      { ...folder, slug: 'long', removed: false, reason: 'x'.repeat(1000) },
    ],
  })
  assertEquals(result.folders?.[0]?.reason, 'The folder was not removed: device busy')
  assertEquals(result.folders?.[1]?.reason, undefined)
  assertEquals(result.folders?.[2]?.reason?.length, 300)
})

const REMOVE_FOLDER = { owner: 'alice', scope: 'production', slug: 'uploads' }
const REMOVE_ID = '0192a8f4-3c1e-7a52-9b0d-4e6f1a2b3c99'

it('server.folders.remove carries folder parts and an optional id, never a path', () => {
  const payload: FoldersRemoveCommandPayload = {
    folders: [
      { kind: 'volume', folder: REMOVE_FOLDER },
      { kind: 'volume', assetId: REMOVE_ID, folder: REMOVE_FOLDER },
      { kind: 'service', folder: { ...REMOVE_FOLDER, slug: 'example.com' } },
    ],
  }
  assertEquals(parseFoldersRemovePayload(payload), payload)
  assertEquals(parseCommandPayload('server.folders.remove', payload), payload)
  for (const bad of [
    null,
    {},
    { folders: [] },
    { folders: 'x' },
    { folders: [{ kind: 'other', folder: REMOVE_FOLDER }] },
    { folders: [{ kind: 'volume' }] },
    { folders: [{ kind: 'volume', folder: { ...REMOVE_FOLDER, path: '/etc' } }] },
    { folders: [{ kind: 'volume', folder: { ...REMOVE_FOLDER, scope: 'volumes' } }] },
    { folders: [{ kind: 'volume', folder: { ...REMOVE_FOLDER, slug: '../x' } }] },
    { folders: [{ kind: 'volume', assetId: '../x', folder: REMOVE_FOLDER }] },
    { folders: [{ kind: 'volume', assetId: 7, folder: REMOVE_FOLDER }] },
  ]) {
    assertThrows(() => parseFoldersRemovePayload(bad), TypeError, undefined, JSON.stringify(bad))
  }
  assertThrows(
    () =>
      parseFoldersRemovePayload({
        folders: Array.from({ length: FOLDERS_REMOVE_MAX + 1 }, () => ({
          kind: 'volume',
          folder: REMOVE_FOLDER,
        })),
      }),
    TypeError,
    '1 to 100'
  )
})

it('reads a server.folders.remove result leniently and keeps the reason of a folder that stayed', () => {
  const result = parseFoldersRemoveResult({
    summary: 'Removed 1 of 2 folder(s)',
    folders: [
      { ...REMOVE_FOLDER, kind: 'volume', removed: true },
      { ...REMOVE_FOLDER, slug: 'two', kind: 'volume', removed: false, reason: 'device busy' },
      { ...REMOVE_FOLDER, scope: 'home', kind: 'volume', removed: true },
      { ...REMOVE_FOLDER, kind: 'volume' },
      'x',
    ],
  })
  assertEquals(result, {
    summary: 'Removed 1 of 2 folder(s)',
    folders: [
      { ...REMOVE_FOLDER, kind: 'volume', removed: true },
      { ...REMOVE_FOLDER, slug: 'two', kind: 'volume', removed: false, reason: 'device busy' },
    ],
  })
  assertEquals(parseFoldersRemoveResult(null), { folders: [] })
  assertEquals(parseCommandResult('server.folders.remove', { folders: 'no' }), { folders: [] })
})

it('reads the folders a reconcile lists, or nothing when the list cannot be trusted whole', () => {
  const listed = { ...REMOVE_FOLDER, kind: 'volume', present: true }
  assertEquals(parseReportedFolders([listed]), [listed])
  assertEquals(parseReportedFolders([]), [])
  assertEquals(parseReportedFolders(undefined), undefined)
  assertEquals(parseReportedFolders('x'), undefined)
  // One entry that breaks the folder rules or the shape voids the list: it may be a
  // real folder, and the rest would then read as the whole host.
  assertEquals(parseReportedFolders([listed, { ...listed, scope: 'volumes' }]), undefined)
  assertEquals(parseReportedFolders([listed, { ...listed, present: 'yes' }]), undefined)
  assertEquals(parseReportedFolders([listed, 3]), undefined)
  const reconcile = parsePrincipalsReconcileResult({
    principalsApplied: 0,
    keysChanged: [],
    keysRemoved: [],
    sshdReloaded: false,
    warnings: [],
    folders: [listed],
  })
  assertEquals(reconcile.folders, [listed])
  assertEquals(
    'folders' in
      parsePrincipalsReconcileResult({
        principalsApplied: 0,
        keysChanged: [],
        keysRemoved: [],
        sshdReloaded: false,
        warnings: [],
      }),
    false
  )
})

it('reads the home a host reports for an account, and refuses one that is not a plain absolute path', () => {
  assertEquals(
    parsePrincipalIdReports([
      { principalId: 'p1', uid: 15001, gid: 15001, home: '/srv/users/alice' },
      { principalId: 'p2', uid: 15002, gid: 15002, home: '../etc' },
      { principalId: 'p3', uid: 15003, gid: 15003 },
    ]),
    [
      { principalId: 'p1', uid: 15001, gid: 15001, home: '/srv/users/alice' },
      { principalId: 'p2', uid: 15002, gid: 15002 },
      { principalId: 'p3', uid: 15003, gid: 15003 },
    ]
  )
  for (const bad of [
    '',
    '/',
    'srv/users/a',
    '/srv/users/',
    '/srv//users',
    '/srv/../etc',
    '/srv/./x',
    '/srv/a\nb',
    5,
  ]) {
    assertEquals(isReportedHome(bad), false, String(bad))
  }
  assertEquals(isReportedHome('/srv/users/alice'), true)
})

it('keeps the service folders a deploy left in place, and drops entries that are not valid', () => {
  const kept = { owner: 'alice', scope: 'production', slug: 'old.example.com', kind: 'service' }
  const result = parseEnvironmentDeployResult({
    projectName: 'p',
    keptFolders: [kept, { ...kept, kind: 'volume' }, { ...kept, scope: 'home' }, 'x'],
  })
  assertEquals(result.keptFolders, [kept])
  assertEquals(parseEnvironmentDeployResult({ projectName: 'p' }).keptFolders, undefined)
  assertEquals(
    parseEnvironmentDeployResult({ projectName: 'p', keptFolders: [] }).keptFolders,
    undefined
  )
})

it('keeps the sites that left the compose file and refuses a malformed list', () => {
  assertEquals(
    parseEnvironmentDeployPayload({ ...DEPLOY_BASE, removedSites: ['plain', 'old.site'] })
      .removedSites,
    ['plain', 'old.site']
  )
  assertEquals(parseEnvironmentDeployPayload(DEPLOY_BASE).removedSites, undefined)
  for (const bad of ['plain', { 0: 'plain' }, ['a/b'], ['..'], [7], [''], ['ok', null]]) {
    assertThrows(() => parseEnvironmentDeployPayload({ ...DEPLOY_BASE, removedSites: bad }))
  }
})

it('keeps the hostnames the host may take over with the environment that held each, and refuses a malformed list', () => {
  const entries = [
    { hostname: 'example.com', fromEnvironmentId: 'env_old-1' },
    { hostname: '*.example.org', fromEnvironmentId: 'env-2' },
  ]
  assertEquals(
    parseEnvironmentDeployPayload({ ...DEPLOY_BASE, takeoverHostnames: entries }).takeoverHostnames,
    entries
  )
  assertEquals(parseEnvironmentDeployPayload(DEPLOY_BASE).takeoverHostnames, undefined)
  const ok = { hostname: 'a.com', fromEnvironmentId: 'e' }
  for (const bad of [
    'example.com',
    ['example.com'],
    [{ hostname: 'Example.COM', fromEnvironmentId: 'e' }],
    [{ hostname: 'a b', fromEnvironmentId: 'e' }],
    [{ hostname: 'a.com' }],
    [{ ...ok, fromEnvironmentId: '../x' }],
    [{ ...ok, fromEnvironmentId: '' }],
    [{ ...ok, fromEnvironmentId: 'x'.repeat(65) }],
    [7],
  ]) {
    assertThrows(() => parseEnvironmentDeployPayload({ ...DEPLOY_BASE, takeoverHostnames: bad }))
  }
})
