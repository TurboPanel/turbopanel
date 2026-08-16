import { assertEquals } from 'jsr:@std/assert'
import type { ServiceScheduleSpec } from './interpret.ts'
import {
  localReplicaCounts,
  localServiceNames,
  planEnvironmentSchedule,
  type ExistingTask,
  type FleetServer,
  type PlanEnvironmentInput,
  type PlannedService,
} from './planner.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const SERVER_A = '00000000-0000-4000-8000-00000000000a'
const SERVER_B = '00000000-0000-4000-8000-00000000000b'
const SERVER_C = '00000000-0000-4000-8000-00000000000c'
const SERVICE_WEB = '00000000-0000-4000-8000-0000000000aa'
const SERVICE_DB = '00000000-0000-4000-8000-0000000000bb'
const SERVICE_CACHE = '00000000-0000-4000-8000-0000000000cc'

function server(
  id: string,
  opts: Partial<FleetServer> = {},
): FleetServer {
  return {
    id,
    connected: true,
    labels: {},
    ...opts,
  }
}

function spec(
  composeServiceName: string,
  overrides: Partial<ServiceScheduleSpec> = {},
): ServiceScheduleSpec {
  return {
    composeServiceName,
    mode: 'replicated',
    replicas: 1,
    constraints: [],
    spreadKeys: [],
    publishedHostPorts: [],
    colocateWith: [],
    ...overrides,
  }
}

function planned(
  serviceId: string,
  composeServiceName: string,
  overrides: Partial<ServiceScheduleSpec> = {},
): PlannedService {
  return { serviceId, spec: spec(composeServiceName, overrides) }
}

function input(overrides: Partial<PlanEnvironmentInput> = {}): PlanEnvironmentInput {
  return {
    pinServerId: null,
    defaultServerId: SERVER_A,
    fabricEnabled: false,
    servers: [server(SERVER_A), server(SERVER_B)],
    services: [planned(SERVICE_WEB, 'web')],
    existingTasks: [],
    storagePins: new Map(),
    ...overrides,
  }
}

test('planEnvironmentSchedule returns the pin/default for empty services', () => {
  assertEquals(
    planEnvironmentSchedule(input({ services: [], defaultServerId: null, pinServerId: null })),
    { ok: true, tasks: [], serverIds: [] },
  )
  assertEquals(
    planEnvironmentSchedule(input({ services: [], pinServerId: SERVER_A })),
    { ok: true, tasks: [], serverIds: [SERVER_A] },
  )
  assertEquals(
    planEnvironmentSchedule(
      input({
        services: [],
        pinServerId: 'missing',
        servers: [server(SERVER_A)],
      }),
    ).ok,
    false,
  )
})

test('planEnvironmentSchedule places a single replica on the preferred server', () => {
  const plan = planEnvironmentSchedule(input())
  assertEquals(plan, {
    ok: true,
    tasks: [
      {
        serviceId: SERVICE_WEB,
        serverId: SERVER_A,
        slot: 0,
        desiredState: 'running',
      },
    ],
    serverIds: [SERVER_A],
  })
})

test('planEnvironmentSchedule keeps sticky placements across re-plans', () => {
  const existing: ExistingTask[] = [
    { serviceId: SERVICE_WEB, slot: 0, serverId: SERVER_B },
  ]
  const plan = planEnvironmentSchedule(
    input({
      existingTasks: existing,
      services: [planned(SERVICE_WEB, 'web', { replicas: 1 })],
    }),
  )
  assertEquals(plan.ok && plan.tasks[0]?.serverId, SERVER_B)
})

test('planEnvironmentSchedule requires TurboFabric for multi-server plans without a pin', () => {
  // Preferred-server sticky placement keeps same-service replicas on one host;
  // distinct label constraints force two hosts and trip the fabric gate.
  const plan = planEnvironmentSchedule(
    input({
      fabricEnabled: false,
      pinServerId: null,
      defaultServerId: null,
      services: [
        planned(SERVICE_WEB, 'web', {
          constraints: [{ key: 'role', op: 'eq', value: 'front' }],
        }),
        planned(SERVICE_DB, 'db', {
          constraints: [{ key: 'role', op: 'eq', value: 'data' }],
        }),
      ],
      servers: [
        server(SERVER_A, { labels: { role: 'front' } }),
        server(SERVER_B, { labels: { role: 'data' } }),
      ],
    }),
  )
  assertEquals(plan.ok, false)
  if (!plan.ok) {
    assertEquals(plan.error, 'turbofabric_required')
  }
})

test('planEnvironmentSchedule allows multi-server when fabric is enabled', () => {
  const plan = planEnvironmentSchedule(
    input({
      fabricEnabled: true,
      pinServerId: null,
      defaultServerId: null,
      services: [
        planned(SERVICE_WEB, 'web', {
          constraints: [{ key: 'role', op: 'eq', value: 'front' }],
        }),
        planned(SERVICE_DB, 'db', {
          constraints: [{ key: 'role', op: 'eq', value: 'data' }],
        }),
      ],
      servers: [
        server(SERVER_A, { labels: { role: 'front' } }),
        server(SERVER_B, { labels: { role: 'data' } }),
      ],
    }),
  )
  assertEquals(plan.ok, true)
  if (plan.ok) {
    assertEquals(plan.tasks.length, 2)
    assertEquals(plan.serverIds.length, 2)
  }
})

