import { assertEquals, assertRejects } from 'jsr:@std/assert'
import type { Db } from '../../db.ts'
import { managedContainerName } from '../../lib/naming.ts'
import {
  ensureManagedContainerAllocation,
  ensureManagedIngressContainerAllocation,
} from './allocate-managed-container.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

type MemService = {
  id: string
  environmentId: string
  name: string
}

type MemContainer = {
  id: string
  serviceId: string
  serverId: string
  containerId: string | null
  containerName: string
  status: string
  role: string
  composeServiceName: string
  ordinal: number
}

function thenableRows<T>(rows: T[]) {
  const promise = Promise.resolve(rows)
  return {
    limit: () => promise,
    then: promise.then.bind(promise),
    catch: promise.catch.bind(promise),
    finally: promise.finally.bind(promise),
  }
}

function thenableVoid() {
  const promise = Promise.resolve(undefined)
  return {
    onConflictDoNothing: () => promise,
    then: promise.then.bind(promise),
    catch: promise.catch.bind(promise),
    finally: promise.finally.bind(promise),
  }
}

type AllocationDbHandle = {
  db: Db
  services: MemService[]
  containers: MemContainer[]
  updates: Array<{ id: string; patch: Record<string, unknown> }>
  deletedContainerIds: string[]
}

function createManagedAllocationDb(opts?: {
  services?: MemService[]
  containers?: MemContainer[]
  omitServiceAfterInsert?: boolean
  omitContainerAfterInsert?: boolean
}): AllocationDbHandle {
  const services = [...(opts?.services ?? [])]
  const containers = [...(opts?.containers ?? [])]
  let nextServiceNum = services.length + 1
  let nextContainerNum = containers.length + 1
  let selectCalls = 0
  let lastServiceId: string | null = null
  const updates: Array<{ id: string; patch: Record<string, unknown> }> = []
  const deletedContainerIds: string[] = []

  const upsertService = (values: Record<string, unknown>) => {
    const environmentId = values.environmentId as string
    const name = values.name as string
    const existing = services.find(
      (row) =>
        row.environmentId === environmentId &&
        row.name === name,
    )
    if (existing) {
      lastServiceId = existing.id
      return
    }
    const id = `svc-${nextServiceNum++}`
    services.push({
      id,
      environmentId,
      name,
    })
    lastServiceId = id
  }

  const upsertContainer = (values: Record<string, unknown>) => {
    const serviceId = values.serviceId as string
    const role = values.role as string
    const ordinal = values.ordinal as number
    const existing = containers.find(
      (row) =>
        row.serviceId === serviceId &&
        row.role === role &&
        row.ordinal === ordinal,
    )
    if (existing) return
    containers.push({
      id: `ctr-${nextContainerNum++}`,
      serviceId,
      serverId: values.serverId as string,
      containerId: (values.containerId as string | null) ?? null,
      containerName: values.containerName as string,
      status: values.status as string,
      role,
      composeServiceName: values.composeServiceName as string,
      ordinal,
    })
  }

  const selectService = () => {
    if (opts?.omitServiceAfterInsert) return []
    if (!lastServiceId) return []
    const row = services.find((entry) => entry.id === lastServiceId)
    return row ? [{ id: row.id }] : []
  }

  const selectContainer = () => {
    if (opts?.omitContainerAfterInsert) return []
    if (!lastServiceId) return []
    const row = containers.find(
      (entry) =>
        entry.serviceId === lastServiceId &&
        entry.role === 'service' &&
        entry.ordinal === 1,
    )
    if (!row) return []
    return [{
      id: row.id,
      serverId: row.serverId,
      containerName: row.containerName,
      status: row.status,
      containerId: row.containerId,
      composeServiceName: row.composeServiceName,
    }]
  }

  const db = {
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        if ('environmentId' in values) {
          upsertService(values)
        } else {
          upsertContainer(values)
        }
        return thenableVoid()
      },
    }),
    select: () => ({
      from: () => ({
        where: () => {
          selectCalls += 1
          if (selectCalls % 2 === 1) {
            return thenableRows(selectService())
          }
          return thenableRows(selectContainer())
        },
      }),
    }),
    update: () => ({
      set: (patch: Record<string, unknown>) => ({
        where: () => {
          const row = containers.find(
            (entry) =>
              entry.serviceId === lastServiceId &&
              entry.role === 'service' &&
              entry.ordinal === 1,
          )
          if (row) {
            updates.push({ id: row.id, patch })
            Object.assign(row, patch)
          }
          return thenableVoid()
        },
      }),
    }),
    delete: () => ({
      where: () => {
        const keepId = containers.find(
          (entry) =>
            entry.serviceId === lastServiceId &&
            entry.role === 'service' &&
            entry.ordinal === 1,
        )?.id
        for (const row of [...containers]) {
          if (
            row.serviceId === lastServiceId &&
            row.role === 'service' &&
            row.containerId === null &&
            row.status === 'pending' &&
            row.id !== keepId
          ) {
            deletedContainerIds.push(row.id)
            containers.splice(containers.indexOf(row), 1)
          }
        }
        return thenableVoid()
      },
    }),
  } as unknown as Db

  return { db, services, containers, updates, deletedContainerIds }
}

