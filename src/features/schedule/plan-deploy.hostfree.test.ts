/**
 * Host-free coverage for plan-deploy helpers + planEnvironmentDeploy (no Postgres).
 */

import { assertEquals } from '@std/assert'
import type { Db } from '../../db/connection.ts'
import { COMPOSE_TAG_KEY } from '../compose/tags.ts'
import { emptyComposeDocument } from '../compose/types.ts'
import { networkSharesFingerprint } from '../compose/network-shares.ts'
import {
  environment,
  fabric,
  mount,
  organization,
  project,
  server,
  service,
} from '../../db/schema.ts'
import type { AuditEntry } from '../audit/audit-records.ts'
import {
  computeStoragePinsFromMountRows,
  extractComposeFromOptions,
  planEnvironmentDeploy,
  resolveMergedCompose,
  servicesMapping,
  settleNetworkShares,
  type NetworkSharesActor,
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
/**
 * The strictest actor: none of these documents reach the host, so the
 * host-level gate never engages — which is what these tests rely on.
 */
const AUTOMATED = { kind: 'automated' } as const
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
    metadata?: unknown
  } | null
  project?: { id: string; options: unknown; defaultServerId?: string | null } | null
  services?: Array<{ id: string; composeServiceName: string; options: unknown }>
  fabric?: { id: string } | null
  servers?: Array<{
    id: string
    connected: boolean
    name?: string | null
    hostname?: string | null
    options?: unknown
  }>
  storagePinRows?: Array<{
    serviceId: string
    storageId: string
    locationServerId: string | null
    locationRole: string | null
  }>
  orgOptions?: unknown
  /** Counts `db.update(...)` calls (the host-level approval write). */
  updates?: { count: number }
}

function createPlanDeployDb(opts: PlanDeployDbOpts = {}): Db {
  const envRows = opts.env ? [opts.env] : []
  const projectRows = opts.project ? [opts.project] : []
  const fabricRows = opts.fabric ? [opts.fabric] : []

  const orgRows = opts.orgOptions === undefined ? [] : [{ options: opts.orgOptions }]
  return {
    update: () => ({
      set: () => ({
        where: () => {
          if (opts.updates) opts.updates.count += 1
          return Promise.resolve([])
        },
      }),
    }),
    select: () => ({
      from: (table: unknown) => {
        if (table === organization) {
          return {
            where: () => thenableRows(orgRows),
          }
        }
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
    'docker-compose.staging.yml'
  )
  assertEquals('kind' in mergedServices, false)
  if ('kind' in mergedServices) return
  assertEquals((mergedServices.data.services as Record<string, unknown>).web, {
    image: 'nginx:alpine',
  })

  assertEquals(resolveMergedCompose({ compose: { version: 2 } }, {}, 'env.yml'), {
    kind: 'invalid_compose',
  })
  assertEquals(resolveMergedCompose({ compose: 'not-a-document' }, {}, 'env.yml'), {
    kind: 'invalid_compose',
  })
})

test('resolveMergedCompose maps a merge throw to invalid_compose', () => {
  const circular: Record<string, unknown> = {}
  circular.self = circular
  const base = emptyComposeDocument()
  base.data.services = { web: { image: 'nginx', expose: [] } }
  const overlay = emptyComposeDocument()
  overlay.data.services = { web: { expose: [circular] } }
  assertEquals(resolveMergedCompose({ compose: base }, { compose: overlay }, 'env.yml'), {
    kind: 'invalid_compose',
  })
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
    { environmentId: ENV_ID, organizationId: ORG_ID, hostAccess: AUTOMATED },
    noopDeps()
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
    { environmentId: ENV_ID, organizationId: ORG_ID, hostAccess: AUTOMATED },
    noopDeps()
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
    { environmentId: ENV_ID, organizationId: ORG_ID, hostAccess: AUTOMATED },
    noopDeps()
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
    { environmentId: ENV_ID, organizationId: ORG_ID, hostAccess: AUTOMATED },
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
    })
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
        options: { compose },
        defaultServerId: SERVER_B,
      },
      services: [{ id: SERVICE_WEB, composeServiceName: 'web', options: null }],
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
    { environmentId: ENV_ID, organizationId: ORG_ID, hostAccess: AUTOMATED },
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
            [
              {
                id: 'label-1',
                createdAt: '2020-01-01T00:00:00.000Z',
                updatedAt: '2020-01-01T00:00:00.000Z',
                serverId: SERVER_A,
                key: 'role',
                value: 'web',
              },
            ],
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
    })
  )

  assertEquals('kind' in result, false)
  if ('kind' in result) return

  assertEquals(registerCalls, [{ kind: 'volumes', serverId: SERVER_A }, { kind: 'mounts' }])
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
        options: { compose: emptyComposeDocument() },
        defaultServerId: SERVER_B,
      },
      services: [],
      servers: [{ id: SERVER_B, connected: true }],
    }),
    { environmentId: ENV_ID, organizationId: ORG_ID, hostAccess: AUTOMATED },
    noopDeps({
      registerComposeVolumes: async (_db, params) => {
        registerServerIds.push(params.serverId)
        return []
      },
    })
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
    { environmentId: ENV_ID, organizationId: ORG_ID, hostAccess: AUTOMATED },
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
    })
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

