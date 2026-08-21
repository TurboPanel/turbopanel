/**
 * Host-free coverage for system.reconcile pure helpers + payload/enqueue
 * short-circuits (Db doubles only — no Postgres).
 */

import { assertEquals } from '@std/assert'
import type { Db } from '../../db.ts'
import type { CommandEnvelope } from '../../lib/commands/envelope.ts'
import type { CommandQueue } from '../../lib/commands/queue.ts'
import {
  ingressContainerNameFromService,
} from '../../lib/naming.ts'
import {
  SYSTEM_HOSTING_INGRESS_COMPONENT,
  SYSTEM_MANAGED_INGRESS_COMPONENT,
  SYSTEM_PROXYSQL_COMPOSE_SERVICE_NAME,
  SYSTEM_SELF_HOST_COMPONENT,
  SYSTEM_SELF_HOST_COMPOSE_SERVICE_NAMES,
  SYSTEM_TRAEFIK_COMPOSE_SERVICE_NAME,
} from './hierarchy.ts'
import {
  buildSystemReconcilePayload,
  enqueueSystemReconcile,
  enqueueSystemReconcileIfConnected,
  hasHttpIngressDemand,
  resolveHostingIngressDesired,
  resolveManagedIngressDesired,
  retireHostingIngressIfIdle,
  runSystemReconcileSweep,
} from './reconcile.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const SERVER = '00000000-0000-4000-8000-000000000002'
const ENV_HOSTING = '00000000-0000-4000-8000-000000000020'
const ENV_MANAGED = '00000000-0000-4000-8000-000000000021'
const ENV_SELF = '00000000-0000-4000-8000-000000000022'
const SVC_TRAEFIK = '00000000-0000-4000-8000-0000000000aa'
const SVC_PROXY = '00000000-0000-4000-8000-0000000000ab'
const SVC_DB = '00000000-0000-4000-8000-0000000000a1'
const SVC_QUEUE = '00000000-0000-4000-8000-0000000000a2'
const ACTOR = '00000000-0000-4000-8000-000000000099'

function createRecordingQueue(): CommandQueue & { envelopes: CommandEnvelope[] } {
  const envelopes: CommandEnvelope[] = []
  return {
    envelopes,
    enqueue: (envelope) => {
      envelopes.push(envelope)
      return Promise.resolve()
    },
  }
}

test('resolveHostingIngressDesired requires demand or prior observation', () => {
  assertEquals(
    resolveHostingIngressDesired({
      hostingEnabled: true,
      hasHttpIngressDemand: false,
      ingressObserved: false,
    }),
    'absent',
  )
  assertEquals(
    resolveHostingIngressDesired({
      hostingEnabled: true,
      hasHttpIngressDemand: true,
      ingressObserved: false,
    }),
    'present',
  )
  assertEquals(
    resolveHostingIngressDesired({
      hostingEnabled: true,
      hasHttpIngressDemand: false,
      ingressObserved: true,
    }),
    'present',
  )
  assertEquals(
    resolveHostingIngressDesired({
      hostingEnabled: false,
      hasHttpIngressDemand: true,
      ingressObserved: true,
    }),
    'absent',
  )
})

test('resolveManagedIngressDesired follows member or bound-consumer presence', () => {
  assertEquals(
    resolveManagedIngressDesired({
      hasManagedMembers: true,
      hasBoundManagedConsumers: false,
    }),
    'present',
  )
  assertEquals(
    resolveManagedIngressDesired({
      hasManagedMembers: false,
      hasBoundManagedConsumers: true,
    }),
    'present',
  )
  assertEquals(
    resolveManagedIngressDesired({
      hasManagedMembers: false,
      hasBoundManagedConsumers: false,
    }),
    'absent',
  )
})

test('buildSystemReconcilePayload returns empty when hierarchy is absent', async () => {
  const db = {
    execute: () => Promise.resolve([]),
  } as unknown as Db
  assertEquals(await buildSystemReconcilePayload(db, { serverId: SERVER }), [])
})