type IngressDbHandle = {
  db: Db
  containers: MemContainer[]
  updates: Array<{ id: string; patch: Record<string, unknown> }>
  deletedContainerIds: string[]
}

function createIngressAllocationDb(opts?: {
  containers?: MemContainer[]
  omitContainerAfterInsert?: boolean
}): IngressDbHandle {
  const containers = [...(opts?.containers ?? [])]
  let nextContainerNum = containers.length + 1
  let activeServiceId: string | null = null
  const updates: Array<{ id: string; patch: Record<string, unknown> }> = []
  const deletedContainerIds: string[] = []

  const upsertContainer = (values: Record<string, unknown>) => {
    activeServiceId = values.serviceId as string
    const serviceId = values.serviceId as string
    const role = values.role as string
    const ordinal = values.ordinal as number
    const existing = containers.find(
      (row) =>
        row.serviceId === serviceId &&
        row.role === role &&
        row.ordinal === ordinal,
    )
    if (existing) return
    containers.push({
      id: `ing-${nextContainerNum++}`,
      serviceId,
      serverId: values.serverId as string,
      containerId: (values.containerId as null) ?? null,
      containerName: values.containerName as string,
      status: values.status as string,
      role,
      composeServiceName: values.composeServiceName as string,
      ordinal,
    })
  }

  const selectContainer = () => {
    if (opts?.omitContainerAfterInsert || !activeServiceId) return []
    const row = containers.find(
      (entry) =>
        entry.serviceId === activeServiceId &&
        entry.role === 'ingress' &&
        entry.ordinal === 1,
    )
    if (!row) return []
    return [{
      id: row.id,
      serverId: row.serverId,
      containerName: row.containerName,
      status: row.status,
      containerId: row.containerId,
      composeServiceName: row.composeServiceName,
    }]
  }

  const db = {
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        upsertContainer(values)
        return thenableVoid()
      },
    }),
    select: () => ({
      from: () => ({
        where: () => thenableRows(selectContainer()),
      }),
    }),
    update: () => ({
      set: (patch: Record<string, unknown>) => ({
        where: () => {
          const row = containers.find(
            (entry) =>
              entry.serviceId === activeServiceId &&
              entry.role === 'ingress' &&
              entry.ordinal === 1,
          )
          if (row) {
            updates.push({ id: row.id, patch })
            Object.assign(row, patch)
          }
          return thenableVoid()
        },
      }),
    }),
    delete: () => ({
      where: () => {
        const keepId = containers.find(
          (entry) =>
            entry.serviceId === activeServiceId &&
            entry.role === 'ingress' &&
            entry.ordinal === 1,
        )?.id
        for (const row of [...containers]) {
          if (
            row.serviceId === activeServiceId &&
            row.role === 'ingress' &&
            row.containerId === null &&
            row.status === 'pending' &&
            row.id !== keepId
          ) {
            deletedContainerIds.push(row.id)
            containers.splice(containers.indexOf(row), 1)
          }
        }
        return thenableVoid()
      },
    }),
  } as unknown as Db

  return { db, containers, updates, deletedContainerIds }
}

test('ensureManagedContainerAllocation creates service + pending ordinal-1 container', async () => {
  const { db, services, containers } = createManagedAllocationDb()
  const allocation = await ensureManagedContainerAllocation(db, {
    environmentId: 'env-1',
    serverId: 'srv-1',
    composeServiceName: 'postgres',
  })

  assertEquals(services.length, 1)
  assertEquals(services[0]!.name, 'postgres')
  assertEquals(containers.length, 1)
  assertEquals(containers[0]!.role, 'service')
  assertEquals(containers[0]!.ordinal, 1)
  assertEquals(allocation.serviceId, services[0]!.id)
  assertEquals(allocation.containerRowId, containers[0]!.id)
  assertEquals(allocation.containerName, managedContainerName(services[0]!.id))
})

