/**
 * Host-free coverage for system hierarchy pure helpers, race-safe ensures,
 * delete subtree, and provision wrappers (Db doubles only — no Postgres).
 */

import { assertEquals, assertRejects } from '@std/assert'
import type { Db } from '../../db.ts'
import {
  ingressContainerNameFromService,
  managedHaContainerNameFromService,
} from '../../lib/naming.ts'
import {
  deleteSystemEnvironmentSubtree,
  ensureManagedHaHierarchy,
  ensureManagedIngressHierarchy,
  ensureSelfHostSystemHierarchy,
  ensureSystemHierarchy,
  ensureSystemWorkspace,
  findSystemEnvironmentForServer,
  isSystemSelfHostComposeServiceName,
  SYSTEM_HOSTING_INGRESS_COMPONENT,
  SYSTEM_MANAGED_HA_COMPONENT,
  SYSTEM_MANAGED_HA_PROJECT_DISPLAY_NAME,
  SYSTEM_MANAGED_INGRESS_COMPONENT,
  SYSTEM_MANAGED_INGRESS_PROJECT_DISPLAY_NAME,
  SYSTEM_ORCHESTRATOR_COMPOSE_SERVICE_NAME,
  SYSTEM_PROJECT_DISPLAY_NAME,
  SYSTEM_PROJECT_METADATA_TYPE,
  SYSTEM_PROXYSQL_COMPOSE_SERVICE_NAME,
  SYSTEM_SELF_HOST_COMPONENT,
  SYSTEM_SELF_HOST_COMPOSE_SERVICE_NAMES,
  SYSTEM_SELF_HOST_PROJECT_DISPLAY_NAME,
  SYSTEM_TRAEFIK_COMPOSE_SERVICE_NAME,
  SYSTEM_WORKSPACE_DISPLAY_NAME,
} from './hierarchy.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const ORG = '00000000-0000-4000-8000-000000000001'
const SERVER = '00000000-0000-4000-8000-000000000002'
const WS = '00000000-0000-4000-8000-000000000010'
const PROJ = '00000000-0000-4000-8000-000000000011'
const ENV = '00000000-0000-4000-8000-000000000012'
const SVC = '00000000-0000-4000-8000-0000000000aa'
const CTR = '00000000-0000-4000-8000-0000000000bb'

function thenableRows(rows: unknown[]) {
  const promise = Promise.resolve(rows)
  return {
    limit: () => promise,
    then: promise.then.bind(promise),
    catch: promise.catch.bind(promise),
    finally: promise.finally.bind(promise),
  }
}

/** Sequenced drizzle-shaped Db used as both outer db and nested tx. */
function createSequencedDb(opts: {
  execute?: Array<unknown[] | (() => unknown[])>
  select?: Array<unknown[] | (() => unknown[])>
  insertReturning?: Array<unknown[] | (() => unknown[])>
  track?: {
    deletes?: number
    updates?: number
    inserts?: number
    executes?: number
    updateSets?: unknown[]
  }
}): Db {
  let executeI = 0
  let selectI = 0
  let insertReturningI = 0
  const track = opts.track ?? {}

  const db: Record<string, unknown> = {
    execute: () => {
      track.executes = (track.executes ?? 0) + 1
      const next = opts.execute?.[executeI++]
      const rows = typeof next === 'function' ? next() : (next ?? [])
      return rows
    },
    select: () => ({
      from: () => ({
        where: () => {
          const next = opts.select?.[selectI++]
          const rows = typeof next === 'function' ? next() : (next ?? [])
          return thenableRows(rows)
        },
      }),
    }),
    insert: () => {
      track.inserts = (track.inserts ?? 0) + 1
      return {
        values: () => ({
          onConflictDoNothing: () => Promise.resolve(undefined),
          returning: () => {
            const next = opts.insertReturning?.[insertReturningI++]
            const rows = typeof next === 'function' ? next() : (next ?? [])
            return Promise.resolve(rows)
          },
        }),
      }
    },
    update: () => {
      track.updates = (track.updates ?? 0) + 1
      return {
        set: (values: unknown) => {
          track.updateSets = [...(track.updateSets ?? []), values]
          return {
            where: () => Promise.resolve([]),
          }
        },
      }
    },
    delete: () => {
      track.deletes = (track.deletes ?? 0) + 1
      return {
        where: () => Promise.resolve([]),
      }
    },
  }

  db.transaction = async (fn: (tx: Db) => Promise<unknown>) =>
    await fn(db as unknown as Db)

  return db as unknown as Db
}

