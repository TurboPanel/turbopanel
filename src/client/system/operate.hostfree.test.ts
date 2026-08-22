/**
 * Host-free coverage for system-component operate dispatch (Db doubles only).
 */

import { assertEquals } from '@std/assert'
import type { Db } from '../../db.ts'
import type { CommandEnvelope } from '../../lib/commands/envelope.ts'
import type { CommandQueue } from '../../lib/commands/queue.ts'
import {
  SYSTEM_HOSTING_INGRESS_COMPONENT,
  SYSTEM_TRAEFIK_COMPOSE_SERVICE_NAME,
} from './hierarchy.ts'
import { systemComponentOperations } from './operate.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const SERVER = '00000000-0000-4000-8000-000000000002'
const ENV = '00000000-0000-4000-8000-000000000020'
const SVC = '00000000-0000-4000-8000-0000000000aa'
const ACTOR = '00000000-0000-4000-8000-000000000099'

function createRecordingQueue(): CommandQueue & { envelopes: CommandEnvelope[] } {
  const envelopes: CommandEnvelope[] = []
  return {
    envelopes,
    enqueue: async (envelope) => {
      envelopes.push(envelope)
    },
  }
}

test('systemComponentOperations.restart maps not_provisioned', async () => {
  const db = {
    execute: async () => [],
  } as unknown as Db
  const result = await systemComponentOperations.restart({
    serverId: SERVER,
    environmentId: ENV,
    component: SYSTEM_HOSTING_INGRESS_COMPONENT,
    actorId: ACTOR,
    db,
    commandQueue: createRecordingQueue(),
  })
  assertEquals(result, { ok: false, reason: 'not_provisioned' })
})

test('systemComponentOperations.restart maps enqueue failure to transport_unavailable', async () => {
  const db = {
    execute: async () => [
      {
        environment_id: ENV,
        project_component: SYSTEM_HOSTING_INGRESS_COMPONENT,
        service_id: SVC,
        name: SYSTEM_TRAEFIK_COMPOSE_SERVICE_NAME,
        server_options: { hosting: { enabled: true } },
        has_http_ingress_demand: true,
        has_managed_members: false,
        ingress_container_id: 'cid',
        ingress_status: 'running',
      },
    ],
    // createCommandRecord writes command + dispatch in one transaction.
    transaction(fn: (tx: unknown) => Promise<unknown>) {
      return fn(this)
    },
    insert: () => ({
      values: (values: Record<string, unknown>) => ({
        returning: () =>
          Promise.resolve([
            {
              id: 'cmd-1',
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
                id: 'cmd-1',
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

  const result = await systemComponentOperations.restart({
    serverId: SERVER,
    environmentId: ENV,
    component: SYSTEM_HOSTING_INGRESS_COMPONENT,
    actorId: ACTOR,
    db,
    commandQueue: {
      enqueue: async () => {
        throw new TypeError('queue unavailable')
      },
    },
  })
  assertEquals(result, { ok: false, reason: 'transport_unavailable' })
})

test('systemComponentOperations.restart returns commandId on success', async () => {
  const db = {
    execute: async () => [
      {
        environment_id: ENV,
        project_component: SYSTEM_HOSTING_INGRESS_COMPONENT,
        service_id: SVC,
        name: SYSTEM_TRAEFIK_COMPOSE_SERVICE_NAME,
        server_options: { hosting: { enabled: true } },
        has_http_ingress_demand: true,
        has_managed_members: false,
        ingress_container_id: 'cid',
        ingress_status: 'running',
      },
    ],
    // createCommandRecord writes command + dispatch in one transaction.
    transaction(fn: (tx: unknown) => Promise<unknown>) {
      return fn(this)
    },
    insert: () => ({
      values: (values: Record<string, unknown>) => ({
        returning: () =>
          Promise.resolve([
            {
              id: 'cmd-ok',
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
  } as unknown as Db

  const queue = createRecordingQueue()
  const result = await systemComponentOperations.restart({
    serverId: SERVER,
    environmentId: ENV,
    component: SYSTEM_HOSTING_INGRESS_COMPONENT,
    actorId: ACTOR,
    db,
    commandQueue: queue,
  })
  assertEquals(result, {
    ok: true,
    commandId: 'cmd-ok',
    serverId: SERVER,
  })
  assertEquals(queue.envelopes.length, 1)
})