test('buildSystemReconcilePayload builds hosting/managed/self-host components', async () => {
  const db = {
    execute: () => Promise.resolve([
      {
        environment_id: ENV_HOSTING,
        project_component: SYSTEM_HOSTING_INGRESS_COMPONENT,
        service_id: SVC_TRAEFIK,
        name: SYSTEM_TRAEFIK_COMPOSE_SERVICE_NAME,
        server_options: { hosting: { enabled: true } },
        has_http_ingress_demand: true,
        has_managed_members: false,
        ingress_container_id: null,
        ingress_status: 'pending',
      },
      {
        environment_id: ENV_HOSTING,
        project_component: SYSTEM_HOSTING_INGRESS_COMPONENT,
        service_id: 'ignored-other',
        name: 'not-traefik',
        server_options: { hosting: { enabled: true } },
        has_http_ingress_demand: true,
        has_managed_members: false,
        ingress_container_id: null,
        ingress_status: 'pending',
      },
      {
        environment_id: ENV_MANAGED,
        project_component: SYSTEM_MANAGED_INGRESS_COMPONENT,
        service_id: SVC_PROXY,
        name: SYSTEM_PROXYSQL_COMPOSE_SERVICE_NAME,
        server_options: {},
        has_http_ingress_demand: false,
        has_managed_members: true,
        ingress_container_id: null,
        ingress_status: null,
      },
      {
        environment_id: ENV_SELF,
        project_component: SYSTEM_SELF_HOST_COMPONENT,
        service_id: SVC_DB,
        name: SYSTEM_SELF_HOST_COMPOSE_SERVICE_NAMES[0],
        server_options: {},
        has_http_ingress_demand: false,
        has_managed_members: false,
        ingress_container_id: null,
        ingress_status: null,
      },
      {
        environment_id: ENV_SELF,
        project_component: SYSTEM_SELF_HOST_COMPONENT,
        service_id: SVC_QUEUE,
        name: SYSTEM_SELF_HOST_COMPOSE_SERVICE_NAMES[1],
        server_options: {},
        has_http_ingress_demand: false,
        has_managed_members: false,
        ingress_container_id: null,
        ingress_status: null,
      },
      {
        environment_id: ENV_SELF,
        project_component: SYSTEM_SELF_HOST_COMPONENT,
        service_id: 'skip-me',
        name: 'redis',
        server_options: {},
        has_http_ingress_demand: false,
        has_managed_members: false,
        ingress_container_id: null,
        ingress_status: null,
      },
      {
        environment_id: '00000000-0000-4000-8000-000000000023',
        project_component: 'unknown-component',
        service_id: 'x',
        name: 'x',
        server_options: {},
        has_http_ingress_demand: false,
        has_managed_members: false,
        ingress_container_id: null,
        ingress_status: null,
      },
    ]),
  } as unknown as Db

  const payloads = await buildSystemReconcilePayload(db, { serverId: SERVER })
  assertEquals(payloads.length, 3)

  const hosting = payloads.find((p) => p.environmentId === ENV_HOSTING)!
  assertEquals(hosting.components.length, 1)
  assertEquals(hosting.components[0], {
    component: SYSTEM_HOSTING_INGRESS_COMPONENT,
    serviceId: SVC_TRAEFIK,
    composeServiceName: SYSTEM_TRAEFIK_COMPOSE_SERVICE_NAME,
    containerName: ingressContainerNameFromService(SVC_TRAEFIK),
    role: 'ingress',
    desired: 'present',
  })

  const managed = payloads.find((p) => p.environmentId === ENV_MANAGED)!
  assertEquals(managed.components[0]?.desired, 'present')
  assertEquals(managed.components[0]?.composeServiceName, SYSTEM_PROXYSQL_COMPOSE_SERVICE_NAME)
  assertEquals(
    managed.components[0]?.containerName,
    ingressContainerNameFromService(SVC_PROXY),
  )
  assertEquals(managed.components[0]?.role, 'ingress')

  const selfHost = payloads.find((p) => p.environmentId === ENV_SELF)!
  assertEquals(selfHost.components.length, 2)
  assertEquals(
    selfHost.components.every((c) => c.desired === 'present' && c.role === 'turbopanel'),
    true,
  )
})