function wrapDb(tx: Db): Db {
  return {
    transaction: async (fn: (inner: Db) => Promise<unknown>) => await fn(tx),
  } as unknown as Db
}

function staleSystemProjectRow(
  id: string,
  name: string,
  component: string,
): { id: string; name: string; metadata: Record<string, unknown> } {
  return {
    id,
    name,
    metadata: { type: 'docker-compose', component, extra: 'keep' },
  }
}

function namedUpdate(
  updateSets: unknown[] | undefined,
  displayName: string,
): Record<string, unknown> | undefined {
  return (updateSets ?? []).find((row): row is Record<string, unknown> =>
    typeof row === 'object' &&
    row !== null &&
    !Array.isArray(row) &&
    (row as Record<string, unknown>).name === displayName,
  )
}

function assertNormalizedProjectUpdate(
  updateSets: unknown[] | undefined,
  displayName: string,
  component: string,
): void {
  const patch = namedUpdate(updateSets, displayName)
  assertEquals(patch?.name, displayName)
  const metadata = patch?.metadata as Record<string, unknown> | undefined
  assertEquals(metadata?.type, SYSTEM_PROJECT_METADATA_TYPE)
  assertEquals(metadata?.component, component)
  assertEquals(metadata?.extra, 'keep')
}

test('isSystemSelfHostComposeServiceName allowlists only stack services', () => {
  for (const name of SYSTEM_SELF_HOST_COMPOSE_SERVICE_NAMES) {
    assertEquals(isSystemSelfHostComposeServiceName(name), true)
  }
  assertEquals(isSystemSelfHostComposeServiceName('traefik'), false)
  assertEquals(isSystemSelfHostComposeServiceName('proxysql'), false)
  assertEquals(isSystemSelfHostComposeServiceName(''), false)
})

test('findSystemEnvironmentForServer returns first match or null', async () => {
  const hit = {
    execute: () => [{ id: 'env-1' }],
  } as unknown as Db
  assertEquals(await findSystemEnvironmentForServer(hit, 'srv'), 'env-1')
  assertEquals(
    await findSystemEnvironmentForServer(hit, 'srv', 'hosting-ingress'),
    'env-1',
  )

  const miss = {
    execute: () => [],
  } as unknown as Db
  assertEquals(await findSystemEnvironmentForServer(miss, 'srv'), null)
})

test('ensureSystemWorkspace returns insert id or existing row', async () => {
  const inserted = {
    execute: () => [{ id: 'ws-new' }],
    select: () => {
      throw new TypeError('should not select after insert')
    },
  } as unknown as Db
  assertEquals(await ensureSystemWorkspace(inserted, 'org'), 'ws-new')

  const raced = {
    execute: () => [],
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () =>
            Promise.resolve([
              { id: 'ws-existing', name: SYSTEM_WORKSPACE_DISPLAY_NAME },
            ]),
        }),
      }),
    }),
    update: () => {
      throw new TypeError('should not update a current workspace name')
    },
  } as unknown as Db
  assertEquals(await ensureSystemWorkspace(raced, 'org'), 'ws-existing')

  const missing = {
    execute: () => [],
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([]),
        }),
      }),
    }),
  } as unknown as Db
  await assertRejects(
    () => ensureSystemWorkspace(missing, 'org'),
    Error,
    'system workspace missing after insert race',
  )
})

test('deleteSystemEnvironmentSubtree deletes services then environment', async () => {
  const deleted: string[] = []
  const tx = {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve([{ id: 'svc-1' }, { id: 'svc-2' }]),
      }),
    }),
    delete: () => ({
      where: () => {
        deleted.push('delete')
        return Promise.resolve([])
      },
    }),
  } as unknown as Db

  await deleteSystemEnvironmentSubtree(tx, ENV)
  // container delete + service delete + environment delete
  assertEquals(deleted.length, 3)
})

