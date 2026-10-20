import { assertEquals, assertThrows } from '@std/assert'
import type {
  EnvironmentDeployHosting,
  EnvironmentDeployStorageMaterial,
} from '../../contracts/commands/schemas.ts'
import type { PlannedFolders } from '../../features/folders/allocate.ts'
import {
  removedServiceNames,
  serviceFoldersFor,
  servicesNeedingFolders,
  volumesNeedingFolders,
  withVolumeFolders,
} from './deploy-folders.ts'

const test = Deno.test.bind(Deno)

const SERVICE_ID = '00000000-0000-4000-8000-0000000000a1'
const PRINCIPAL_ID = '00000000-0000-4000-8000-0000000000b1'

function hosting(fields: Partial<EnvironmentDeployHosting>): EnvironmentDeployHosting {
  return {
    hostingId: 'h1',
    serviceId: SERVICE_ID,
    composeServiceName: 'site',
    hostnames: ['example.com', 'www.example.com'],
    ...fields,
  }
}

function material(
  fields: Partial<EnvironmentDeployStorageMaterial>
): EnvironmentDeployStorageMaterial {
  return {
    storageId: '00000000-0000-4000-8000-0000000000c1',
    locationId: 'loc',
    kind: 'directory',
    name: 'data',
    provider: 'path',
    serverId: 's1',
    mounts: [],
    ...fields,
  }
}

test('a site with no hostname, source or native app is listed by its compose name, and that name goes on the wire', () => {
  const listed = servicesNeedingFolders({
    sites: [
      {
        composeServiceName: 'phpsite',
        principal: { principalId: PRINCIPAL_ID, username: 'appuser' },
      },
    ] as never,
    nativeAppServices: [],
    sourceMaterial: [],
    hostings: [],
    storageMaterial: [],
  })
  assertEquals(listed, [{ composeServiceName: 'phpsite', principalId: PRINCIPAL_ID, domain: null }])
  // The planner returns the compose name of what it planned; the payload entry carries it, so the
  // host can tie a site that appears in no other list to its folder.
  const wire = serviceFoldersFor({
    folderIds: ['f1'],
    services: new Map([[SERVICE_ID, { owner: 'appuser', scope: 'production', slug: 'phpsite' }]]),
    serviceNames: new Map([[SERVICE_ID, listed[0]!.composeServiceName!]]),
    volumes: new Map(),
  })
  assertEquals(wire, [
    {
      serviceId: SERVICE_ID,
      composeServiceName: 'phpsite',
      folder: { owner: 'appuser', scope: 'production', slug: 'phpsite' },
    },
  ])
})

test('every service that runs on the host is listed once, with its owner and domain when known', () => {
  const listed = servicesNeedingFolders({
    sites: [
      {
        composeServiceName: 'site',
        principal: { principalId: PRINCIPAL_ID, username: 'appuser' },
      },
    ] as never,
    nativeAppServices: [{ composeServiceName: 'api', serviceId: SERVICE_ID }] as never,
    sourceMaterial: [
      { composeServiceName: 'api', releaseServiceId: SERVICE_ID },
      { composeServiceName: 'site' },
    ] as never,
    hostings: [
      hosting({ hostnames: ['Example.COM'] }),
      hosting({ composeServiceName: 'api', serviceId: SERVICE_ID, hostnames: ['api.example.com'] }),
      hosting({ composeServiceName: 'site', protocol: 'tcp', hostnames: ['ignored'] }),
    ],
    storageMaterial: [],
  })
  assertEquals(listed, [
    { composeServiceName: 'site', principalId: PRINCIPAL_ID, domain: 'Example.COM' },
    {
      composeServiceName: 'api',
      serviceId: SERVICE_ID,
      domain: 'api.example.com',
    },
  ])
})

test('a deploy with nothing on the host lists no services', () => {
  assertEquals(
    servicesNeedingFolders({
      sites: [],
      nativeAppServices: [],
      sourceMaterial: [],
      hostings: [],
      storageMaterial: [],
    }),
    []
  )
})

test('only volumes with an owner in the site owner tree need a folder', () => {
  const owned = material({ storageId: 'owned', principalId: PRINCIPAL_ID })
  assertEquals(
    volumesNeedingFolders({
      sites: [],
      nativeAppServices: [],
      sourceMaterial: [],
      hostings: [],
      storageMaterial: [
        owned,
        material({ storageId: 'no-owner' }),
        material({ storageId: 'docker', provider: 'docker', principalId: PRINCIPAL_ID }),
      ],
    }),
    ['owned']
  )
})

test('the planned folder is added beside the old fields, and only to the volume it names', () => {
  const planned: PlannedFolders = {
    folderIds: ['f1'],
    services: new Map(),
    serviceNames: new Map(),
    volumes: new Map([['owned', { owner: 'appuser', scope: 'production', slug: 'data' }]]),
  }
  const owned = material({ storageId: 'owned', sourcePath: '/srv/users/appuser/volumes/owned' })
  const other = material({ storageId: 'other' })
  assertEquals(withVolumeFolders([owned, other], planned), [
    { ...owned, folder: { owner: 'appuser', scope: 'production', slug: 'data' } },
    other,
  ])
})

test('an owned path volume with no planned folder is refused', () => {
  const planned: PlannedFolders = {
    folderIds: [],
    services: new Map(),
    serviceNames: new Map(),
    volumes: new Map(),
  }
  assertThrows(
    () => withVolumeFolders([material({ storageId: 'owned', principalId: PRINCIPAL_ID })], planned),
    Error,
    'owned'
  )
})

test('each planned service folder goes on the payload by service id, and an empty list when nothing was planned', () => {
  const planned: PlannedFolders = {
    folderIds: ['f1', 'f2'],
    services: new Map([
      [SERVICE_ID, { owner: 'appuser', scope: 'production', slug: 'example.com' }],
      ['svc-2', { owner: 'appuser', scope: 'common', slug: 'api' }],
    ]),
    serviceNames: new Map([[SERVICE_ID, 'phpsite']]),
    volumes: new Map(),
  }
  // A service with a compose name carries it, so a site with no hostname can be found.
  assertEquals(serviceFoldersFor(planned), [
    {
      serviceId: SERVICE_ID,
      composeServiceName: 'phpsite',
      folder: { owner: 'appuser', scope: 'production', slug: 'example.com' },
    },
    { serviceId: 'svc-2', folder: { owner: 'appuser', scope: 'common', slug: 'api' } },
  ])
  assertEquals(
    serviceFoldersFor({
      folderIds: [],
      services: new Map(),
      serviceNames: new Map(),
      volumes: new Map(),
    }),
    []
  )
})

test('the services that left the compose file are the service rows its document no longer names', () => {
  assertEquals(removedServiceNames(['web', 'plain', 'old'], { web: {} }), ['old', 'plain'])
  assertEquals(removedServiceNames(['web', 'web', 'old'], { web: {}, api: {} }), ['old'])
  assertEquals(removedServiceNames(['web'], { web: {} }), [])
})

test('an unreadable or empty document never reads as every service having left', () => {
  assertEquals(removedServiceNames(['web', 'plain'], undefined), [])
  assertEquals(removedServiceNames(['web', 'plain'], {}), [])
  assertEquals(removedServiceNames([], { web: {} }), [])
})