test('buildSystemReconcilePayload marks hosting absent without demand or observation', async () => {
  const db = {
    execute: () => Promise.resolve([
      {
        environment_id: ENV_HOSTING,
        project_component: SYSTEM_HOSTING_INGRESS_COMPONENT,
        service_id: SVC_TRAEFIK,
        name: SYSTEM_TRAEFIK_COMPOSE_SERVICE_NAME,
        server_options: { hosting: { enabled: true } },
        has_http_ingress_demand: false,
        has_managed_members: false,
        ingress_container_id: null,
        ingress_status: 'pending',
      },
      {
        environment_id: ENV_MANAGED,
        project_component: SYSTEM_MANAGED_INGRESS_COMPONENT,
        service_id: SVC_PROXY,
        name: SYSTEM_PROXYSQL_COMPOSE_SERVICE_NAME,
        server_options: {},
        has_http_ingress_demand: false,
        has_managed_members: false,
        has_bound_managed_consumers: false,
        ingress_container_id: null,
        ingress_status: null,
      },
    ]),
  } as unknown as Db

  const payloads = await buildSystemReconcilePayload(db, { serverId: SERVER })
  assertEquals(payloads[0]?.components[0]?.desired, 'absent')
  assertEquals(payloads[1]?.components[0]?.desired, 'absent')
})

test('buildSystemReconcilePayload marks managed-ingress present for consumer-only servers', async () => {
  const db = {
    execute: () => Promise.resolve([
      {
        environment_id: ENV_MANAGED,
        project_component: SYSTEM_MANAGED_INGRESS_COMPONENT,
        service_id: SVC_PROXY,
        name: SYSTEM_PROXYSQL_COMPOSE_SERVICE_NAME,
        server_options: {},
        has_http_ingress_demand: false,
        has_managed_members: false,
        has_bound_managed_consumers: true,
        ingress_container_id: null,
        ingress_status: null,
      },
    ]),
  } as unknown as Db

  const payloads = await buildSystemReconcilePayload(db, { serverId: SERVER })
  assertEquals(payloads[0]?.components[0]?.desired, 'present')
  assertEquals(payloads[0]?.components[0]?.composeServiceName, SYSTEM_PROXYSQL_COMPOSE_SERVICE_NAME)
})

test('buildSystemReconcilePayload skips environments with no matching services', async () => {
  const db = {
    execute: () => Promise.resolve([
      {
        environment_id: ENV_HOSTING,
        project_component: SYSTEM_HOSTING_INGRESS_COMPONENT,
        service_id: 'other',
        name: 'not-traefik',
        server_options: { hosting: { enabled: true } },
        has_http_ingress_demand: true,
        has_managed_members: false,
        ingress_container_id: null,
        ingress_status: null,
      },
      {
        environment_id: ENV_MANAGED,
        project_component: SYSTEM_MANAGED_INGRESS_COMPONENT,
        service_id: 'other',
        name: 'not-proxysql',
        server_options: {},
        has_http_ingress_demand: false,
        has_managed_members: true,
        ingress_container_id: null,
        ingress_status: null,
      },
    ]),
  } as unknown as Db

  assertEquals(await buildSystemReconcilePayload(db, { serverId: SERVER }), [])
})

test('buildSystemReconcilePayload merges demand/observation flags across rows', async () => {
  const db = {
    execute: () => Promise.resolve([
      {
        environment_id: ENV_HOSTING,
        project_component: SYSTEM_HOSTING_INGRESS_COMPONENT,
        service_id: SVC_TRAEFIK,
        name: SYSTEM_TRAEFIK_COMPOSE_SERVICE_NAME,
        server_options: { hosting: { enabled: true } },
        has_http_ingress_demand: false,
        has_managed_members: false,
        ingress_container_id: null,
        ingress_status: 'exited',
      },
      {
        environment_id: ENV_HOSTING,
        project_component: SYSTEM_HOSTING_INGRESS_COMPONENT,
        service_id: 'sidecar',
        name: 'sidecar',
        server_options: { hosting: { enabled: true } },
        has_http_ingress_demand: true,
        has_managed_members: true,
        ingress_container_id: 'docker-abc',
        ingress_status: 'running',
      },
    ]),
  } as unknown as Db

  const payloads = await buildSystemReconcilePayload(db, { serverId: SERVER })
  assertEquals(payloads[0]?.components[0]?.desired, 'present')
})

test('enqueueSystemReconcile returns not_provisioned when no payloads', async () => {
  const db = {
    execute: () => Promise.resolve([]),
  } as unknown as Db
  const queue = createRecordingQueue()
  const result = await enqueueSystemReconcile(db, queue, {
    serverId: SERVER,
    actorType: 'user',
    actorId: ACTOR,
  })
  assertEquals(result, { ok: false, reason: 'not_provisioned' })
  assertEquals(queue.envelopes.length, 0)
})