test('ensureManagedContainerAllocation is idempotent on stub db', async () => {
  const { db, services, containers } = createManagedAllocationDb()
  const first = await ensureManagedContainerAllocation(db, {
    environmentId: 'env-1',
    serverId: 'srv-1',
    composeServiceName: 'postgres',
  })
  const second = await ensureManagedContainerAllocation(db, {
    environmentId: 'env-1',
    serverId: 'srv-1',
    composeServiceName: 'postgres',
  })

  assertEquals(second.serviceId, first.serviceId)
  assertEquals(second.containerRowId, first.containerRowId)
  assertEquals(services.length, 1)
  assertEquals(containers.length, 1)
})

test('ensureManagedContainerAllocation re-homes null-id row to pending on new server', async () => {
  const serviceId = 'svc-existing'
  const { db, containers, updates } = createManagedAllocationDb({
    services: [{
      id: serviceId,
      environmentId: 'env-1',
      name: 'postgres',
    }],
    containers: [{
      id: 'ctr-old',
      serviceId,
      serverId: 'srv-old',
      containerId: null,
      containerName: 'pending',
      status: 'exited',
      role: 'service',
      composeServiceName: 'postgres',
      ordinal: 1,
    }],
  })

  const allocation = await ensureManagedContainerAllocation(db, {
    environmentId: 'env-1',
    serverId: 'srv-new',
    composeServiceName: 'postgres',
  })

  assertEquals(allocation.containerRowId, 'ctr-old')
  assertEquals(allocation.containerName, managedContainerName(serviceId))
  assertEquals(containers[0]!.serverId, 'srv-new')
  assertEquals(containers[0]!.status, 'pending')
  assertEquals(containers[0]!.containerName, managedContainerName(serviceId))
  assertEquals(updates.length, 1)
  assertEquals(updates[0]!.patch.status, 'pending')
})

test('ensureManagedContainerAllocation skips update when null-id row already matches', async () => {
  const serviceId = 'svc-ready'
  const nextName = managedContainerName(serviceId)
  const { db, updates } = createManagedAllocationDb({
    services: [{
      id: serviceId,
      environmentId: 'env-1',
      name: 'postgres',
    }],
    containers: [{
      id: 'ctr-ready',
      serviceId,
      serverId: 'srv-1',
      containerId: null,
      containerName: nextName,
      status: 'pending',
      role: 'service',
      composeServiceName: 'postgres',
      ordinal: 1,
    }],
  })

  await ensureManagedContainerAllocation(db, {
    environmentId: 'env-1',
    serverId: 'srv-1',
    composeServiceName: 'postgres',
  })

  assertEquals(updates.length, 0)
})

test('ensureManagedContainerAllocation renames running row without clearing containerId', async () => {
  const serviceId = 'svc-live'
  const { db, containers, updates } = createManagedAllocationDb({
    services: [{
      id: serviceId,
      environmentId: 'env-1',
      name: 'postgres',
    }],
    containers: [{
      id: 'ctr-live',
      serviceId,
      serverId: 'srv-1',
      containerId: 'docker-abc',
      containerName: 'stale-name',
      status: 'running',
      role: 'service',
      composeServiceName: 'postgres',
      ordinal: 1,
    }],
  })

  const allocation = await ensureManagedContainerAllocation(db, {
    environmentId: 'env-1',
    serverId: 'srv-1',
    composeServiceName: 'postgres',
  })

  assertEquals(allocation.containerName, managedContainerName(serviceId))
  assertEquals(containers[0]!.containerId, 'docker-abc')
  assertEquals(containers[0]!.status, 'running')
  assertEquals(updates.length, 1)
  assertEquals(updates[0]!.patch.containerName, managedContainerName(serviceId))
  assertEquals(updates[0]!.patch.role, 'service')
  assertEquals('status' in updates[0]!.patch, false)
})

test('ensureManagedContainerAllocation prunes stray pending service rows', async () => {
  const serviceId = 'svc-prune'
  const { db, containers, deletedContainerIds } = createManagedAllocationDb({
    services: [{
      id: serviceId,
      environmentId: 'env-1',
      name: 'postgres',
    }],
    containers: [
      {
        id: 'ctr-keep',
        serviceId,
        serverId: 'srv-1',
        containerId: null,
        containerName: managedContainerName(serviceId),
        status: 'pending',
        role: 'service',
        composeServiceName: 'postgres',
        ordinal: 1,
      },
      {
        id: 'ctr-stray',
        serviceId,
        serverId: 'srv-old',
        containerId: null,
        containerName: 'pending',
        status: 'pending',
        role: 'service',
        composeServiceName: 'postgres',
        ordinal: 1,
      },
    ],
  })

  await ensureManagedContainerAllocation(db, {
    environmentId: 'env-1',
    serverId: 'srv-1',
    composeServiceName: 'postgres',
  })

  assertEquals(deletedContainerIds, ['ctr-stray'])
  assertEquals(containers.map((row) => row.id), ['ctr-keep'])
})

