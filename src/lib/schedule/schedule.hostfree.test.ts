import { assertEquals } from 'jsr:@std/assert'
import {
  interpretServiceSchedule,
  resolveReplicaPolicy,
} from './interpret.ts'
import {
  localReplicaCounts,
  planEnvironmentSchedule,
  type FleetServer,
  type PlannedService,
} from './planner.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('resolveReplicaPolicy prefers deploy.replicas over instances', () => {
  assertEquals(
    resolveReplicaPolicy({ deploy: { replicas: 3 } }, 2),
    { mode: 'replicated', replicas: 3 },
  )
  assertEquals(
    resolveReplicaPolicy({ deploy: { mode: 'global' } }, 9),
    { mode: 'global', replicas: 1 },
  )
  assertEquals(resolveReplicaPolicy({}, 4), { mode: 'replicated', replicas: 4 })
  assertEquals(resolveReplicaPolicy({}, 0), { mode: 'replicated', replicas: 1 })
})

test('interpretServiceSchedule reads constraints, spread, ports, and colocation', () => {
  const spec = interpretServiceSchedule(
    'web',
    {
      image: 'nginx',
      ports: ['8080:80', { published: 443, target: 443 }],
      network_mode: 'service:lb',
      deploy: {
        replicas: 2,
        placement: {
          constraints: ['node.labels.role == web', 'node.labels.disk != hdd'],
          preferences: [{ spread: 'node.labels.datacenter' }],
        },
      },
    },
    1,
  )
  assertEquals(spec.replicas, 2)
  assertEquals(spec.constraints, [
    { key: 'role', op: 'eq', value: 'web' },
    { key: 'disk', op: 'neq', value: 'hdd' },
  ])
  assertEquals(spec.spreadKeys, ['datacenter'])
  assertEquals(spec.publishedHostPorts, [443, 8080])
  assertEquals(spec.colocateWith, ['lb'])
})

const alpha: FleetServer = {
  id: 'server-a',
  connected: true,
  datacenterId: 'dc-1',
  labels: { role: 'web', datacenter: 'east' },
}
const bravo: FleetServer = {
  id: 'server-b',
  connected: true,
  datacenterId: 'dc-2',
  labels: { role: 'web', datacenter: 'west' },
}
const charlie: FleetServer = {
  id: 'server-c',
  connected: false,
  datacenterId: 'dc-1',
  labels: { role: 'web' },
}

function webService(replicas: number): PlannedService {
  return {
    serviceId: 'svc-web',
    spec: {
      composeServiceName: 'web',
      mode: 'replicated',
      replicas,
      constraints: [],
      spreadKeys: [],
      publishedHostPorts: [],
      colocateWith: [],
    },
  }
}

test('planEnvironmentSchedule keeps a one-server plan without TurboFabric', () => {
  const plan = planEnvironmentSchedule({
    pinServerId: null,
    defaultServerId: 'server-a',
    fabricEnabled: false,
    servers: [alpha, bravo, charlie],
    services: [webService(2)],
    existingTasks: [],
    storagePins: new Map(),
  })
  assertEquals(plan.ok, true)
  if (!plan.ok) return
  assertEquals(plan.serverIds, ['server-a'])
  assertEquals(plan.tasks.length, 2)
  assertEquals(plan.tasks.every((task) => task.serverId === 'server-a'), true)
})

test('planEnvironmentSchedule requires TurboFabric to span hosts', () => {
  const plan = planEnvironmentSchedule({
    pinServerId: null,
    defaultServerId: null,
    fabricEnabled: false,
    servers: [alpha, bravo],
    services: [{
      serviceId: 'svc-web',
      spec: {
        composeServiceName: 'web',
        mode: 'replicated',
        replicas: 2,
        constraints: [],
        spreadKeys: ['datacenter'],
        publishedHostPorts: [8080],
        colocateWith: [],
      },
    }],
    existingTasks: [],
    storagePins: new Map(),
  })
  assertEquals(plan.ok, false)
  if (plan.ok) return
  assertEquals(plan.error, 'turbofabric_required')
})

test('planEnvironmentSchedule pin path never requires TurboFabric', () => {
  const plan = planEnvironmentSchedule({
    pinServerId: 'server-a',
    defaultServerId: null,
    fabricEnabled: false,
    servers: [alpha, bravo],
    services: [webService(3)],
    existingTasks: [],
    storagePins: new Map(),
  })
  assertEquals(plan.ok, true)
  if (!plan.ok) return
  assertEquals(plan.serverIds, ['server-a'])
})

test('planEnvironmentSchedule is sticky on (service, slot)', () => {
  const plan = planEnvironmentSchedule({
    pinServerId: null,
    defaultServerId: 'server-a',
    fabricEnabled: true,
    servers: [alpha, bravo],
    services: [webService(1)],
    existingTasks: [{ serviceId: 'svc-web', slot: 0, serverId: 'server-b' }],
    storagePins: new Map(),
  })
  assertEquals(plan.ok, true)
  if (!plan.ok) return
  assertEquals(plan.tasks[0]?.serverId, 'server-b')
})

test('planEnvironmentSchedule rejects host-port over-packing', () => {
  const plan = planEnvironmentSchedule({
    pinServerId: 'server-a',
    defaultServerId: null,
    fabricEnabled: false,
    servers: [alpha],
    services: [{
      serviceId: 'svc-web',
      spec: {
        composeServiceName: 'web',
        mode: 'replicated',
        replicas: 2,
        constraints: [],
        spreadKeys: [],
        publishedHostPorts: [80],
        colocateWith: [],
      },
    }],
    existingTasks: [],
    storagePins: new Map(),
  })
  assertEquals(plan.ok, false)
  if (plan.ok) return
  assertEquals(plan.error, 'host_port_conflict')
})

test('localReplicaCounts groups tasks for one server', () => {
  const counts = localReplicaCounts(
    [
      { serviceId: 'svc-web', serverId: 'server-a', slot: 0 },
      { serviceId: 'svc-web', serverId: 'server-a', slot: 1 },
      { serviceId: 'svc-web', serverId: 'server-b', slot: 2 },
    ],
    new Map([['svc-web', 'web']]),
    'server-a',
  )
  assertEquals([...counts.entries()], [['web', 2]])
})

test('planEnvironmentSchedule places on a disconnected pin', () => {
  const plan = planEnvironmentSchedule({
    pinServerId: 'server-c',
    defaultServerId: null,
    fabricEnabled: false,
    servers: [alpha, charlie],
    services: [webService(1)],
    existingTasks: [],
    storagePins: new Map(),
  })
  assertEquals(plan.ok, true)
  if (!plan.ok) return
  assertEquals(plan.serverIds, ['server-c'])
})

test('planEnvironmentSchedule empty services still targets the pin', () => {
  const plan = planEnvironmentSchedule({
    pinServerId: 'server-a',
    defaultServerId: null,
    fabricEnabled: false,
    servers: [alpha],
    services: [],
    existingTasks: [],
    storagePins: new Map(),
  })
  assertEquals(plan.ok, true)
  if (!plan.ok) return
  assertEquals(plan.serverIds, ['server-a'])
  assertEquals(plan.tasks, [])
})