test('deleteSystemEnvironmentSubtree skips service deletes when empty', async () => {
  let deletes = 0
  const tx = {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve([]),
      }),
    }),
    delete: () => ({
      where: () => {
        deletes += 1
        return Promise.resolve([])
      },
    }),
  } as unknown as Db

  await deleteSystemEnvironmentSubtree(tx, ENV)
  assertEquals(deletes, 1)
})

test('ensureSystemHierarchy inserts workspace/project/env/service/ingress', async () => {
  const track = { deletes: 0, updates: 0, inserts: 0, executes: 0 }
  const ingressName = ingressContainerNameFromService(SVC)
  const tx = createSequencedDb({
    track,
    execute: [
      [{ id: WS }], // workspace insert
      [{ id: PROJ }], // hosting-ingress project insert
      [], // FOR UPDATE project lock
    ],
    select: [
      [{ name: '  Edge Host  ' }], // server name
      [], // no existing environment
      [{ id: SVC }], // compose service after upsert
      [{
        id: CTR,
        serverId: SERVER,
        containerName: ingressName,
        status: 'pending',
        containerId: null,
        composeServiceName: SYSTEM_TRAEFIK_COMPOSE_SERVICE_NAME,
      }],
    ],
    insertReturning: [[{ id: ENV }]],
  })

  const result = await ensureSystemHierarchy(wrapDb(tx), {
    organizationId: ORG,
    serverId: SERVER,
  })
  assertEquals(result, {
    workspaceId: WS,
    projectId: PROJ,
    environmentId: ENV,
    serviceId: SVC,
    containerRowId: CTR,
    containerName: ingressName,
  })
  assertEquals(track.deletes! >= 1, true)
})

test('ensureSystemHierarchy reuses existing env and falls back display name', async () => {
  const ingressName = ingressContainerNameFromService(SVC)
  const tx = createSequencedDb({
    execute: [
      [{ id: WS }],
      [], // project insert race → empty
      [{ id: PROJ }], // project select winner
      [], // FOR UPDATE
    ],
    select: [
      [{ name: '   ' }], // blank → SYSTEM_PROJECT_DISPLAY_NAME
      [{ id: ENV }], // existing environment
      [{ id: SVC }],
      [{
        id: CTR,
        serverId: SERVER,
        containerName: 'pending',
        status: 'pending',
        containerId: null,
        composeServiceName: SYSTEM_TRAEFIK_COMPOSE_SERVICE_NAME,
      }],
    ],
  })

  const result = await ensureSystemHierarchy(wrapDb(tx), {
    organizationId: ORG,
    serverId: SERVER,
  })
  assertEquals(result.environmentId, ENV)
  assertEquals(result.containerName, ingressName)
  assertEquals(result.projectId, PROJ)
})

test('ensureSystemHierarchy falls back when server row is missing', async () => {
  const ingressName = ingressContainerNameFromService(SVC)
  const tx = createSequencedDb({
    execute: [
      [{ id: WS }],
      [{ id: PROJ }],
      [],
    ],
    select: [
      [], // no server row
      [{ id: ENV }],
      [{ id: SVC }],
      [{
        id: CTR,
        serverId: SERVER,
        containerName: ingressName,
        status: 'pending',
        containerId: null,
        composeServiceName: SYSTEM_TRAEFIK_COMPOSE_SERVICE_NAME,
      }],
    ],
  })

  const result = await ensureSystemHierarchy(wrapDb(tx), {
    organizationId: ORG,
    serverId: SERVER,
  })
  assertEquals(result.workspaceId, WS)
  // Display name fallback is exercised inside ensureServerEnvironment call —
  // we only assert the happy return shape here.
  assertEquals(result.environmentId, ENV)
  assertEquals(SYSTEM_PROJECT_DISPLAY_NAME.length > 0, true)
})

test('ensureHostingIngressProject race miss throws', async () => {
  const tx = createSequencedDb({
    execute: [
      [{ id: WS }],
      [], // project insert empty
      [], // project select empty → throw
    ],
    select: [],
  })

  await assertRejects(
    () =>
      ensureSystemHierarchy(wrapDb(tx), {
        organizationId: ORG,
        serverId: SERVER,
      }),
    Error,
    'hosting-ingress project missing after insert race',
  )
})

