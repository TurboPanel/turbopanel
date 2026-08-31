import { assertEquals } from '@std/assert'
import {
  applicationService,
  buildApplicationModel,
  buildResolvedApplication,
  containerServiceNames,
  hostNativeServiceNames,
  localComposeServiceNames,
  principalAliasByServiceName,
  serviceIdsOnServer,
} from './ir.ts'
import type { ComposeDocument } from './types.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

function doc(data: Record<string, unknown>): ComposeDocument {
  return {
    version: 1,
    data,
    presentation: { keyOrder: Object.keys(data), comments: {} },
  }
}

const MERGED = doc({
  'x-turbopanel': {
    principals: {
      web: { access: 'sftp', description: 'site owner' },
      api: {},
    },
  },
  services: {
    web: {
      'x-turbopanel': {
        serviceKind: 'site',
        principal: 'web',
        hosting: [{ hostname: 'example.test' }],
      },
    },
    cache: {
      image: 'redis:7',
      deploy: { replicas: 3 },
    },
    worker: {
      image: 'ghcr.io/acme/worker',
    },
  },
  networks: { default: { driver: 'overlay' } },
  volumes: { data: {} },
})

test('buildApplicationModel reads every service in authored order', () => {
  const application = buildApplicationModel(MERGED)
  assertEquals(application.services.map((entry) => entry.name), [
    'web',
    'cache',
    'worker',
  ])
  assertEquals(application.services.map((entry) => entry.kind), [
    'site',
    'container',
    'container',
  ])
  assertEquals(application.networks, { default: { driver: 'overlay' } })
  assertEquals(application.volumes, { data: {} })
  assertEquals(application.secrets, {})
  assertEquals(application.configs, {})
  assertEquals(application.project, {})
})

test('buildApplicationModel carries the project it was read for', () => {
  const application = buildApplicationModel(MERGED, {
    project: { id: 'prj-1', repositoryId: null },
  })
  assertEquals(application.project, { id: 'prj-1', repositoryId: null })
})

test('buildApplicationModel resolves root principals in alias order', () => {
  const application = buildApplicationModel(MERGED)
  assertEquals(application.principals.map((entry) => entry.alias), [
    'api',
    'web',
  ])
  assertEquals(application.principals[0]?.access, 'none')
  assertEquals(application.principals[1]?.access, 'sftp')
  assertEquals(application.principals[1]?.description, 'site owner')
})

test('buildApplicationModel interprets deploy: through the schedule reader', () => {
  const application = buildApplicationModel(MERGED)
  assertEquals(applicationService(application, 'cache')?.deployment.replicas, 3)
  assertEquals(applicationService(application, 'cache')?.deployment.mode, 'replicated')
  // No `deploy.replicas` and no instances fallback supplied.
  assertEquals(applicationService(application, 'worker')?.deployment.replicas, 1)
})

test('buildApplicationModel takes the instances fallback from the caller', () => {
  const application = buildApplicationModel(MERGED, {
    instancesByComposeName: new Map([['worker', 4]]),
  })
  assertEquals(applicationService(application, 'worker')?.deployment.replicas, 4)
  // An authored `deploy.replicas` still wins over the fallback.
  assertEquals(applicationService(application, 'cache')?.deployment.replicas, 3)
})

test('buildApplicationModel keeps hosting declarations and principal aliases', () => {
  const application = buildApplicationModel(MERGED)
  assertEquals(applicationService(application, 'web')?.hosting, [
    { hostname: 'example.test' },
  ])
  assertEquals(applicationService(application, 'cache')?.hosting, [])
  assertEquals(
    [...principalAliasByServiceName(application)],
    [['web', 'web']],
  )
})

test('buildApplicationModel represents a service whose body is not a mapping', () => {
  const application = buildApplicationModel(doc({ services: { broken: 'nope' } }))
  assertEquals(application.services.map((entry) => entry.name), ['broken'])
  assertEquals(application.services[0]?.compose, {})
  assertEquals(application.services[0]?.kind, 'container')
})

