/**
 * Host-free coverage for plan-deploy helpers + planEnvironmentDeploy (no Postgres).
 */

import { assertEquals } from '@std/assert'
import type { Db } from '../../db.ts'
import { COMPOSE_TAG_KEY } from '../compose/tags.ts'
import { emptyComposeDocument } from '../compose/types.ts'
import {
  environment,
  fabric,
  mount,
  project,
  server,
  service,
} from '../db/schema.ts'
import {
  computeStoragePinsFromMountRows,
  extractComposeFromOptions,
  planEnvironmentDeploy,
  resolveMergedCompose,
  servicesMapping,
  type PlanEnvironmentDeployDeps,
} from './plan-deploy.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const ORG_ID = '00000000-0000-4000-8000-000000000001'
const ENV_ID = '00000000-0000-4000-8000-000000000002'
const PROJECT_ID = '00000000-0000-4000-8000-000000000003'
const FABRIC_ID = '00000000-0000-4000-8000-0000000000ff'
const SERVER_A = '00000000-0000-4000-8000-00000000000a'
const SERVER_B = '00000000-0000-4000-8000-00000000000b'
const SERVICE_WEB = '00000000-0000-4000-8000-0000000000aa'
const SERVICE_DB = '00000000-0000-4000-8000-0000000000bb'
const STORAGE_VOL = '00000000-0000-4000-8000-0000000000cc'
const STORAGE_SHARED = '00000000-0000-4000-8000-0000000000dd'

function thenableRows(rows: unknown[]) {
  const promise = Promise.resolve(rows)
  return {
    limit: () => promise,
    orderBy: () => thenableRows(rows),
    then: promise.then.bind(promise),
    catch: promise.catch.bind(promise),
    finally: promise.finally.bind(promise),
  }
}

type PlanDeployDbOpts = {
  env?: {
    id: string
    projectId: string
    serverId: string | null
    options: unknown
    name: string | null
  } | null
  project?: { id: string; options: unknown } | null
  services?: Array<{ id: string; composeServiceName: string; options: unknown }>
  fabric?: { id: string } | null
  servers?: Array<{
    id: string
    connected: boolean
  }>
  storagePinRows?: Array<{
    serviceId: string
    storageId: string
    locationServerId: string | null
    locationRole: string | null
  }>
}

function createPlanDeployDb(opts: PlanDeployDbOpts = {}): Db {
  const envRows = opts.env ? [opts.env] : []
  const projectRows = opts.project ? [opts.project] : []
  const fabricRows = opts.fabric ? [opts.fabric] : []

  return {
    select: () => ({
      from: (table: unknown) => {
        if (table === environment) {
          return {
            where: () => thenableRows(envRows),
          }
        }
        if (table === project) {
          return {
            where: () => thenableRows(projectRows),
          }
        }
        if (table === service) {
          return {
            where: () => thenableRows(opts.services ?? []),
          }
        }
        if (table === fabric) {
          return {
            where: () => thenableRows(fabricRows),
          }
        }
        if (table === server) {
          return {
            where: () => thenableRows(opts.servers ?? []),
          }
        }
        if (table === mount) {
          return {
            innerJoin: () => ({
              innerJoin: () => ({
                where: () => thenableRows(opts.storagePinRows ?? []),
              }),
            }),
          }
        }
        return {
          where: () => thenableRows([]),
        }
      },
    }),
  } as unknown as Db
}

function noopDeps(overrides: PlanEnvironmentDeployDeps = {}): PlanEnvironmentDeployDeps {
  return {
    reconcileServicesFromCompose: async () => ({ created: [], orphans: [] }),
    registerComposeVolumes: async () => [],
    registerComposeMounts: async () => undefined,
    listEnvironmentSlots: async () => [],
    listServerLabelsForServers: async () => new Map(),
    ...overrides,
  }
}

function composeWithWeb(): ReturnType<typeof emptyComposeDocument> {
  const doc = emptyComposeDocument()
  doc.data.services = { web: { image: 'nginx:alpine' } }
  return doc
}

test('extractComposeFromOptions returns compose or null for non-records', () => {
  assertEquals(extractComposeFromOptions(null), null)
  assertEquals(extractComposeFromOptions('x'), null)
  assertEquals(extractComposeFromOptions([]), null)
  assertEquals(extractComposeFromOptions({}), null)
  assertEquals(extractComposeFromOptions({ compose: null }), null)

  const compose = emptyComposeDocument()
  assertEquals(extractComposeFromOptions({ compose }), compose)
})