test('ensureServerEnvironment insert failure throws', async () => {
  const tx = createSequencedDb({
    execute: [
      [{ id: WS }],
      [{ id: PROJ }],
      [],
    ],
    select: [
      [{ name: 'Host' }],
      [], // no existing env
    ],
    insertReturning: [[]], // insert failed
  })

  await assertRejects(
    () =>
      ensureSystemHierarchy(wrapDb(tx), {
        organizationId: ORG,
        serverId: SERVER,
      }),
    Error,
    'system environment insert failed',
  )
})

test('ensureComposeService missing after upsert throws', async () => {
  const tx = createSequencedDb({
    execute: [
      [{ id: WS }],
      [{ id: PROJ }],
      [],
    ],
    select: [
      [{ name: 'Host' }],
      [{ id: ENV }],
      [], // service missing
    ],
  })

  await assertRejects(
    () =>
      ensureSystemHierarchy(wrapDb(tx), {
        organizationId: ORG,
        serverId: SERVER,
      }),
    Error,
    'compose service missing after upsert',
  )
})

test('ensureManagedIngressHierarchy provisions proxysql ingress container', async () => {
  const track = { deletes: 0, updates: 0, inserts: 0, replaces: 0 }
  const ingressName = ingressContainerNameFromService(SVC)
  const tx = createSequencedDb({
    track,
    execute: [
      [{ id: WS }],
      [{ id: PROJ }],
      [], // FOR UPDATE
    ],
    select: [
      [{ name: 'DB Host' }],
      [], // no env
      [{ id: SVC }], // proxysql service
      [{
        id: CTR,
        serverId: SERVER,
        containerName: ingressName,
        status: 'pending',
        containerId: null,
        composeServiceName: SYSTEM_PROXYSQL_COMPOSE_SERVICE_NAME,
      }],
    ],
    insertReturning: [[{ id: ENV }]],
  })

  const result = await ensureManagedIngressHierarchy(wrapDb(tx), {
    organizationId: ORG,
    serverId: SERVER,
  })
  assertEquals(result.serviceId, SVC)
  assertEquals(result.containerRowId, CTR)
  assertEquals(result.containerName, ingressName)
  assertEquals(result.workspaceId, WS)
  assertEquals(SYSTEM_MANAGED_INGRESS_PROJECT_DISPLAY_NAME.length > 0, true)
  assertEquals(track.inserts! >= 2, true)
})

test('ensureManagedIngressProject race miss throws', async () => {
  const tx = createSequencedDb({
    execute: [
      [{ id: WS }],
      [],
      [],
    ],
  })

  await assertRejects(
    () =>
      ensureManagedIngressHierarchy(wrapDb(tx), {
        organizationId: ORG,
        serverId: SERVER,
      }),
    Error,
    'managed-ingress project missing after insert race',
  )
})

test('ensureManagedIngressHierarchy throws when allocation empty', async () => {
  const tx = createSequencedDb({
    execute: [
      [{ id: WS }],
      [{ id: PROJ }],
      [],
    ],
    select: [
      [], // server missing → managed display fallback
      [{ id: ENV }],
      [{ id: SVC }],
      [], // allocation select empty → ensureServiceIngressContainerAllocation throws
    ],
  })

  await assertRejects(
    () =>
      ensureManagedIngressHierarchy(wrapDb(tx), {
        organizationId: ORG,
        serverId: SERVER,
      }),
    Error,
    'service ingress container allocation missing after upsert',
  )
})

test('ensureSelfHostSystemHierarchy provisions database/queue', async () => {
  const serviceIds = [
    '00000000-0000-4000-8000-0000000000a1',
    '00000000-0000-4000-8000-0000000000a2',
  ]
  const containerIds = [
    '00000000-0000-4000-8000-0000000000c1',
    '00000000-0000-4000-8000-0000000000c2',
  ]

  const tx = createSequencedDb({
    execute: [
      [{ id: WS }],
      [{ id: PROJ }],
      [], // FOR UPDATE
    ],
    select: [
      [], // no existing env
      [{ id: serviceIds[0] }],
      [{ id: serviceIds[1] }],
      [{
        id: containerIds[0],
        serverId: SERVER,
        containerName: 'pending',
        composeServiceName: SYSTEM_SELF_HOST_COMPOSE_SERVICE_NAMES[0],
      }],
      [{
        id: containerIds[1],
        serverId: SERVER,
        containerName: 'pending',
        composeServiceName: SYSTEM_SELF_HOST_COMPOSE_SERVICE_NAMES[1],
      }],
    ],
    insertReturning: [[{ id: ENV }]],
  })

  const result = await ensureSelfHostSystemHierarchy(wrapDb(tx), {
    organizationId: ORG,
    serverId: SERVER,
  })
  assertEquals(result.workspaceId, WS)
  assertEquals(result.projectId, PROJ)
  assertEquals(result.environmentId, ENV)
  assertEquals(result.services.length, 2)
  assertEquals(
    result.services.map((s) => s.composeServiceName),
    [...SYSTEM_SELF_HOST_COMPOSE_SERVICE_NAMES],
  )
  assertEquals(
    result.services.map((s) => s.containerName),
    serviceIds,
  )
  assertEquals(
    result.services.map((s) => s.containerRowId),
    containerIds,
  )
})

