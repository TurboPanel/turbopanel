import { assertEquals } from '@std/assert'
import type { Context } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import type { Db } from '../../db/connection.ts'
import type { CommandQueue } from '../commands/queue.ts'
import { deriveEncryptionSecretsConfig } from '../../lib/secrets/secrets.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import { postgresEngineSpec } from '../managed/postgres.ts'
import {
  BINDING_INGRESS_RECONCILE_PENDING_WARNING,
  BINDING_PRIVATE_LISTENER_PENDING_WARNING,
  bindingListenerEnqueueDeps,
  type BindingListenerEnqueueDeps,
  bindingListenerSyncWarning,
  enqueueIngressForBindingChange,
  planBindingChangeCommands,
} from './enqueue-change.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('create or remove of a remote consumer plans apply before ingress', () => {
  const plan = planBindingChangeCommands({
    memberServerIds: ['srv-db'],
    remainingConsumerServerIds: ['srv-app'],
    affectedConsumerServerIds: ['srv-app'],
    ingressServerIds: ['srv-app', 'srv-db'],
    apply: true,
  })
  assertEquals(plan.apply, true)
  assertEquals(plan.ingressServerIds, ['srv-app', 'srv-db'])
})

test('keyPrefix-only PATCH does not plan apply', () => {
  const plan = planBindingChangeCommands({
    memberServerIds: ['srv-db'],
    remainingConsumerServerIds: ['srv-app'],
    affectedConsumerServerIds: ['srv-app'],
    ingressServerIds: ['srv-app', 'srv-db'],
    apply: false,
  })
  assertEquals(plan.apply, false)
  assertEquals(plan.ingressServerIds.includes('srv-app'), true)
})

test('slot-only remote host counts for apply', () => {
  const plan = planBindingChangeCommands({
    memberServerIds: ['srv-db'],
    remainingConsumerServerIds: [],
    affectedConsumerServerIds: ['srv-slot'],
    ingressServerIds: ['srv-slot', 'srv-db'],
    apply: true,
  })
  assertEquals(plan.apply, true)
})

test('last remote binding removed still plans apply so the listener can come down', () => {
  const plan = planBindingChangeCommands({
    memberServerIds: ['srv-db'],
    remainingConsumerServerIds: ['srv-db'],
    affectedConsumerServerIds: ['srv-app'],
    ingressServerIds: ['srv-app', 'srv-db'],
    apply: true,
  })
  assertEquals(plan.apply, true)
})

test('bindingListenerSyncWarning is set only when apply was required but did not enqueue', () => {
  assertEquals(bindingListenerSyncWarning({ apply: false }, 'failed'), undefined)
  assertEquals(bindingListenerSyncWarning({ apply: true }, 'enqueued'), undefined)
  assertEquals(
    bindingListenerSyncWarning({ apply: true }, 'failed'),
    BINDING_PRIVATE_LISTENER_PENDING_WARNING
  )
  assertEquals(
    bindingListenerSyncWarning({ apply: true }, 'skipped'),
    BINDING_PRIVATE_LISTENER_PENDING_WARNING
  )
})

test('remote binding change defers ingress when managed.apply does not enqueue', () => {
  const plan = planBindingChangeCommands({
    memberServerIds: ['srv-db'],
    remainingConsumerServerIds: ['srv-app'],
    affectedConsumerServerIds: ['srv-app'],
    ingressServerIds: ['srv-app', 'srv-db'],
    apply: true,
  })
  assertEquals(bindingListenerSyncWarning(plan, 'enqueued'), undefined)
  assertEquals(bindingListenerSyncWarning(plan, 'failed'), BINDING_PRIVATE_LISTENER_PENDING_WARNING)
})

test('co-resident consumer does not plan apply', () => {
  const plan = planBindingChangeCommands({
    memberServerIds: ['srv-db'],
    remainingConsumerServerIds: ['srv-db'],
    affectedConsumerServerIds: ['srv-db'],
    ingressServerIds: ['srv-db'],
    apply: true,
  })
  assertEquals(plan.apply, false)
})

const MANAGED_ID = '00000000-0000-4000-8000-000000000001'
const ORG_ID = '00000000-0000-4000-8000-000000000002'
const ACTOR_ID = '00000000-0000-4000-8000-000000000003'
const SERVICE_ID = '00000000-0000-4000-8000-000000000004'
const DB_SERVER_ID = '00000000-0000-4000-8000-000000000010'
const APP_SERVER_ID = '00000000-0000-4000-8000-000000000011'

function managedRowDb(): Db {
  const settings = postgresEngineSpec.defaultSettings
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () =>
            Promise.resolve([
              {
                id: MANAGED_ID,
                environmentId: '00000000-0000-4000-8000-000000000099',
                serverId: DB_SERVER_ID,
                engine: 'postgres',
                metadata: {},
                options: { settings, databases: ['postgres'] },
              },
            ]),
        }),
      }),
    }),
  } as unknown as Db
}

async function bindingEnqueueContext(commandQueue: CommandQueue): Promise<Context<AppEnv>> {
  const secretsConfig = parseTestSecretsConfig('deno')
  const dataEncryptionSecrets = await deriveEncryptionSecretsConfig(
    secretsConfig,
    'data-encryption'
  )
  return {
    get(key: string) {
      if (key === 'secretsConfig') return secretsConfig
      if (key === 'dataEncryptionSecrets') return dataEncryptionSecrets
      if (key === 'commandQueue') return commandQueue
      return undefined
    },
  } as unknown as Context<AppEnv>
}