test('ensureManagedContainerAllocation throws when service row missing after upsert', async () => {
  const { db } = createManagedAllocationDb({ omitServiceAfterInsert: true })
  await assertRejects(
    () =>
      ensureManagedContainerAllocation(db, {
        environmentId: 'env-1',
        serverId: 'srv-1',
        composeServiceName: 'postgres',
      }),
    Error,
    'managed service allocation missing after upsert',
  )
})

test('ensureManagedContainerAllocation throws when container row missing after upsert', async () => {
  const { db } = createManagedAllocationDb({ omitContainerAfterInsert: true })
  await assertRejects(
    () =>
      ensureManagedContainerAllocation(db, {
        environmentId: 'env-1',
        serverId: 'srv-1',
        composeServiceName: 'postgres',
      }),
    Error,
    'managed container allocation missing after upsert',
  )
})

test('ensureManagedIngressContainerAllocation maps ingress allocation shape', async () => {
  const serviceId = 'svc-ing'
  const { db } = createIngressAllocationDb()
  const allocation = await ensureManagedIngressContainerAllocation(db, {
    serviceId,
    serverId: 'srv-1',
    composeServiceName: 'postgres-ingress',
  })

  assertEquals(allocation.serviceId, serviceId)
  assertEquals(allocation.containerName, `${serviceId}-in`)
  if (!allocation.containerRowId.startsWith('ing-')) {
    throw new TypeError('expected ingress container row id')
  }
})

test('ensureManagedIngressContainerAllocation restores exited ingress row to pending', async () => {
  const serviceId = 'svc-ing-restore'
  const { db, containers, updates } = createIngressAllocationDb({
    containers: [{
      id: 'ing-old',
      serviceId,
      serverId: 'srv-old',
      containerId: null,
      containerName: 'pending',
      status: 'exited',
      role: 'ingress',
      composeServiceName: 'postgres-ingress',
      ordinal: 1,
    }],
  })

  const allocation = await ensureManagedIngressContainerAllocation(db, {
    serviceId,
    serverId: 'srv-new',
    composeServiceName: 'postgres-ingress',
  })

  assertEquals(allocation.containerRowId, 'ing-old')
  assertEquals(containers[0]!.status, 'pending')
  assertEquals(containers[0]!.serverId, 'srv-new')
  assertEquals(containers[0]!.containerName, `${serviceId}-in`)
  assertEquals(updates.length, 1)
})

test('ensureManagedIngressContainerAllocation prunes stray pending ingress rows', async () => {
  const serviceId = 'svc-ing-prune'
  const { db, containers, deletedContainerIds } = createIngressAllocationDb({
    containers: [
      {
        id: 'ing-keep',
        serviceId,
        serverId: 'srv-1',
        containerId: null,
        containerName: `${serviceId}-in`,
        status: 'pending',
        role: 'ingress',
        composeServiceName: 'postgres-ingress',
        ordinal: 1,
      },
      {
        id: 'ing-stray',
        serviceId,
        serverId: 'srv-old',
        containerId: null,
        containerName: 'pending',
        status: 'pending',
        role: 'ingress',
        composeServiceName: 'postgres-ingress',
        ordinal: 1,
      },
    ],
  })

  await ensureManagedIngressContainerAllocation(db, {
    serviceId,
    serverId: 'srv-1',
    composeServiceName: 'postgres-ingress',
  })

  assertEquals(deletedContainerIds, ['ing-stray'])
  assertEquals(containers.map((row) => row.id), ['ing-keep'])
})

test('ensureManagedIngressContainerAllocation throws when ingress row missing after upsert', async () => {
  const { db } = createIngressAllocationDb({ omitContainerAfterInsert: true })
  await assertRejects(
    () =>
      ensureManagedIngressContainerAllocation(db, {
        serviceId: 'svc-missing',
        serverId: 'srv-1',
        composeServiceName: 'postgres-ingress',
      }),
    Error,
    'service ingress container allocation missing after upsert',
  )
})