/** Plan a deploy of an environment whose own compose is `changes`, over the web Base. */
async function planWithChanges(changes: Record<string, unknown>, hostAccess = AUTOMATED) {
  const overlay = emptyComposeDocument()
  overlay.data.services = changes
  let reconcileCalls = 0
  const result = await planEnvironmentDeploy(
    createPlanDeployDb({
      env: {
        id: ENV_ID,
        projectId: PROJECT_ID,
        serverId: SERVER_A,
        options: { compose: overlay },
        name: 'production',
      },
      project: { id: PROJECT_ID, options: { compose: composeWithWeb() } },
      services: [],
      servers: [],
    }),
    { environmentId: ENV_ID, organizationId: ORG_ID, hostAccess },
    noopDeps({
      reconcileServicesFromCompose: async () => {
        reconcileCalls += 1
        return { created: [], orphans: [] }
      },
    })
  )
  return { result, reconcileCalls }
}

test('planEnvironmentDeploy deploys changes that only set a field on a Base service', async () => {
  // The environment's own compose has no image: it only sets a command on the
  // `web` the Base defines. The chain used to refuse this layer on its own.
  const { result, reconcileCalls } = await planWithChanges({ web: { command: ['npm', 'start'] } })
  assertEquals('kind' in result, false)
  assertEquals(reconcileCalls, 1)
})

test('planEnvironmentDeploy refuses a new service with no image and names it', async () => {
  const { result, reconcileCalls } = await planWithChanges({ worker: { command: ['node'] } })
  if (!('kind' in result) || result.kind !== 'compose_rejected') {
    throw new TypeError('expected compose_rejected')
  }
  if (result.error.kind !== 'compose_merged_invalid') {
    throw new TypeError(`expected compose_merged_invalid, got ${result.error.kind}`)
  }
  const messages = result.error.issues.map((issue) => issue.message).join('\n')
  assertEquals(messages.includes('Service "worker" must define "image" or "build"'), true)
  assertEquals(reconcileCalls, 0)
})

test('planEnvironmentDeploy still refuses host-reaching settings added by the changes', async () => {
  for (const changes of [
    { web: { privileged: true } },
    { web: { volumes: ['/etc:/host-etc'] } },
    { web: { build: { context: '.', network: 'host' } } },
  ]) {
    const { result, reconcileCalls } = await planWithChanges(changes)
    if (!('kind' in result) || result.kind !== 'compose_rejected') {
      throw new TypeError(`expected compose_rejected for ${JSON.stringify(changes)}`)
    }
    assertEquals(reconcileCalls, 0)
  }
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
    { environmentId: ENV_ID, organizationId: ORG_ID, hostAccess: AUTOMATED },
    noopDeps()
  )
  assertEquals('kind' in planned, false)
  if ('kind' in planned) return
  assertEquals(planned.composeValidated, true)
})