test('enqueueIngressForBindingChange warns and skips ingress when managed.apply does not enqueue', async () => {
  const ingressCalls: string[] = []
  const queue: CommandQueue = { enqueue: () => Promise.resolve() }
  const deps: BindingListenerEnqueueDeps = {
    ...bindingListenerEnqueueDeps,
    loadServiceConsumerServerIds: () => Promise.resolve([APP_SERVER_ID]),
    memberServerIdsForManaged: () => Promise.resolve([DB_SERVER_ID]),
    consumerServerIdsForManaged: () => Promise.resolve([APP_SERVER_ID]),
    prepareManagedApplyPayloads: () =>
      Promise.resolve({ kind: 'daemon_key_unavailable', serverId: DB_SERVER_ID }),
    enqueueManagedIngressReconcile: async (_db, _queue, params) => {
      ingressCalls.push(params.serverId)
      return { ok: true, commandId: 'cmd-ingress', serverId: params.serverId }
    },
  }
  const c = await bindingEnqueueContext(queue)
  const outcome = await enqueueIngressForBindingChange(
    c,
    managedRowDb(),
    {
      serviceIds: [SERVICE_ID],
      managedId: MANAGED_ID,
      actorId: ACTOR_ID,
      organizationId: ORG_ID,
    },
    deps
  )
  assertEquals(outcome.warning, BINDING_PRIVATE_LISTENER_PENDING_WARNING)
  assertEquals(ingressCalls.length, 0)
})

test('enqueueIngressForBindingChange enqueues ingress after managed.apply succeeds', async () => {
  const ingressCalls: string[] = []
  const queue: CommandQueue = { enqueue: () => Promise.resolve() }
  const memberId = '00000000-0000-4000-8000-000000000020'
  const deps: BindingListenerEnqueueDeps = {
    ...bindingListenerEnqueueDeps,
    loadServiceConsumerServerIds: () => Promise.resolve([APP_SERVER_ID]),
    memberServerIdsForManaged: () => Promise.resolve([DB_SERVER_ID]),
    consumerServerIdsForManaged: () => Promise.resolve([APP_SERVER_ID]),
    prepareManagedApplyPayloads: () =>
      Promise.resolve({
        members: [{ memberId, serverId: DB_SERVER_ID, payload: { managedId: MANAGED_ID } }],
      } as Awaited<ReturnType<typeof bindingListenerEnqueueDeps.prepareManagedApplyPayloads>>),
    enqueuePreparedManagedApply: () =>
      Promise.resolve([
        {
          memberId,
          serverId: DB_SERVER_ID,
          commandId: '00000000-0000-4000-8000-000000000077',
          status: 'queued' as const,
        },
      ]),
    enqueueManagedIngressReconcile: async (_db, _queue, params) => {
      ingressCalls.push(params.serverId)
      return { ok: true, commandId: 'cmd-ingress', serverId: params.serverId }
    },
  }
  const c = await bindingEnqueueContext(queue)
  const outcome = await enqueueIngressForBindingChange(
    c,
    managedRowDb(),
    {
      serviceIds: [SERVICE_ID],
      managedId: MANAGED_ID,
      actorId: ACTOR_ID,
      organizationId: ORG_ID,
    },
    deps
  )
  assertEquals(outcome.warning, undefined)
  assertEquals(
    ingressCalls.toSorted((a, b) => a.localeCompare(b)),
    [APP_SERVER_ID, DB_SERVER_ID].toSorted((a, b) => a.localeCompare(b))
  )
})

test('enqueueIngressForBindingChange warns when ingress reconcile fails after apply', async () => {
  const queue: CommandQueue = { enqueue: () => Promise.resolve() }
  const memberId = '00000000-0000-4000-8000-000000000020'
  const deps: BindingListenerEnqueueDeps = {
    ...bindingListenerEnqueueDeps,
    loadServiceConsumerServerIds: () => Promise.resolve([APP_SERVER_ID]),
    memberServerIdsForManaged: () => Promise.resolve([DB_SERVER_ID]),
    consumerServerIdsForManaged: () => Promise.resolve([APP_SERVER_ID]),
    prepareManagedApplyPayloads: () =>
      Promise.resolve({
        members: [{ memberId, serverId: DB_SERVER_ID, payload: { managedId: MANAGED_ID } }],
      } as Awaited<ReturnType<typeof bindingListenerEnqueueDeps.prepareManagedApplyPayloads>>),
    enqueuePreparedManagedApply: () =>
      Promise.resolve([
        {
          memberId,
          serverId: DB_SERVER_ID,
          commandId: '00000000-0000-4000-8000-000000000077',
          status: 'queued' as const,
        },
      ]),
    enqueueManagedIngressReconcile: () => Promise.reject(new Error('queue down')),
  }
  const c = await bindingEnqueueContext(queue)
  const outcome = await enqueueIngressForBindingChange(
    c,
    managedRowDb(),
    {
      serviceIds: [SERVICE_ID],
      managedId: MANAGED_ID,
      actorId: ACTOR_ID,
      organizationId: ORG_ID,
    },
    deps
  )
  assertEquals(outcome.warning, BINDING_INGRESS_RECONCILE_PENDING_WARNING)
})