test('resolveMergedCompose merges blank layers and rejects invalid compose', () => {
  const merged = resolveMergedCompose({}, {}, 'docker-compose.production.yml')
  assertEquals('kind' in merged, false)
  if ('kind' in merged) return
  assertEquals(merged.version, 1)
  assertEquals(merged.data, {})

  const withServices = emptyComposeDocument()
  withServices.data.services = { web: { image: 'nginx:alpine' } }
  const mergedServices = resolveMergedCompose(
    { compose: withServices },
    {},
    'docker-compose.staging.yml',
  )
  assertEquals('kind' in mergedServices, false)
  if ('kind' in mergedServices) return
  assertEquals(
    (mergedServices.data.services as Record<string, unknown>).web,
    { image: 'nginx:alpine' },
  )

  assertEquals(
    resolveMergedCompose({ compose: { version: 2 } }, {}, 'env.yml'),
    { kind: 'invalid_compose' },
  )
  assertEquals(
    resolveMergedCompose({ compose: 'not-a-document' }, {}, 'env.yml'),
    { kind: 'invalid_compose' },
  )
})

test('resolveMergedCompose maps a merge throw to invalid_compose', () => {
  const circular: Record<string, unknown> = {}
  circular.self = circular
  const base = emptyComposeDocument()
  base.data.services = { web: { image: 'nginx', expose: [] } }
  const overlay = emptyComposeDocument()
  overlay.data.services = { web: { expose: [circular] } }
  assertEquals(
    resolveMergedCompose({ compose: base }, { compose: overlay }, 'env.yml'),
    { kind: 'invalid_compose' },
  )
})

test('servicesMapping returns the services map or empty object', () => {
  const doc = emptyComposeDocument()
  assertEquals(servicesMapping(doc), {})

  doc.data.services = { api: { image: 'node:22' } }
  assertEquals(servicesMapping(doc), { api: { image: 'node:22' } })

  doc.data.services = ['not', 'a', 'map'] as unknown as Record<string, unknown>
  assertEquals(servicesMapping(doc), {})

  doc.data.services = null as unknown as Record<string, unknown>
  assertEquals(servicesMapping(doc), {})
})

test('computeStoragePinsFromMountRows pins services to primary locations', () => {
  const pins = computeStoragePinsFromMountRows([
    {
      serviceId: SERVICE_WEB,
      storageId: STORAGE_VOL,
      locationServerId: SERVER_A,
      locationRole: 'primary',
    },
    {
      serviceId: SERVICE_WEB,
      storageId: STORAGE_VOL,
      locationServerId: SERVER_B,
      locationRole: 'replica',
    },
  ])
  assertEquals([...pins.entries()], [[SERVICE_WEB, SERVER_A]])
})

test('computeStoragePinsFromMountRows skips shared volumes and first-wins per service', () => {
  const pins = computeStoragePinsFromMountRows([
    {
      serviceId: SERVICE_WEB,
      storageId: STORAGE_SHARED,
      locationServerId: null,
      locationRole: 'primary',
    },
    {
      serviceId: SERVICE_DB,
      storageId: STORAGE_VOL,
      locationServerId: SERVER_B,
      locationRole: 'primary',
    },
    {
      serviceId: SERVICE_DB,
      storageId: '00000000-0000-4000-8000-0000000000ee',
      locationServerId: SERVER_A,
      locationRole: 'primary',
    },
  ])
  assertEquals(pins.has(SERVICE_WEB), false)
  assertEquals(pins.get(SERVICE_DB), SERVER_B)
})

test('computeStoragePinsFromMountRows ignores rows without a primary server', () => {
  const pins = computeStoragePinsFromMountRows([
    {
      serviceId: SERVICE_WEB,
      storageId: STORAGE_VOL,
      locationServerId: SERVER_A,
      locationRole: 'replica',
    },
  ])
  assertEquals(pins.size, 0)
})

test('planEnvironmentDeploy returns not_found when environment is missing', async () => {
  const result = await planEnvironmentDeploy(
    createPlanDeployDb({ env: null }),
    { environmentId: ENV_ID, organizationId: ORG_ID },
    noopDeps(),
  )
  assertEquals(result, { kind: 'not_found' })
})

test('planEnvironmentDeploy returns not_found when project is missing', async () => {
  const result = await planEnvironmentDeploy(
    createPlanDeployDb({
      env: {
        id: ENV_ID,
        projectId: PROJECT_ID,
        serverId: null,
        options: {},
        name: 'production',
      },
      project: null,
    }),
    { environmentId: ENV_ID, organizationId: ORG_ID },
    noopDeps(),
  )
  assertEquals(result, { kind: 'not_found' })
})