test('planEnvironmentDeploy treats a single-server install as a full deploy target', async () => {
  // Decided 2026-09-17 (user): nothing keeps tenant projects off the host that
  // runs the control plane. One box runs the panel and the operator's
  // projects; the only thing it gives up is multi-node placement. The
  // planner takes no co-located dependency at all — with the control-plane
  // host as the org's only server, an unpinned deploy lands on it, and an
  // explicit pin to it is honoured like any other pin.
  const compose = composeWithWeb()
  const services = [{ id: SERVICE_WEB, composeServiceName: 'web', options: null }]
  const env = {
    id: ENV_ID,
    projectId: PROJECT_ID,
    serverId: null,
    options: {},
    name: 'production',
  }

  const unpinned = await planEnvironmentDeploy(
    createPlanDeployDb({
      env,
      project: { id: PROJECT_ID, options: { compose } },
      services,
      servers: [{ id: SERVER_A, connected: true }],
    }),
    { environmentId: ENV_ID, organizationId: ORG_ID, hostAccess: AUTOMATED },
    noopDeps()
  )
  assertEquals('kind' in unpinned, false)
  if ('kind' in unpinned) return
  assertEquals(unpinned.plan.ok, true)
  if (!unpinned.plan.ok) return
  assertEquals(unpinned.plan.serverIds, [SERVER_A])

  const pinned = await planEnvironmentDeploy(
    createPlanDeployDb({
      env: { ...env, serverId: SERVER_A },
      project: { id: PROJECT_ID, options: { compose } },
      services,
      servers: [
        { id: SERVER_A, connected: true },
        { id: SERVER_B, connected: true },
      ],
    }),
    { environmentId: ENV_ID, organizationId: ORG_ID, hostAccess: AUTOMATED },
    noopDeps()
  )
  assertEquals('kind' in pinned, false)
  if ('kind' in pinned) return
  assertEquals(pinned.plan.ok, true)
  if (!pinned.plan.ok) return
  assertEquals(pinned.plan.serverIds, [SERVER_A])
})

/** A document that reaches the host: the Docker socket bound into `web`. */
const HOST_LEVEL_CHANGES = { web: { volumes: ['/var/run/docker.sock:/var/run/docker.sock'] } }

/**
 * Plan a host-level deploy with the organization gate on, recording every
 * audit entry and every approval write instead of touching a database.
 */
async function planHostLevel(
  hostAccess: Parameters<typeof planEnvironmentDeploy>[1]['hostAccess'],
  metadata: unknown = {}
) {
  const overlay = emptyComposeDocument()
  overlay.data.services = HOST_LEVEL_CHANGES
  const audits: AuditEntry[] = []
  const updates = { count: 0 }
  const result = await planEnvironmentDeploy(
    createPlanDeployDb({
      env: {
        id: ENV_ID,
        projectId: PROJECT_ID,
        serverId: SERVER_A,
        options: { compose: overlay },
        name: 'production',
        metadata,
      },
      project: { id: PROJECT_ID, options: { compose: composeWithWeb() } },
      services: [],
      servers: [],
      orgOptions: { composeGatedFieldsEnabled: true },
      updates,
    }),
    { environmentId: ENV_ID, organizationId: ORG_ID, hostAccess },
    noopDeps({
      recordAudit: async (_db, entry) => {
        audits.push(entry)
      },
    })
  )
  return { result, audits, updates }
}

const MANAGER_ID = '00000000-0000-4000-8000-0000000000ee'
const MANAGER = {
  kind: 'manager',
  userId: MANAGER_ID,
  email: 'owner@example.test',
  recordApproval: true,
} as const

async function approvalFingerprint(): Promise<string> {
  const { audits } = await planHostLevel(MANAGER)
  const fingerprint = audits[0]?.context?.fingerprint
  if (typeof fingerprint !== 'string') throw new TypeError('expected an approve row')
  return fingerprint
}

test('a manager deploy of new host-level content records one approve row', async () => {
  const { result, audits, updates } = await planHostLevel(MANAGER)
  if ('kind' in result) throw new TypeError(`expected a plan, got ${result.kind}`)
  assertEquals(result.hostLevelApproved, true)
  assertEquals(result.hostAccessUse, undefined)
  assertEquals(updates.count, 1)
  assertEquals(audits.length, 1)
  const [entry] = audits
  assertEquals(entry?.action, 'compose.host_access.approve')
  assertEquals(entry?.organizationId, ORG_ID)
  assertEquals(entry?.actorUserId, MANAGER_ID)
  assertEquals(entry?.actorEmail, 'owner@example.test')
  assertEquals(entry?.targetType, 'environment')
  assertEquals(entry?.targetId, ENV_ID)
  assertEquals(entry?.context?.projectId, PROJECT_ID)
  assertEquals(entry?.context?.approvedBy, MANAGER_ID)
  assertEquals(String(entry?.context?.fingerprint).length, 64)
  assertEquals(entry?.context?.pathCount, 1)
})