test('planEnvironmentSchedule honors whole-environment pins including offline hosts', () => {
  const plan = planEnvironmentSchedule(
    input({
      pinServerId: SERVER_C,
      servers: [
        server(SERVER_A),
        server(SERVER_C, { connected: false }),
      ],
      services: [planned(SERVICE_WEB, 'web', { replicas: 1 })],
    }),
  )
  assertEquals(plan.ok && plan.tasks[0]?.serverId, SERVER_C)
})

test('planEnvironmentSchedule fails constraints and colocation conflicts', () => {
  const constrained = planEnvironmentSchedule(
    input({
      services: [
        planned(SERVICE_WEB, 'web', {
          constraints: [{ key: 'zone', op: 'eq', value: 'west' }],
        }),
      ],
      servers: [server(SERVER_A, { labels: { zone: 'east' } })],
    }),
  )
  assertEquals(constrained.ok, false)
  if (!constrained.ok) {
    assertEquals(constrained.error, 'constraint_unsatisfiable')
  }

  const colocated = planEnvironmentSchedule(
    input({
      services: [
        planned(SERVICE_WEB, 'web', {
          colocateWith: ['db'],
          constraints: [{ key: 'tier', op: 'eq', value: 'front' }],
        }),
        planned(SERVICE_DB, 'db', {
          constraints: [{ key: 'tier', op: 'eq', value: 'data' }],
        }),
      ],
      servers: [
        server(SERVER_A, { labels: { tier: 'front' } }),
        server(SERVER_B, { labels: { tier: 'data' } }),
      ],
      fabricEnabled: true,
    }),
  )
  assertEquals(colocated.ok, false)
  if (!colocated.ok) {
    assertEquals(colocated.error, 'colocation_conflict')
  }
})

test('planEnvironmentSchedule rejects host-port conflicts for multi-replica local publishes', () => {
  const plan = planEnvironmentSchedule(
    input({
      pinServerId: SERVER_A,
      services: [
        planned(SERVICE_WEB, 'web', {
          replicas: 2,
          publishedHostPorts: [8080],
        }),
      ],
      servers: [server(SERVER_A)],
    }),
  )
  assertEquals(plan.ok, false)
  if (!plan.ok) {
    assertEquals(plan.error, 'host_port_conflict')
  }
})

test('planEnvironmentSchedule spreads replicas across label values when fabric is on', () => {
  const plan = planEnvironmentSchedule(
    input({
      fabricEnabled: true,
      defaultServerId: null,
      services: [
        planned(SERVICE_WEB, 'web', {
          replicas: 2,
          spreadKeys: ['zone'],
        }),
      ],
      servers: [
        server(SERVER_A, { labels: { zone: 'east' } }),
        server(SERVER_B, { labels: { zone: 'west' } }),
      ],
    }),
  )
  assertEquals(plan.ok, true)
  if (plan.ok) {
    const zones = new Set(plan.tasks.map((task) => task.serverId))
    assertEquals(zones.size, 2)
  }
})

test('planEnvironmentSchedule applies storage pins', () => {
  const plan = planEnvironmentSchedule(
    input({
      fabricEnabled: true,
      storagePins: new Map([[SERVICE_DB, SERVER_B]]),
      services: [planned(SERVICE_DB, 'db')],
    }),
  )
  assertEquals(plan.ok && plan.tasks[0]?.serverId, SERVER_B)
})

test('planEnvironmentSchedule places global mode on every eligible server', () => {
  // Published host ports force requireEmptyHost so global replicas cannot stack.
  const plan = planEnvironmentSchedule(
    input({
      fabricEnabled: true,
      defaultServerId: null,
      services: [
        planned(SERVICE_CACHE, 'cache', {
          mode: 'global',
          replicas: 1,
          publishedHostPorts: [9100],
        }),
      ],
      servers: [server(SERVER_A), server(SERVER_B)],
    }),
  )
  assertEquals(plan.ok, true)
  if (plan.ok) {
    assertEquals(plan.tasks.length, 2)
    assertEquals(plan.serverIds, [SERVER_A, SERVER_B])
  }
})

test('localReplicaCounts and localServiceNames filter by server', () => {
  const tasks = [
    {
      serviceId: SERVICE_WEB,
      serverId: SERVER_A,
      slot: 0,
      desiredState: 'running' as const,
    },
    {
      serviceId: SERVICE_WEB,
      serverId: SERVER_A,
      slot: 1,
      desiredState: 'running' as const,
    },
    {
      serviceId: SERVICE_DB,
      serverId: SERVER_B,
      slot: 0,
      desiredState: 'running' as const,
    },
  ]
  const names = new Map([
    [SERVICE_WEB, 'web'],
    [SERVICE_DB, 'db'],
  ])
  assertEquals(localReplicaCounts(tasks, names, SERVER_A), new Map([['web', 2]]))
  assertEquals(localServiceNames(tasks, names, SERVER_B), new Set(['db']))
  assertEquals(localServiceNames(tasks, names, SERVER_C), new Set())
})
