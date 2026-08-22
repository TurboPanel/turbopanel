/**
 * Host-free coverage for delete-time host reclaim: planning `environment.stop`
 * from rows the delete is about to remove, dispatching it best-effort, and
 * retiring the shared HTTP Traefik once demand is gone.
 */

import { assertEquals } from '@std/assert'
import type { Db } from '../../db.ts'
import type { CommandQueue } from '../../lib/commands/queue.ts'
import {
  dispatchEnvironmentTeardown,
  planEnvironmentTeardown,
  planEnvironmentsTeardown,
  type EnvironmentTeardownPlan,
} from './teardown.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const ENV_ID = 'env-1'
const PROJECT_ID = 'proj-1'
/** `defaultServerId` only parses as a placement pin when it is a real UUID. */
const DEFAULT_SERVER_ID = '00000000-0000-4000-8000-00000000d1f7'

/**
 * Drizzle-shaped double: every builder method returns the same chain, and each
 * `await` consumes the next queued result set (queries run in call order).
 */
function fakeDb(resultSets: unknown[][]): Db {
  const queue = [...resultSets]
  const chain: unknown = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'then') {
          const promise = Promise.resolve(queue.shift() ?? [])
          return promise.then.bind(promise)
        }
        if (prop === 'catch' || prop === 'finally') return undefined
        return () => chain
      },
    },
  )
  return chain as Db
}