test('a manager deploy of an already approved fingerprint records nothing new', async () => {
  const fingerprint = await approvalFingerprint()
  const metadata = {
    composeHostAccessApproval: { fingerprint, approvedBy: MANAGER_ID, approvedAt: 'then' },
  }
  const { result, audits, updates } = await planHostLevel(MANAGER, metadata)
  assertEquals('kind' in result, false)
  assertEquals(updates.count, 0)
  assertEquals(audits, [])
})

test('an automated deploy matching the approval carries a use event, written by the route', async () => {
  const fingerprint = await approvalFingerprint()
  const metadata = {
    composeHostAccessApproval: { fingerprint, approvedBy: MANAGER_ID, approvedAt: 'then' },
  }
  const { result, audits, updates } = await planHostLevel(AUTOMATED, metadata)
  if ('kind' in result) throw new TypeError(`expected a plan, got ${result.kind}`)
  assertEquals(result.hostLevelApproved, true)
  assertEquals(result.hostAccessUse?.action, 'compose.host_access.use')
  assertEquals(result.hostAccessUse?.fingerprint, fingerprint)
  assertEquals(result.hostAccessUse?.approvedBy, MANAGER_ID)
  assertEquals(result.hostAccessUse?.approvedAt, 'then')
  // The planner itself writes nothing: the row waits until the deploy is persisted.
  assertEquals(updates.count, 0)
  assertEquals(audits, [])
})

test('an automated deploy that does not match is still refused and records nothing', async () => {
  const metadata = {
    composeHostAccessApproval: { fingerprint: 'f'.repeat(64), approvedBy: MANAGER_ID },
  }
  const { result, audits, updates } = await planHostLevel(AUTOMATED, metadata)
  if (!('kind' in result) || result.kind !== 'compose_rejected') {
    throw new TypeError('expected compose_rejected')
  }
  assertEquals(result.error.kind, 'compose_host_access_requires_approval')
  assertEquals(updates.count, 0)
  assertEquals(audits, [])
})

test('a preview (no approval recorded) and a non-manager record nothing', async () => {
  const preview = await planHostLevel({ ...MANAGER, recordApproval: false })
  assertEquals('kind' in preview.result, false)
  assertEquals(preview.updates.count, 0)
  assertEquals(preview.audits, [])

  const refused = await planHostLevel({ kind: 'not_manager' })
  if (!('kind' in refused.result) || refused.result.kind !== 'compose_rejected') {
    throw new TypeError('expected compose_rejected')
  }
  assertEquals(refused.result.error.kind, 'compose_host_access_requires_manager')
  assertEquals(refused.audits, [])
})

/** A document with one SMB share volume (no host path: it is not host-level). */
function composeWithShare(): ReturnType<typeof emptyComposeDocument> {
  const doc = composeWithWeb()
  doc.data.volumes = {
    media: { driver_opts: { type: 'cifs', device: '//nas.example.net/media', o: 'ro' } },
  }
  return doc
}

const AUTOMATED_SHARES = { kind: 'automated' } as const
const PERMITTED = { kind: 'permitted', userId: MANAGER_ID } as const
const SHARE_MANAGER = { kind: 'manager', userId: MANAGER_ID, recordApproval: false } as const

async function planShare(
  networkShares: NetworkSharesActor | undefined,
  opts: { serverOptions?: unknown; metadata?: unknown; compose?: unknown } = {}
) {
  const audits: AuditEntry[] = []
  const updates = { count: 0 }
  const db = createPlanDeployDb({
    env: {
      id: ENV_ID,
      projectId: PROJECT_ID,
      serverId: SERVER_A,
      options: {},
      name: 'production',
      metadata: opts.metadata ?? {},
    },
    project: { id: PROJECT_ID, options: { compose: opts.compose ?? composeWithShare() } },
    services: [],
    servers: [
      {
        id: SERVER_A,
        connected: true,
        name: 'server-a.example.lan',
        options: opts.serverOptions ?? { networkShares: true },
      },
    ],
    updates,
  })
  const result = await planEnvironmentDeploy(
    db,
    {
      environmentId: ENV_ID,
      organizationId: ORG_ID,
      // The host-level actor never decides a share: an owner here is still denied.
      hostAccess: SHARE_MANAGER,
      ...(networkShares === undefined ? {} : { networkShares }),
    },
    noopDeps({
      recordAudit: async (_db, entry) => {
        audits.push(entry)
      },
    })
  )
  return { db, result, audits, updates }
}