test('enqueueSystemReconcileIfConnected skips when is_connected is false', async () => {
  const db = {
    execute: () => Promise.resolve([{ is_connected: false }]),
  } as unknown as Db
  const queue = createRecordingQueue()
  const result = await enqueueSystemReconcileIfConnected(db, queue, SERVER)
  assertEquals(result, { ok: false, reason: 'not_connected' })
  assertEquals(queue.envelopes.length, 0)
})

test('enqueueSystemReconcileIfConnected enqueues when is_connected is true', async () => {
  let executeCalls = 0
  let insertCount = 0
  const db = {
    execute: () => {
      executeCalls += 1
      if (executeCalls === 1) {
        return Promise.resolve([{ is_connected: true }])
      }
      return Promise.resolve([
        {
          environment_id: ENV_SELF,
          project_component: SYSTEM_SELF_HOST_COMPONENT,
          service_id: SVC_DB,
          name: SYSTEM_SELF_HOST_COMPOSE_SERVICE_NAMES[0],
          server_options: {},
          has_http_ingress_demand: false,
          has_managed_members: false,
          ingress_container_id: null,
          ingress_status: null,
        },
      ])
    },
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        insertCount += 1
        return {
          returning: () =>
            Promise.resolve([
              {
                id: `cmd-${insertCount}`,
                createdAt: '2020-01-01T00:00:00.000Z',
                updatedAt: '2020-01-01T00:00:00.000Z',
                serverId: values.serverId,
                actorType: values.actorType,
                actorId: values.actorId,
                name: values.name,
                status: 'queued',
                attempts: 0,
                payload: values.payload,
                result: null,
                metadata: { queuedAt: '2020-01-01T00:00:00.000Z' },
              },
            ]),
        }
      },
    }),
  } as unknown as Db

  const queue = createRecordingQueue()
  const result = await enqueueSystemReconcileIfConnected(db, queue, SERVER)
  assertEquals(result.ok, true)
  if (result.ok) {
    assertEquals(result.commandIds, ['cmd-1'])
    assertEquals(result.serverId, SERVER)
  }
  assertEquals(queue.envelopes.length, 1)
  assertEquals(queue.envelopes[0]?.type, 'system.reconcile')
})

test('enqueueSystemReconcile scopes to environmentId and enqueues', async () => {
  let insertCount = 0
  const db = {
    execute: () => Promise.resolve([
      {
        environment_id: ENV_HOSTING,
        project_component: SYSTEM_HOSTING_INGRESS_COMPONENT,
        service_id: SVC_TRAEFIK,
        name: SYSTEM_TRAEFIK_COMPOSE_SERVICE_NAME,
        server_options: { hosting: { enabled: true } },
        has_http_ingress_demand: true,
        has_managed_members: false,
        ingress_container_id: 'cid',
        ingress_status: 'running',
      },
      {
        environment_id: ENV_SELF,
        project_component: SYSTEM_SELF_HOST_COMPONENT,
        service_id: SVC_DB,
        name: SYSTEM_SELF_HOST_COMPOSE_SERVICE_NAMES[0],
        server_options: {},
        has_http_ingress_demand: false,
        has_managed_members: false,
        ingress_container_id: null,
        ingress_status: null,
      },
    ]),
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        insertCount += 1
        return {
          returning: () =>
            Promise.resolve([
              {
                id: `cmd-${insertCount}`,
                createdAt: '2020-01-01T00:00:00.000Z',
                updatedAt: '2020-01-01T00:00:00.000Z',
                serverId: values.serverId,
                actorType: values.actorType,
                actorId: values.actorId,
                name: values.name,
                status: 'queued',
                attempts: 0,
                payload: values.payload,
                result: null,
                metadata: { queuedAt: '2020-01-01T00:00:00.000Z' },
              },
            ]),
        }
      },
    }),
  } as unknown as Db

  const queue = createRecordingQueue()
  const result = await enqueueSystemReconcile(db, queue, {
    serverId: SERVER,
    actorType: 'user',
    actorId: ACTOR,
    environmentId: ENV_HOSTING,
    action: 'restart',
  })
  assertEquals(result.ok, true)
  if (result.ok) {
    assertEquals(result.commandIds, ['cmd-1'])
    assertEquals(result.commandId, 'cmd-1')
    assertEquals(result.serverId, SERVER)
  }
  assertEquals(queue.envelopes.length, 1)
  assertEquals(queue.envelopes[0]?.type, 'system.reconcile')
})