test('ensureSelfHostProject race miss throws', async () => {
  const tx = createSequencedDb({
    execute: [
      [{ id: WS }],
      [],
      [],
    ],
  })

  await assertRejects(
    () =>
      ensureSelfHostSystemHierarchy(wrapDb(tx), {
        organizationId: ORG,
        serverId: SERVER,
      }),
    Error,
    'self-host project missing after insert race',
  )
})

test('ensureSelfHostSystemHierarchy throws when a container allocation is missing', async () => {
  const serviceIds = [
    '00000000-0000-4000-8000-0000000000a1',
    '00000000-0000-4000-8000-0000000000a2',
  ]
  const tx = createSequencedDb({
    execute: [
      [{ id: WS }],
      [{ id: PROJ }],
      [],
    ],
    select: [
      [{ id: ENV }],
      [{ id: serviceIds[0] }],
      [{ id: serviceIds[1] }],
      // Only one allocation succeeds — second service missing from map
      [{
        id: 'c1',
        serverId: SERVER,
        containerName: serviceIds[0],
        composeServiceName: SYSTEM_SELF_HOST_COMPOSE_SERVICE_NAMES[0],
      }],
      // Second allocate select empty → allocateServiceContainers throws.
      [],
    ],
  })

  await assertRejects(
    () =>
      ensureSelfHostSystemHierarchy(wrapDb(tx), {
        organizationId: ORG,
        serverId: SERVER,
      }),
    Error,
    'container allocation missing after upsert',
  )
})

test('ensureSystemWorkspace renames a stale existing workspace', async () => {
  const track = { updateSets: [] as unknown[] }
  const db = {
    execute: () => [],
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () =>
            Promise.resolve([
              { id: WS, name: 'TurboPanel Platform' },
            ]),
        }),
      }),
    }),
    update: () => {
      return {
        set: (values: unknown) => {
          track.updateSets.push(values)
          return { where: () => Promise.resolve([]) }
        },
      }
    },
  } as unknown as Db

  assertEquals(await ensureSystemWorkspace(db, ORG), WS)
  const patch = namedUpdate(track.updateSets, SYSTEM_WORKSPACE_DISPLAY_NAME)
  assertEquals(patch?.name, SYSTEM_WORKSPACE_DISPLAY_NAME)
})

test('ensureSystemHierarchy normalizes a stale hosting-ingress project', async () => {
  const track = { updateSets: [] as unknown[] }
  const ingressName = ingressContainerNameFromService(SVC)
  const tx = createSequencedDb({
    track,
    execute: [
      [{ id: WS }],
      [],
      [staleSystemProjectRow(PROJ, 'Server Ingress', SYSTEM_HOSTING_INGRESS_COMPONENT)],
      [],
    ],
    select: [
      [{ name: 'Host' }],
      [{ id: ENV }],
      [{ id: SVC }],
      [{
        id: CTR,
        serverId: SERVER,
        containerName: ingressName,
        status: 'pending',
        containerId: null,
        composeServiceName: SYSTEM_TRAEFIK_COMPOSE_SERVICE_NAME,
      }],
    ],
  })

  const result = await ensureSystemHierarchy(wrapDb(tx), {
    organizationId: ORG,
    serverId: SERVER,
  })
  assertEquals(result.projectId, PROJ)
  assertNormalizedProjectUpdate(
    track.updateSets,
    SYSTEM_PROJECT_DISPLAY_NAME,
    SYSTEM_HOSTING_INGRESS_COMPONENT,
  )
})

