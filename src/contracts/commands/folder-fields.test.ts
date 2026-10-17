import { assertEquals, assertThrows } from '@std/assert'
import { it } from '@std/testing/bdd'
import {
  parseEnvironmentDeployPayload,
  parseEnvironmentStopPayload,
  parseEnvironmentStopResult,
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