test('enqueueSystemReconcile returns enqueue_failed when queue rejects all', async () => {
  const db = {
    execute: () => Promise.resolve([
      {
        environment_id: ENV_HOSTING,
        project_component: SYSTEM_HOSTING_INGRESS_COMPONENT,
        service_id: SVC_TRAEFIK,
        name: SYSTEM_TRAEFIK_COMPOSE_SERVICE_NAME,
        server_options: { hosting: { enabled: true } },
        has_http_ingress_demand: true,
        has_managed_members: false,
        ingress_container_id: 'cid',
        ingress_status: 'running',
      },
    ]),
    insert: () => ({
      values: (values: Record<string, unknown>) => ({
        returning: () =>
          Promise.resolve([
            {
              id: 'cmd-fail',
              createdAt: '2020-01-01T00:00:00.000Z',
              updatedAt: '2020-01-01T00:00:00.000Z',
              serverId: values.serverId,
              actorType: values.actorType,
              actorId: values.actorId,
              name: values.name,
              status: 'queued',
              attempts: 0,
              payload: values.payload,
              result: null,
              metadata: { queuedAt: '2020-01-01T00:00:00.000Z' },
            },
          ]),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => ({
          returning: () =>
            Promise.resolve([
              {
                id: 'cmd-fail',
                createdAt: '2020-01-01T00:00:00.000Z',
                updatedAt: '2020-01-01T00:00:01.000Z',
                serverId: SERVER,
                actorType: 'user',
                actorId: ACTOR,
                name: 'system.reconcile',
                status: 'failed',
                attempts: 0,
                payload: {},
                result: null,
                metadata: {
                  queuedAt: '2020-01-01T00:00:00.000Z',
                  error: 'Command queue unavailable',
                  finishedAt: '2020-01-01T00:00:01.000Z',
                },
              },
            ]),
        }),
      }),
    }),
  } as unknown as Db

  const queue: CommandQueue = {
    enqueue: () => Promise.reject(new TypeError('queue down')),
  }

  const result = await enqueueSystemReconcile(db, queue, {
    serverId: SERVER,
    actorType: 'user',
    actorId: ACTOR,
  })
  assertEquals(result, { ok: false, reason: 'enqueue_failed' })
})

test('runSystemReconcileSweep enqueues candidates and counts successes', async () => {
  let executeN = 0
  let insertCount = 0
  const db = {
    execute: () => {
      executeN += 1
      if (executeN === 1) {
        // sweep candidates
        return Promise.resolve([{ server_id: SERVER }])
      }
      // buildSystemReconcilePayload for that server
      return Promise.resolve([
        {
          environment_id: ENV_HOSTING,
          project_component: SYSTEM_HOSTING_INGRESS_COMPONENT,
          service_id: SVC_TRAEFIK,
          name: SYSTEM_TRAEFIK_COMPOSE_SERVICE_NAME,
          server_options: { hosting: { enabled: true } },
          has_http_ingress_demand: true,
          has_managed_members: false,
          ingress_container_id: null,
          ingress_status: 'pending',
        },
      ])
    },
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        insertCount += 1
        return {
          returning: () =>
            Promise.resolve([
              {
                id: `sweep-cmd-${insertCount}`,
                createdAt: '2020-01-01T00:00:00.000Z',
                updatedAt: '2020-01-01T00:00:00.000Z',
                serverId: values.serverId,
                actorType: values.actorType,
                actorId: values.actorId,
                name: values.name,
                status: 'queued',
                attempts: 0,
                payload: values.payload,
                result: null,
                metadata: { queuedAt: '2020-01-01T00:00:00.000Z' },
              },
            ]),
        }
      },
    }),
  } as unknown as Db

  const queue = createRecordingQueue()
  const result = await runSystemReconcileSweep(db, queue, { budget: 5 })
  assertEquals(result.enqueued, 1)
  assertEquals(queue.envelopes.length, 1)
})

test('runSystemReconcileSweep returns zero when no candidates', async () => {
  const db = {
    execute: () => Promise.resolve([]),
  } as unknown as Db
  const queue = createRecordingQueue()
  assertEquals(await runSystemReconcileSweep(db, queue), { enqueued: 0 })
})