test('planEnvironmentDeploy returns invalid_compose for bad project compose', async () => {
  const result = await planEnvironmentDeploy(
    createPlanDeployDb({
      env: {
        id: ENV_ID,
        projectId: PROJECT_ID,
        serverId: null,
        options: {},
        name: 'production',
      },
      project: { id: PROJECT_ID, options: { compose: { version: 2 } } },
    }),
    { environmentId: ENV_ID, organizationId: ORG_ID },
    noopDeps(),
  )
  assertEquals(result, { kind: 'invalid_compose' })
})

test('planEnvironmentDeploy skips register when no pin or default server', async () => {
  let registerVolumesCalls = 0
  let registerMountsCalls = 0
  let reconcileCalls = 0

  const result = await planEnvironmentDeploy(
    createPlanDeployDb({
      env: {
        id: ENV_ID,
        projectId: PROJECT_ID,
        serverId: null,
        options: {},
        name: 'production',
      },
      project: { id: PROJECT_ID, options: { compose: emptyComposeDocument() } },
      services: [],
      servers: [],
    }),
    { environmentId: ENV_ID, organizationId: ORG_ID },
    noopDeps({
      reconcileServicesFromCompose: async () => {
        reconcileCalls += 1
        return { created: [], orphans: [] }
      },
      registerComposeVolumes: async () => {
        registerVolumesCalls += 1
        return []
      },
      registerComposeMounts: async () => {
        registerMountsCalls += 1
      },
    }),
  )

  assertEquals('kind' in result, false)
  if ('kind' in result) return
  assertEquals(reconcileCalls, 1)
  assertEquals(registerVolumesCalls, 0)
  assertEquals(registerMountsCalls, 0)
  assertEquals(result.pinServerId, null)
  assertEquals(result.defaultServerId, null)
  assertEquals(result.fabricEnabled, false)
  assertEquals(result.fabricId, null)
  assertEquals(result.projectId, PROJECT_ID)
  assertEquals(result.plan.ok, true)
})

test('planEnvironmentDeploy registers volumes/mounts and plans with pin + fabric + storage pins', async () => {
  const compose = composeWithWeb()
  const registerCalls: Array<{ kind: string; serverId?: string }> = []
  const labelCalls: string[][] = []

  const result = await planEnvironmentDeploy(
    createPlanDeployDb({
      env: {
        id: ENV_ID,
        projectId: PROJECT_ID,
        serverId: SERVER_A,
        options: {},
        name: 'production',
      },
      project: {
        id: PROJECT_ID,
        options: {
          compose,
          defaultServerId: SERVER_B,
        },
      },
      services: [
        { id: SERVICE_WEB, composeServiceName: 'web', options: null },
      ],
      fabric: { id: FABRIC_ID },
      servers: [
        { id: SERVER_A, connected: true },
        { id: SERVER_B, connected: true },
      ],
      storagePinRows: [
        {
          serviceId: SERVICE_WEB,
          storageId: STORAGE_VOL,
          locationServerId: SERVER_A,
          locationRole: 'primary',
        },
      ],
    }),
    { environmentId: ENV_ID, organizationId: ORG_ID },
    noopDeps({
      registerComposeVolumes: async (_db, params) => {
        registerCalls.push({ kind: 'volumes', serverId: params.serverId })
        return []
      },
      registerComposeMounts: async () => {
        registerCalls.push({ kind: 'mounts' })
      },
      listServerLabelsForServers: async (_db, serverIds) => {
        labelCalls.push([...serverIds].sort((a, b) => a.localeCompare(b)))
        return new Map([
          [
            SERVER_A,
            [{
              id: 'label-1',
              createdAt: '2020-01-01T00:00:00.000Z',
              updatedAt: '2020-01-01T00:00:00.000Z',
              serverId: SERVER_A,
              key: 'role',
              value: 'web',
            }],
          ],
        ])
      },
      listEnvironmentSlots: async () => [
        {
          id: 'task-1',
          createdAt: '2020-01-01T00:00:00.000Z',
          updatedAt: '2020-01-01T00:00:00.000Z',
          metadata: null,
          options: null,
          environmentId: ENV_ID,
          serviceId: SERVICE_WEB,
          serverId: SERVER_A,
          slot: 0,
          generation: 1,
          desiredState: 'running',
          address: null,
        },
      ],
    }),
  )

  assertEquals('kind' in result, false)
  if ('kind' in result) return

  assertEquals(registerCalls, [
    { kind: 'volumes', serverId: SERVER_A },
    { kind: 'mounts' },
  ])
  assertEquals(labelCalls, [[SERVER_A, SERVER_B]])
  assertEquals(result.pinServerId, SERVER_A)
  assertEquals(result.defaultServerId, SERVER_B)
  assertEquals(result.fabricEnabled, true)
  assertEquals(result.fabricId, FABRIC_ID)
  assertEquals(result.serviceRows.length, 1)
  assertEquals(result.serviceRows[0]?.composeServiceName, 'web')
  assertEquals(result.plan.ok, true)
  if (!result.plan.ok) return
  assertEquals(result.plan.serverIds, [SERVER_A])
  assertEquals(result.plan.slots.length, 1)
  assertEquals(result.plan.slots[0]?.serviceId, SERVICE_WEB)
  assertEquals(result.plan.slots[0]?.serverId, SERVER_A)
})