test('host-native and container name splits mirror the service kinds', () => {
  const application = buildApplicationModel(MERGED)
  assertEquals(hostNativeServiceNames(application), ['web'])
  assertEquals(containerServiceNames(application), ['cache', 'worker'])
})

const SERVICE_ROWS = [
  { id: 'svc-web', composeServiceName: 'web' },
  { id: 'svc-cache', composeServiceName: 'cache' },
  { id: 'svc-worker', composeServiceName: 'worker' },
]

test('buildResolvedApplication marks the local half of a scheduled plan', () => {
  const application = buildApplicationModel(MERGED)
  const resolved = buildResolvedApplication({
    serverId: 'srv-1',
    application,
    serviceRows: SERVICE_ROWS,
    slots: [
      { serviceId: 'svc-cache', serverId: 'srv-1', slot: 1, address: '10.0.0.5' },
      { serviceId: 'svc-cache', serverId: 'srv-2', slot: 2, address: null },
      { serviceId: 'svc-worker', serverId: 'srv-2', slot: 1 },
    ],
    principals: {
      principalIdByAlias: new Map([['web', 'prn-web'], ['api', 'prn-api']]),
      aliasByComposeServiceName: new Map([['web', 'web']]),
    },
  })

  assertEquals(resolved.scheduled, true)
  assertEquals(resolved.serverId, 'srv-1')
  assertEquals(resolved.principals, [
    { logicalAlias: 'api', principalId: 'prn-api' },
    { logicalAlias: 'web', principalId: 'prn-web' },
  ])

  const cache = resolved.services.find((entry) => entry.serviceId === 'svc-cache')
  assertEquals(cache?.slots, [
    { ordinal: 1, serverId: 'srv-1', address: '10.0.0.5', local: true },
    { ordinal: 2, serverId: 'srv-2', local: false },
  ])
  assertEquals(resolved.services[0]?.principalId, 'prn-web')
  assertEquals(resolved.services[1]?.principalId, undefined)
  assertEquals(serviceIdsOnServer(resolved), ['svc-cache'])
})

test('a plan that placed nothing here schedules nothing here', () => {
  const resolved = buildResolvedApplication({
    serverId: 'srv-1',
    application: buildApplicationModel(MERGED),
    serviceRows: SERVICE_ROWS,
    slots: [],
  })
  assertEquals(resolved.scheduled, true)
  assertEquals(serviceIdsOnServer(resolved), [])
  assertEquals(localComposeServiceNames(resolved), [])
})

test('the unscheduled path runs the whole environment on this server', () => {
  const resolved = buildResolvedApplication({
    serverId: 'srv-1',
    application: buildApplicationModel(MERGED),
    serviceRows: SERVICE_ROWS,
    expansion: new Map([['cache', ['cache', 'cache-2']]]),
  })
  assertEquals(resolved.scheduled, false)
  assertEquals(serviceIdsOnServer(resolved), [
    'svc-web',
    'svc-cache',
    'svc-worker',
  ])
  assertEquals(localComposeServiceNames(resolved), [
    'web',
    'cache',
    'cache-2',
    'worker',
  ])
})

test('buildResolvedApplication groups containers and clamped resources by service', () => {
  const resolved = buildResolvedApplication({
    serverId: 'srv-1',
    application: buildApplicationModel(MERGED),
    serviceRows: SERVICE_ROWS,
    containers: [
      {
        serviceId: 'svc-cache',
        composeServiceName: 'cache',
        cloneComposeServiceName: 'cache',
        containerRowId: 'ctr-1',
        containerName: 'cache-1',
        ordinal: 1,
        serverId: 'srv-1',
      },
    ],
    resourcesByComposeServiceName: new Map([['cache', { cpus: 2 }]]),
  })
  const cache = resolved.services.find((entry) => entry.serviceId === 'svc-cache')
  assertEquals(cache?.containers.length, 1)
  assertEquals(cache?.resources, { cpus: 2 })
  assertEquals(cache?.clones, ['cache'])
  assertEquals(resolved.services[0]?.hostings, [{ hostname: 'example.test' }])
  assertEquals(resolved.services[0]?.kind, 'site')
})