function shareRefusal(result: Awaited<ReturnType<typeof planShare>>['result']) {
  if (!('kind' in result) || result.kind !== 'compose_rejected') {
    throw new TypeError('expected compose_rejected')
  }
  if (result.error.kind !== 'compose_network_shares_refused') {
    throw new TypeError(`expected a network share refusal, got ${result.error.kind}`)
  }
  return result.error
}

function sharePlan(result: Awaited<ReturnType<typeof planShare>>['result']) {
  if ('kind' in result) throw new TypeError(`expected a plan, got ${result.kind}`)
  if (!result.networkShares) throw new TypeError('expected a network share plan')
  return result.networkShares
}

test('planning with the permission sets the flag and writes nothing (the approval waits for the prepared deploy)', async () => {
  const { result, audits, updates } = await planShare(PERMITTED)
  if ('kind' in result) throw new TypeError(`expected a plan, got ${result.kind}`)
  assertEquals(result.allowNetworkShares, true)
  // Shares are not host-level.
  assertEquals(result.hostLevelApproved, false)
  assertEquals(updates.count, 0)
  assertEquals(audits, [])
  assertEquals(sharePlan(result).volumes, ['media'])
})

test('a document without a share never sets the flag', async () => {
  const { result, audits } = await planShare(PERMITTED, {
    compose: composeWithWeb(),
    serverOptions: {},
  })
  if ('kind' in result) throw new TypeError(`expected a plan, got ${result.kind}`)
  assertEquals(result.allowNetworkShares, false)
  assertEquals(result.networkShares, undefined)
  assertEquals(audits, [])
})

test('no permission, or no actor given, is refused before anything is written', async () => {
  for (const actor of [{ kind: 'denied' } as const, undefined]) {
    const { result, audits, updates } = await planShare(actor)
    const error = shareRefusal(result)
    assertEquals(error.reason, 'permission')
    assertEquals(error.volumes, ['media'])
    assertEquals(updates.count, 0)
    assertEquals(audits, [])
  }
})

test('a server with Allow Network Shares off refuses even a permitted person, naming the server', async () => {
  for (const serverOptions of [{}, { networkShares: false }, { networkShares: 'true' }]) {
    const { result } = await planShare(PERMITTED, { serverOptions })
    const error = shareRefusal(result)
    assertEquals(error.reason, 'server_setting')
    assertEquals(error.servers, [{ id: SERVER_A, name: 'server-a.example.lan' }])
  }
})

const APPROVED_AT = '2026-01-01T00:00:00.000Z'

async function approvedMetadata(resolved: string[] = ['hash-a']) {
  const fingerprint = await networkSharesFingerprint(composeWithShare().data)
  return {
    composeNetworkSharesApproval: {
      fingerprint,
      resolved,
      approvedBy: MANAGER_ID,
      approvedAt: APPROVED_AT,
    },
  }
}

test('an automated deploy needs an approval recorded for these exact shares', async () => {
  const none = await planShare(AUTOMATED_SHARES)
  assertEquals(shareRefusal(none.result).reason, 'approval')
  assertEquals(none.updates.count, 0)

  const metadata = await approvedMetadata()
  const approved = await planShare(AUTOMATED_SHARES, { metadata })
  if ('kind' in approved.result) throw new TypeError('expected a plan')
  assertEquals(approved.result.allowNetworkShares, true)
  assertEquals(approved.updates.count, 0)

  const moved = composeWithShare()
  moved.data.volumes = {
    media: { driver_opts: { type: 'cifs', device: '//nas.example.net/other', o: 'ro' } },
  }
  const changed = await planShare(AUTOMATED_SHARES, { metadata, compose: moved })
  assertEquals(shareRefusal(changed.result).reason, 'approval')

  // A matching approval does not skip the server half.
  const off = await planShare(AUTOMATED_SHARES, { metadata, serverOptions: {} })
  assertEquals(shareRefusal(off.result).reason, 'server_setting')
})