test('planEnvironmentDeploy uses project defaultServerId for register when env has no pin', async () => {
  const registerServerIds: string[] = []

  const result = await planEnvironmentDeploy(
    createPlanDeployDb({
      env: {
        id: ENV_ID,
        projectId: PROJECT_ID,
        serverId: null,
        options: {},
        name: 'staging',
      },
      project: {
        id: PROJECT_ID,
        options: {
          compose: emptyComposeDocument(),
          defaultServerId: SERVER_B,
        },
      },
      services: [],
      servers: [{ id: SERVER_B, connected: true }],
    }),
    { environmentId: ENV_ID, organizationId: ORG_ID },
    noopDeps({
      registerComposeVolumes: async (_db, params) => {
        registerServerIds.push(params.serverId)
        return []
      },
    }),
  )

  assertEquals('kind' in result, false)
  if ('kind' in result) return
  assertEquals(registerServerIds, [SERVER_B])
  assertEquals(result.pinServerId, null)
  assertEquals(result.defaultServerId, SERVER_B)
})

test('planEnvironmentDeploy refuses a rejected merge before it writes a row', async () => {
  // The base declares an image; the environment overlay resets it. Each layer
  // saves cleanly, their merge is a service with nothing to run, and the deploy
  // is refused — the point of the assertion is *where*: no `service` row
  // reconciled, no `storage` or `mount` row registered on the way out.
  const base = emptyComposeDocument()
  base.data.services = { web: { image: 'nginx:alpine' } }
  const overlay = emptyComposeDocument()
  overlay.data.services = {
    web: { image: { [COMPOSE_TAG_KEY]: 'reset', value: null } },
  }

  let reconcileCalls = 0
  let registerVolumesCalls = 0
  let registerMountsCalls = 0

  const result = await planEnvironmentDeploy(
    createPlanDeployDb({
      env: {
        id: ENV_ID,
        projectId: PROJECT_ID,
        serverId: SERVER_A,
        options: { compose: overlay },
        name: 'production',
      },
      project: { id: PROJECT_ID, options: { compose: base } },
      services: [],
      servers: [],
    }),
    { environmentId: ENV_ID, organizationId: ORG_ID },
    noopDeps({
      reconcileServicesFromCompose: async () => {
        reconcileCalls += 1
        return { created: [], orphans: [] }
      },
      registerComposeVolumes: async () => {
        registerVolumesCalls += 1
        return []
      },
      registerComposeMounts: async () => {
        registerMountsCalls += 1
      },
    }),
  )

  assertEquals('kind' in result, true)
  if (!('kind' in result)) return
  assertEquals(result.kind, 'compose_rejected')
  if (result.kind !== 'compose_rejected') return
  assertEquals(result.error.kind, 'compose_merged_invalid')
  assertEquals(reconcileCalls, 0)
  assertEquals(registerVolumesCalls, 0)
  assertEquals(registerMountsCalls, 0)
})

test('planEnvironmentDeploy stamps the plan with the validation it already ran', async () => {
  // The per-server prepare reads this to skip re-deriving the same verdict once
  // per host; it is only ever set on a plan that passed the gate above.
  const planned = await planEnvironmentDeploy(
    createPlanDeployDb({
      env: {
        id: ENV_ID,
        projectId: PROJECT_ID,
        serverId: null,
        options: {},
        name: 'production',
      },
      project: { id: PROJECT_ID, options: { compose: composeWithWeb() } },
      services: [],
      servers: [],
    }),
    { environmentId: ENV_ID, organizationId: ORG_ID },
    noopDeps(),
  )
  assertEquals('kind' in planned, false)
  if ('kind' in planned) return
  assertEquals(planned.composeValidated, true)
})