function deploymentRow(serverId: string) {
  return {
    id: `dep-${serverId}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    metadata: null,
    options: null,
    environmentId: ENV_ID,
    serverId,
    desiredGeneration: 1,
    appliedGeneration: 1,
    desiredHash: null,
    status: 'applied',
    lastCommandId: null,
  }
}

function plan(
  overrides: Partial<EnvironmentTeardownPlan> = {},
): EnvironmentTeardownPlan {
  return {
    environmentId: ENV_ID,
    projectId: PROJECT_ID,
    projectName: PROJECT_ID,
    serverIds: ['srv-a'],
    ingressServices: [],
    fabricNetworksByServer: new Map(),
    ...overrides,
  }
}

test('planEnvironmentTeardown returns null when the environment is gone', async () => {
  assertEquals(await planEnvironmentTeardown(fakeDb([[]]), ENV_ID), null)
})

test('planEnvironmentTeardown returns null when the project row is gone', async () => {
  const db = fakeDb([[{ id: ENV_ID, projectId: PROJECT_ID, serverId: null }], []])
  assertEquals(await planEnvironmentTeardown(db, ENV_ID), null)
})

test('planEnvironmentTeardown returns null when nothing places the environment', async () => {
  const db = fakeDb([
    [{ id: ENV_ID, projectId: PROJECT_ID, serverId: null }],
    [{ id: PROJECT_ID, options: {} }],
    [],
  ])
  assertEquals(await planEnvironmentTeardown(db, ENV_ID), null)
})

test('planEnvironmentTeardown prefers deployment rows over the pin', async () => {
  const db = fakeDb([
    [{ id: ENV_ID, projectId: PROJECT_ID, serverId: 'srv-pin' }],
    [{ id: PROJECT_ID, options: { defaultServerId: DEFAULT_SERVER_ID } }],
    [deploymentRow('srv-b'), deploymentRow('srv-a')],
    [],
    [],
  ])
  const result = await planEnvironmentTeardown(db, ENV_ID)
  assertEquals(result?.serverIds, ['srv-a', 'srv-b'])
  assertEquals(result?.projectName, PROJECT_ID)
})

test('planEnvironmentTeardown falls back to the effective pin and collects ingress + fabric', async () => {
  const db = fakeDb([
    [{ id: ENV_ID, projectId: PROJECT_ID, serverId: null }],
    [{ id: PROJECT_ID, options: { defaultServerId: DEFAULT_SERVER_ID } }],
    [],
    [
      {
        serviceId: 'svc-1',
        composeServiceName: 'web',
        hostingOptions: { protocol: 'tcp', ports: [{ published: 9000, target: 80 }] },
      },
    ],
    [{ networkId: 'net-1', serverId: DEFAULT_SERVER_ID, subnet: '10.10.0.0/24' }],
  ])
  const result = await planEnvironmentTeardown(db, ENV_ID)
  assertEquals(result?.serverIds, [DEFAULT_SERVER_ID])
  assertEquals(result?.ingressServices, [{ serviceId: 'svc-1' }])
  assertEquals(
    (result?.fabricNetworksByServer.get(DEFAULT_SERVER_ID) ?? []).length,
    1,
  )
})

test('planEnvironmentsTeardown drops environments with nothing to reclaim', async () => {
  const db = fakeDb([
    [],
    [{ id: ENV_ID, projectId: PROJECT_ID, serverId: 'srv-a' }],
    [{ id: PROJECT_ID, options: {} }],
    [],
    [],
    [],
  ])
  const plans = await planEnvironmentsTeardown(db, ['env-missing', ENV_ID])
  assertEquals(plans.length, 1)
  assertEquals(plans[0]?.serverIds, ['srv-a'])
})

/** Command-record double: captures inserts, reports transitions. */
function fakeCommandDb(
  captured: { payloads: unknown[]; transitions: string[] },
): Db {
  return {
    // createCommandRecord writes command + dispatch in one transaction.
    transaction(fn: (tx: unknown) => Promise<unknown>) {
      return fn(this)
    },
    insert: () => ({
      values: (values: Record<string, unknown>) => ({
        // Dispatch payload rows carry `commandId`; command rows carry `serverId`.
        returning: () => {
          return Promise.resolve([
            {
              id: `cmd-${captured.payloads.length}`,
              serverId: values.serverId,
              type: values.type,
              status: 'queued',
              createdAt: '2026-01-01T00:00:00.000Z',
              queuedAt: '2026-01-01T00:00:00.000Z',
            },
          ])
        },
        then: (resolve: (value: unknown) => unknown) => {
          if (values.payload !== undefined) captured.payloads.push(values.payload)
          return Promise.resolve(undefined).then(resolve)
        },
      }),
    }),
    update: () => ({
      set: (fields: Record<string, unknown>) => ({
        where: () => ({
          returning: () => {
            captured.transitions.push(String(fields.status))
            return Promise.resolve([{ id: 'cmd-1', status: fields.status }])
          },
        }),
      }),
    }),
  } as unknown as Db
}

test('dispatchEnvironmentTeardown enqueues one stop per server with its own networks', async () => {
  const captured = { payloads: [] as unknown[], transitions: [] as string[] }
  const enqueued: string[] = []
  const queue = {
    enqueue: (envelope: { serverId: string }) => {
      enqueued.push(envelope.serverId)
      return Promise.resolve()
    },
  } as unknown as CommandQueue

  const servers = await dispatchEnvironmentTeardown(
    fakeCommandDb(captured),
    queue,
    [
      plan({
        serverIds: ['srv-a', 'srv-b'],
        ingressServices: [{ serviceId: 'svc-1' }],
        fabricNetworksByServer: new Map([['srv-a', ['tpn_one']]]),
      }),
    ],
    'user-1',
  )

  assertEquals(servers, ['srv-a', 'srv-b'])
  assertEquals(enqueued.sort(), ['srv-a', 'srv-b'])
  const payloads = captured.payloads as Array<Record<string, unknown>>
  assertEquals(payloads.length, 2)
  assertEquals(payloads[0]?.environmentId, ENV_ID)
  assertEquals(payloads[0]?.ingressServices, [{ serviceId: 'svc-1' }])
  assertEquals(payloads[0]?.fabricNetworks, ['tpn_one'])
  // Second server carries no compose bridges — key omitted, not empty.
  assertEquals('fabricNetworks' in (payloads[1] ?? {}), false)
})

test('dispatchEnvironmentTeardown includes fabric-only servers', async () => {
  const captured = { payloads: [] as unknown[], transitions: [] as string[] }
  const queue = { enqueue: () => Promise.resolve() } as unknown as CommandQueue

  const servers = await dispatchEnvironmentTeardown(
    fakeCommandDb(captured),
    queue,
    [
      plan({
        serverIds: ['srv-a'],
        fabricNetworksByServer: new Map([['srv-remote', ['tpn_two']]]),
      }),
    ],
    'user-1',
  )
  assertEquals(servers, ['srv-a', 'srv-remote'])
})

test('dispatchEnvironmentTeardown compensates and keeps going when the queue rejects', async () => {
  const captured = { payloads: [] as unknown[], transitions: [] as string[] }
  const queue = {
    enqueue: (envelope: { serverId: string }) =>
      envelope.serverId === 'srv-a'
        ? Promise.reject(new Error('queue down'))
        : Promise.resolve(),
  } as unknown as CommandQueue

  const servers = await dispatchEnvironmentTeardown(
    fakeCommandDb(captured),
    queue,
    [plan({ serverIds: ['srv-a', 'srv-b'] })],
    'user-1',
  )

  assertEquals(servers, ['srv-b'])
  assertEquals(captured.transitions, ['failed'])
})

test('dispatchEnvironmentTeardown is a no-op without plans', async () => {
  const captured = { payloads: [] as unknown[], transitions: [] as string[] }
  const queue = { enqueue: () => Promise.resolve() } as unknown as CommandQueue
  assertEquals(
    await dispatchEnvironmentTeardown(fakeCommandDb(captured), queue, [], 'u'),
    [],
  )
  assertEquals(captured.payloads.length, 0)
})