test('turning Allow Network Shares off and on again voids an earlier approval', async () => {
  const metadata = await approvedMetadata()
  const reenabled = await planShare(AUTOMATED_SHARES, {
    metadata,
    serverOptions: { networkShares: true, networkSharesSince: '2026-02-01T00:00:00.000Z' },
  })
  const error = shareRefusal(reenabled.result)
  assertEquals(error.reason, 'approval')
  assertEquals(error.servers, [{ id: SERVER_A, name: 'server-a.example.lan' }])

  const before = await planShare(AUTOMATED_SHARES, {
    metadata,
    serverOptions: { networkShares: true, networkSharesSince: '2025-12-01T00:00:00.000Z' },
  })
  if ('kind' in before.result) throw new TypeError('expected a plan')
  assertEquals(before.result.allowNetworkShares, true)
})

test('an approved host-level fingerprint does not approve a share, and the reverse', async () => {
  const hostFingerprint = await approvalFingerprint()
  const { result } = await planShare(AUTOMATED_SHARES, {
    metadata: {
      composeHostAccessApproval: { fingerprint: hostFingerprint, approvedBy: MANAGER_ID },
    },
  })
  assertEquals(shareRefusal(result).reason, 'approval')
})

async function settle(
  actor: NetworkSharesActor,
  resolved: string[],
  opts: { metadata?: unknown; serverOptions?: unknown; record?: boolean } = {}
) {
  const planned = await planShare(actor, {
    metadata: opts.metadata,
    serverOptions: opts.serverOptions,
  })
  const audits: AuditEntry[] = []
  const outcome = await settleNetworkShares(
    planned.db,
    {
      shares: sharePlan(planned.result),
      organizationId: ORG_ID,
      environmentId: ENV_ID,
      projectId: PROJECT_ID,
      resolved,
      record: opts.record ?? true,
    },
    async (_db, entry) => {
      audits.push(entry)
    }
  )
  return { outcome, audits, updates: planned.updates }
}

test('a permitted deploy records the approval with what the shares resolved to', async () => {
  const { outcome, audits, updates } = await settle(PERMITTED, ['hash-a', 'hash-a'])
  assertEquals(outcome, {})
  assertEquals(updates.count, 1)
  assertEquals(audits.length, 1)
  assertEquals(audits[0]?.action, 'compose.network_shares.approve')
  assertEquals(audits[0]?.actorUserId, MANAGER_ID)
  assertEquals(audits[0]?.context?.volumes, ['media'])
  assertEquals(audits[0]?.context?.resolved, ['hash-a'])
  assertEquals(String(audits[0]?.context?.fingerprint).length, 64)
})

test('an unchanged approval is not rewritten; a new resolved hash is', async () => {
  const metadata = await approvedMetadata(['hash-a'])
  const same = await settle(PERMITTED, ['hash-a'], { metadata })
  assertEquals(same.updates.count, 0)
  assertEquals(same.audits, [])

  const moved = await settle(PERMITTED, ['hash-b'], { metadata })
  assertEquals(moved.updates.count, 1)
  assertEquals(moved.audits[0]?.context?.resolved, ['hash-b'])
})

test('a preview or hostings-only run (record off) approves nothing', async () => {
  const { outcome, audits, updates } = await settle(PERMITTED, ['hash-a'], { record: false })
  assertEquals(outcome, {})
  assertEquals(updates.count, 0)
  assertEquals(audits, [])
})

test('an automated deploy runs only when every resolved hash was approved, and reports the use', async () => {
  const metadata = await approvedMetadata(['hash-a'])
  const ok = await settle(AUTOMATED_SHARES, ['hash-a'], { metadata })
  assertEquals('error' in ok.outcome, false)
  const use = (ok.outcome as { use?: { approvedBy: string; resolved: string[] } }).use
  assertEquals(use?.approvedBy, MANAGER_ID)
  assertEquals(use?.resolved, ['hash-a'])
  assertEquals(ok.updates.count, 0)

  // The variable-driven change: same authored text, a different resolved mount.
  const bypass = await settle(AUTOMATED_SHARES, ['hash-a', 'hash-other'], { metadata })
  if (!('error' in bypass.outcome)) throw new TypeError('expected a refusal')
  assertEquals(bypass.outcome.error.kind, 'compose_network_shares_refused')
  assertEquals(bypass.updates.count, 0)
})