/** Sequenced `db.execute` double: one queued result set per query, in order. */
function sequencedExecuteDb(
  resultSets: readonly unknown[][],
  onInsert?: (values: Record<string, unknown>) => void,
): Db {
  const queue = [...resultSets]
  return {
    execute: () => Promise.resolve(queue.shift() ?? []),
    insert: () => ({
      values: (values: Record<string, unknown>) => ({
        returning: () => {
          onInsert?.(values)
          return Promise.resolve([
            {
              id: 'cmd-1',
              serverId: values.serverId,
              type: values.type,
              status: 'queued',
              createdAt: '2026-01-01T00:00:00.000Z',
              queuedAt: '2026-01-01T00:00:00.000Z',
            },
          ])
        },
      }),
    }),
  } as unknown as Db
}

function hostingIngressRow() {
  return {
    environment_id: ENV_HOSTING,
    project_component: SYSTEM_HOSTING_INGRESS_COMPONENT,
    service_id: SVC_TRAEFIK,
    name: SYSTEM_TRAEFIK_COMPOSE_SERVICE_NAME,
    server_options: { hosting: { enabled: true } },
    has_http_ingress_demand: false,
    has_managed_members: false,
    ingress_container_id: 'abc123',
    ingress_status: 'running',
  }
}

test('hasHttpIngressDemand reads the EXISTS projection', async () => {
  assertEquals(
    await hasHttpIngressDemand(
      sequencedExecuteDb([[{ has_demand: true }]]),
      SERVER,
    ),
    true,
  )
  assertEquals(
    await hasHttpIngressDemand(
      sequencedExecuteDb([[{ has_demand: false }]]),
      SERVER,
    ),
    false,
  )
  assertEquals(
    await hasHttpIngressDemand(sequencedExecuteDb([[]]), SERVER),
    false,
  )
})

test('retireHostingIngressIfIdle leaves the proxy up while demand remains', async () => {
  const queue = createRecordingQueue()
  assertEquals(
    await retireHostingIngressIfIdle(
      sequencedExecuteDb([[{ has_demand: true }]]),
      queue,
      { serverId: SERVER, actorType: 'user', actorId: ACTOR },
    ),
    'demand_remains',
  )
  assertEquals(queue.envelopes.length, 0)
})

test('retireHostingIngressIfIdle skips servers with no hosting-ingress hierarchy', async () => {
  const queue = createRecordingQueue()
  assertEquals(
    await retireHostingIngressIfIdle(
      sequencedExecuteDb([[{ has_demand: false }], []]),
      queue,
      { serverId: SERVER, actorType: 'user', actorId: ACTOR },
    ),
    'skipped',
  )
  assertEquals(queue.envelopes.length, 0)
})

test('retireHostingIngressIfIdle stops the shared proxy once demand is gone', async () => {
  const queue = createRecordingQueue()
  const inserted: Array<Record<string, unknown>> = []
  const db = sequencedExecuteDb(
    [
      [{ has_demand: false }],
      [{ id: ENV_HOSTING }],
      [hostingIngressRow()],
    ],
    (values) => inserted.push(values),
  )

  assertEquals(
    await retireHostingIngressIfIdle(db, queue, {
      serverId: SERVER,
      actorType: 'user',
      actorId: ACTOR,
    }),
    'stopped',
  )
  assertEquals(queue.envelopes.length, 1)
  assertEquals(queue.envelopes[0]?.type, 'system.reconcile')
  const payload = inserted[0]?.payload as {
    action: string
    environmentId: string
    components: Array<{ containerName: string }>
  }
  assertEquals(payload.action, 'stop')
  assertEquals(payload.environmentId, ENV_HOSTING)
  assertEquals(
    payload.components[0]?.containerName,
    ingressContainerNameFromService(SVC_TRAEFIK),
  )
})

test('retireHostingIngressIfIdle swallows query failures', async () => {
  const queue = createRecordingQueue()
  const db = {
    execute: () => Promise.reject(new Error('db down')),
  } as unknown as Db
  assertEquals(
    await retireHostingIngressIfIdle(db, queue, {
      serverId: SERVER,
      actorType: 'system',
      actorId: SERVER,
    }),
    'skipped',
  )
})