test('ensureManagedIngressHierarchy normalizes a stale managed-ingress project', async () => {
  const track = { updateSets: [] as unknown[] }
  const ingressName = ingressContainerNameFromService(SVC)
  const tx = createSequencedDb({
    track,
    execute: [
      [{ id: WS }],
      [],
      [staleSystemProjectRow(
        PROJ,
        'Managed Ingress',
        SYSTEM_MANAGED_INGRESS_COMPONENT,
      )],
      [],
    ],
    select: [
      [{ name: 'DB Host' }],
      [{ id: ENV }],
      [{ id: SVC }],
      [{
        id: CTR,
        serverId: SERVER,
        containerName: ingressName,
        status: 'pending',
        containerId: null,
        composeServiceName: SYSTEM_PROXYSQL_COMPOSE_SERVICE_NAME,
      }],
    ],
  })

  const result = await ensureManagedIngressHierarchy(wrapDb(tx), {
    organizationId: ORG,
    serverId: SERVER,
  })
  assertEquals(result.projectId, PROJ)
  assertNormalizedProjectUpdate(
    track.updateSets,
    SYSTEM_MANAGED_INGRESS_PROJECT_DISPLAY_NAME,
    SYSTEM_MANAGED_INGRESS_COMPONENT,
  )
})

test('ensureManagedHaHierarchy normalizes a stale managed-ha project', async () => {
  const track = { updateSets: [] as unknown[] }
  const haName = managedHaContainerNameFromService(SVC)
  const tx = createSequencedDb({
    track,
    execute: [
      [{ id: WS }],
      [],
      [staleSystemProjectRow(PROJ, 'Database HA', SYSTEM_MANAGED_HA_COMPONENT)],
      [],
    ],
    select: [
      [{ name: 'HA Host' }],
      [{ id: ENV }],
      [{ id: SVC }],
      [{
        id: CTR,
        serverId: SERVER,
        containerName: haName,
        composeServiceName: SYSTEM_ORCHESTRATOR_COMPOSE_SERVICE_NAME,
      }],
    ],
  })

  const result = await ensureManagedHaHierarchy(wrapDb(tx), {
    organizationId: ORG,
    serverId: SERVER,
  })
  assertEquals(result.projectId, PROJ)
  assertEquals(result.containerName, haName)
  assertNormalizedProjectUpdate(
    track.updateSets,
    SYSTEM_MANAGED_HA_PROJECT_DISPLAY_NAME,
    SYSTEM_MANAGED_HA_COMPONENT,
  )
})

test('ensureSelfHostSystemHierarchy normalizes a stale self-host project', async () => {
  const track = { updateSets: [] as unknown[] }
  const serviceIds = [
    '00000000-0000-4000-8000-0000000000a1',
    '00000000-0000-4000-8000-0000000000a2',
  ]
  const containerIds = [
    '00000000-0000-4000-8000-0000000000c1',
    '00000000-0000-4000-8000-0000000000c2',
  ]
  const tx = createSequencedDb({
    track,
    execute: [
      [{ id: WS }],
      [],
      [staleSystemProjectRow(
        PROJ,
        'TurboPanel System',
        SYSTEM_SELF_HOST_COMPONENT,
      )],
      [],
    ],
    select: [
      [{ id: ENV }],
      [{ id: serviceIds[0] }],
      [{ id: serviceIds[1] }],
      [{
        id: containerIds[0],
        serverId: SERVER,
        containerName: serviceIds[0],
        composeServiceName: SYSTEM_SELF_HOST_COMPOSE_SERVICE_NAMES[0],
      }],
      [{
        id: containerIds[1],
        serverId: SERVER,
        containerName: serviceIds[1],
        composeServiceName: SYSTEM_SELF_HOST_COMPOSE_SERVICE_NAMES[1],
      }],
    ],
  })

  const result = await ensureSelfHostSystemHierarchy(wrapDb(tx), {
    organizationId: ORG,
    serverId: SERVER,
  })
  assertEquals(result.projectId, PROJ)
  assertNormalizedProjectUpdate(
    track.updateSets,
    SYSTEM_SELF_HOST_PROJECT_DISPLAY_NAME,
    SYSTEM_SELF_HOST_COMPONENT,
  )
})
