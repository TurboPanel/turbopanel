import { assertEquals } from '@std/assert'
import { emptyComposeDocument } from './types.ts'
import type { ComposeDocument } from './types.ts'
import {
  applyResourcesToComposeService,
  applyServiceOptionsToComposeDocument,
  buildServiceOptionsMap,
  collectHealthCheckWarnings,
  serviceHasComposeHealthCheck,
  TURBOPANEL_NAME_LABEL,
} from './apply-service-options.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

function assertServiceRecord(
  value: unknown,
  name: string,
): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`expected service record for ${name}`)
  }
}

test('applyServiceOptionsToComposeDocument sets container_name and deploy limits', () => {
  const doc = emptyComposeDocument()
  doc.data.services = {
    api: { image: 'node:22' },
  }

  const result = applyServiceOptionsToComposeDocument(
    doc,
    new Map([
      ['api', {
        operations: { stopGracePeriodSeconds: 45, maxRestartAttempts: 3 },
        resources: { cpus: 2, memoryBytes: 512_000_000, memoryReservationBytes: 256_000_000 },
        preDeployCommand: 'echo before',
        postDeployCommand: 'echo after',
        build: { disableCache: true },
      }],
    ]),
    new Map([['api', 'api-container']]),
  )

  const api = (result.document.data.services as Record<string, Record<string, unknown>>).api!
  assertServiceRecord(api, 'api')
  assertEquals(api.container_name, 'api-container')
  assertEquals(api.stop_grace_period, '45s')
  assertEquals(api.cpus, 2)
  assertEquals(api.mem_limit, 512_000_000)
  assertEquals(api.mem_reservation, 256_000_000)
  assertEquals(
    (api.deploy as { resources: { limits: { cpus: string; memory: string } } }).resources.limits,
    { cpus: '2', memory: '512000000' },
  )
  assertEquals(
    (api.deploy as { restart_policy: { condition: string; max_attempts: number } })
      .restart_policy,
    { condition: 'on-failure', max_attempts: 3 },
  )
  assertEquals(result.hooks, [{
    composeServiceName: 'api',
    preDeployCommand: 'echo before',
    postDeployCommand: 'echo after',
    buildDisableCache: true,
  }])
})

test('applyServiceOptionsToComposeDocument preserves existing stop_grace_period', () => {
  const doc = emptyComposeDocument()
  doc.data.services = {
    api: { image: 'node:22', stop_grace_period: '10s' },
  }

  const result = applyServiceOptionsToComposeDocument(doc, new Map([
    ['api', { operations: { stopGracePeriodSeconds: 99 } }],
  ]))

  const api = (result.document.data.services as Record<string, Record<string, unknown>>).api!
  assertEquals(api.stop_grace_period, '10s')
})

test('applyServiceOptionsToComposeDocument applies defaults across multi-service maps', () => {
  const doc = emptyComposeDocument()
  doc.data.services = {
    zebra: { image: 'z' },
    alpha: { image: 'a' },
    mid: 'not-a-service-object',
  }

  const result = applyServiceOptionsToComposeDocument(
    doc,
    new Map([
      ['alpha', { operations: { maxRestartAttempts: 2 } }],
      // zebra intentionally omitted — defaults apply
    ]),
  )

  const services = result.document.data.services as Record<string, unknown>
  assertServiceRecord(services.alpha, 'alpha')
  assertServiceRecord(services.zebra, 'zebra')
  assertEquals(services.mid, 'not-a-service-object')
  assertEquals(services.alpha.stop_grace_period, '30s')
  assertEquals(
    (services.alpha.deploy as { restart_policy: { max_attempts: number } }).restart_policy
      .max_attempts,
    2,
  )
  assertEquals(services.zebra.stop_grace_period, '30s')
  assertEquals(
    (services.zebra.deploy as { restart_policy: { max_attempts: number } }).restart_policy
      .max_attempts,
    10,
  )
  assertEquals(result.hooks, [])
})

test('applyServiceOptionsToComposeDocument emits single-field deploy hooks', () => {
  const doc = emptyComposeDocument()
  doc.data.services = {
    pre: { image: 'pre' },
    post: { image: 'post' },
    cache: { image: 'cache' },
    none: { image: 'none' },
  }

  const result = applyServiceOptionsToComposeDocument(
    doc,
    new Map([
      ['pre', { preDeployCommand: 'pre-only' }],
      ['post', { postDeployCommand: 'post-only' }],
      ['cache', { build: { disableCache: true } }],
      ['none', {}],
    ]),
  )

  assertEquals(result.hooks, [
    { composeServiceName: 'cache', buildDisableCache: true },
    { composeServiceName: 'post', postDeployCommand: 'post-only' },
    { composeServiceName: 'pre', preDeployCommand: 'pre-only' },
  ])
})

test('applyServiceOptionsToComposeDocument preserves existing deploy restart_policy fields', () => {
  const doc = emptyComposeDocument()
  doc.data.services = {
    api: {
      image: 'node:22',
      deploy: {
        mode: 'replicated',
        restart_policy: { condition: 'any', delay: '5s' },
        resources: { reservations: { cpus: '0.25' } },
      },
    },
  }

  const result = applyServiceOptionsToComposeDocument(
    doc,
    new Map([
      ['api', {
        operations: { maxRestartAttempts: 7 },
        resources: { memoryBytes: 100 },
      }],
    ]),
  )

  const api = (result.document.data.services as Record<string, Record<string, unknown>>).api!
  const deploy = api.deploy as {
    mode: string
    restart_policy: Record<string, unknown>
    resources: { reservations: { cpus: string }; limits: { memory: string } }
  }
  assertEquals(deploy.mode, 'replicated')
  assertEquals(deploy.restart_policy, {
    condition: 'any',
    delay: '5s',
    max_attempts: 7,
  })
  assertEquals(deploy.resources.reservations.cpus, '0.25')
  assertEquals(deploy.resources.limits.memory, '100')
})

test('applyServiceOptionsToComposeDocument handles missing services mapping', () => {
  const doc: ComposeDocument = {
    version: 1,
    data: {},
    presentation: { keyOrder: [], comments: {} },
  }
  const result = applyServiceOptionsToComposeDocument(doc, new Map())
  assertEquals(result.document.data.services, {})
  assertEquals(result.hooks, [])
})

test('applyServiceOptionsToComposeDocument handles non-record services', () => {
  const doc = emptyComposeDocument()
  doc.data.services = ['not', 'a', 'map'] as unknown as Record<string, unknown>
  const result = applyServiceOptionsToComposeDocument(doc, new Map([
    ['api', { preDeployCommand: 'true' }],
  ]))
  assertEquals(result.document.data.services, {})
  assertEquals(result.hooks, [])
})

test('applyResourcesToComposeService writes only provided limits', () => {
  const service: Record<string, unknown> = { image: 'nginx' }
  applyResourcesToComposeService(service, { cpus: 0.5 })
  assertEquals(service.cpus, 0.5)
  assertEquals(service.mem_limit, undefined)
  assertEquals(
    (service.deploy as { resources: { limits: { cpus: string } } }).resources.limits.cpus,
    '0.5',
  )
})

test('applyResourcesToComposeService memory-only omits cpus keys', () => {
  const service: Record<string, unknown> = { image: 'nginx' }
  applyResourcesToComposeService(service, { memoryBytes: 64 })
  assertEquals(service.cpus, undefined)
  assertEquals(service.mem_limit, 64)
  assertEquals(service.mem_reservation, undefined)
  assertEquals(
    (service.deploy as { resources: { limits: Record<string, string> } }).resources.limits,
    { memory: '64' },
  )
})

test('applyResourcesToComposeService reservation-only leaves deploy limits empty', () => {
  const service: Record<string, unknown> = { image: 'nginx' }
  applyResourcesToComposeService(service, { memoryReservationBytes: 32 })
  assertEquals(service.mem_reservation, 32)
  assertEquals(service.mem_limit, undefined)
  assertEquals(service.deploy, undefined)
})

test('applyResourcesToComposeService merges into existing deploy resources', () => {
  const service: Record<string, unknown> = {
    image: 'nginx',
    deploy: {
      labels: ['keep'],
      resources: {
        reservations: { memory: '1M' },
        limits: { cpus: '1' },
      },
    },
  }
  applyResourcesToComposeService(service, {
    cpus: 2,
    memoryBytes: 200,
    memoryReservationBytes: 50,
  })
  assertEquals(service.cpus, 2)
  assertEquals(service.mem_limit, 200)
  assertEquals(service.mem_reservation, 50)
  const deploy = service.deploy as {
    labels: string[]
    resources: {
      reservations: { memory: string }
      limits: { cpus: string; memory: string }
    }
  }
  assertEquals(deploy.labels, ['keep'])
  assertEquals(deploy.resources.reservations.memory, '1M')
  assertEquals(deploy.resources.limits, { cpus: '2', memory: '200' })
})

test('applyResourcesToComposeService empty resources object is a no-op', () => {
  const service: Record<string, unknown> = { image: 'nginx' }
  applyResourcesToComposeService(service, {})
  assertEquals(service.cpus, undefined)
  assertEquals(service.deploy, undefined)
})

test('collectHealthCheckWarnings skips traditional-web and compose healthcheck', () => {
  const doc = emptyComposeDocument()
  doc.data.services = {
    api: { image: 'node:22' },
    healthy: { image: 'node:22', healthcheck: { test: ['CMD', 'true'] } },
    site: {
      'x-turbopanel': { serviceKind: 'traditional-web', engine: 'nginx' },
    },
  }

  const warnings = collectHealthCheckWarnings(doc, new Map([
    ['api', { healthCheck: { policy: 'warn' } }],
    ['healthy', { healthCheck: { policy: 'required' } }],
    ['site', { healthCheck: { policy: 'required' } }],
    ['missing', { healthCheck: { policy: 'warn' } }],
  ]))

  assertEquals(warnings, [{ composeServiceName: 'api', policy: 'warn' }])
})

test('collectHealthCheckWarnings emits required and warn for bare services', () => {
  const doc = emptyComposeDocument()
  doc.data.services = {
    needWarn: { image: 'a' },
    needRequired: { image: 'b' },
    disabled: { image: 'c' },
    unset: { image: 'd' },
  }

  const warnings = collectHealthCheckWarnings(
    doc,
    new Map([
      ['needWarn', { healthCheck: { policy: 'warn' } }],
      ['needRequired', { healthCheck: { policy: 'required' } }],
      ['disabled', { healthCheck: { policy: 'disabled' } }],
      // unset → default disabled
    ]),
  )

  assertEquals(warnings, [
    { composeServiceName: 'needRequired', policy: 'required' },
    { composeServiceName: 'needWarn', policy: 'warn' },
  ])
})

test('collectHealthCheckWarnings ignores non-record services entries', () => {
  const doc = emptyComposeDocument()
  doc.data.services = {
    ok: { image: 'a' },
    weird: 42,
  }

  const warnings = collectHealthCheckWarnings(
    doc,
    new Map([
      ['ok', { healthCheck: { policy: 'warn' } }],
      ['weird', { healthCheck: { policy: 'required' } }],
    ]),
  )

  assertEquals(warnings, [
    { composeServiceName: 'ok', policy: 'warn' },
    { composeServiceName: 'weird', policy: 'required' },
  ])
})

test('collectHealthCheckWarnings returns empty when services missing or invalid', () => {
  const emptyDoc: ComposeDocument = {
    version: 1,
    data: {},
    presentation: { keyOrder: [], comments: {} },
  }
  assertEquals(collectHealthCheckWarnings(emptyDoc, new Map()), [])

  const arrayServices = emptyComposeDocument()
  arrayServices.data.services = [] as unknown as Record<string, unknown>
  assertEquals(
    collectHealthCheckWarnings(
      arrayServices,
      new Map([['api', { healthCheck: { policy: 'warn' } }]]),
    ),
    [],
  )
})

test('serviceHasComposeHealthCheck reports healthcheck presence', () => {
  const doc = emptyComposeDocument()
  doc.data.services = {
    api: { image: 'node:22' },
    worker: { image: 'busybox', healthcheck: { test: ['CMD', 'true'] } },
  }
  assertEquals(serviceHasComposeHealthCheck(doc, 'api'), false)
  assertEquals(serviceHasComposeHealthCheck(doc, 'worker'), true)
  assertEquals(serviceHasComposeHealthCheck(doc, 'missing'), false)
})

test('serviceHasComposeHealthCheck is false for missing or non-record services', () => {
  const noServices: ComposeDocument = {
    version: 1,
    data: {},
    presentation: { keyOrder: [], comments: {} },
  }
  assertEquals(serviceHasComposeHealthCheck(noServices, 'api'), false)

  const arrayServices = emptyComposeDocument()
  arrayServices.data.services = null as unknown as Record<string, unknown>
  assertEquals(serviceHasComposeHealthCheck(arrayServices, 'api'), false)

  const scalar = emptyComposeDocument()
  scalar.data.services = { api: 'nginx' }
  assertEquals(serviceHasComposeHealthCheck(scalar, 'api'), false)
})

test('buildServiceOptionsMap skips invalid option rows', () => {
  const map = buildServiceOptionsMap([
    { composeServiceName: 'api', options: { instances: 2 } },
    { composeServiceName: 'bad', options: { healthCheck: { policy: 'invalid' } } },
    { composeServiceName: 'empty', options: null },
    { composeServiceName: 'not-record', options: 'bad' },
  ])
  assertEquals(map.size, 2)
  assertEquals(map.get('api')?.instances, 2)
  assertEquals(map.get('empty'), {})
})

test('buildServiceOptionsMap keeps last row for duplicate compose names', () => {
  const map = buildServiceOptionsMap([
    { composeServiceName: 'web', options: { instances: 1 } },
    {
      composeServiceName: 'web',
      options: {
        healthCheck: { policy: 'warn' },
        instances: 3,
      },
    },
    { composeServiceName: 'worker', options: { instances: 2 } },
  ])
  assertEquals(map.size, 2)
  assertEquals(map.get('web')?.healthCheck?.policy, 'warn')
  assertEquals(map.get('web')?.instances, 3)
  assertEquals(map.get('worker')?.instances, 2)
})

test('buildServiceOptionsMap accepts empty input', () => {
  const map = buildServiceOptionsMap([])
  assertEquals(map.size, 0)
})

const SERVICE_UUID = '01a025f1-850c-705d-a7c2-1833d01cda9f'

test('renaming a container to the service id keeps the authored name as alias + label', () => {
  const doc = emptyComposeDocument()
  doc.data.services = {
    adminer: {
      image: 'adminer:latest',
      restart: 'unless-stopped',
      container_name: 'adminer',
    },
  }

  const result = applyServiceOptionsToComposeDocument(
    doc,
    new Map(),
    new Map([['adminer', SERVICE_UUID]]),
  )

  const adminer = (result.document.data.services as Record<string, unknown>).adminer
  assertServiceRecord(adminer, 'adminer')
  assertEquals(adminer.container_name, SERVICE_UUID)
  // No `networks:` authored — the implicit default is named so the alias lands.
  assertEquals(adminer.networks, { default: { aliases: ['adminer'] } })
  assertEquals(
    (adminer.labels as Record<string, string>)[TURBOPANEL_NAME_LABEL],
    'adminer',
  )
})

test('friendly name falls back to the compose service key', () => {
  const doc = emptyComposeDocument()
  doc.data.services = { web: { image: 'nginx:alpine' } }

  const result = applyServiceOptionsToComposeDocument(
    doc,
    new Map(),
    new Map([['web', SERVICE_UUID]]),
  )

  const web = (result.document.data.services as Record<string, unknown>).web
  assertServiceRecord(web, 'web')
  assertEquals(web.container_name, SERVICE_UUID)
  assertEquals(web.networks, { default: { aliases: ['web'] } })
  assertEquals((web.labels as Record<string, string>)[TURBOPANEL_NAME_LABEL], 'web')
})

test('aliases land on every declared network and keep existing entries', () => {
  const doc = emptyComposeDocument()
  doc.data.services = {
    api: {
      image: 'node:22',
      networks: {
        frontend: { aliases: ['api-internal'] },
        backend: {},
      },
      labels: ['owner=team'],
    },
  }

  const result = applyServiceOptionsToComposeDocument(
    doc,
    new Map(),
    new Map([['api', SERVICE_UUID]]),
  )

  const api = (result.document.data.services as Record<string, unknown>).api
  assertServiceRecord(api, 'api')
  assertEquals(api.networks, {
    frontend: { aliases: ['api-internal', 'api'] },
    backend: { aliases: ['api'] },
  })
  assertEquals(api.labels, ['owner=team', `${TURBOPANEL_NAME_LABEL}=api`])
})

test('list-form networks are normalized to a mapping carrying the alias', () => {
  const doc = emptyComposeDocument()
  doc.data.services = {
    api: { image: 'node:22', networks: ['frontend'] },
  }

  const result = applyServiceOptionsToComposeDocument(
    doc,
    new Map(),
    new Map([['api', SERVICE_UUID]]),
  )

  const api = (result.document.data.services as Record<string, unknown>).api
  assertServiceRecord(api, 'api')
  assertEquals(api.networks, { frontend: { aliases: ['api'] } })
})

test('no allocated name (custom mode / scaled service) leaves compose untouched', () => {
  const doc = emptyComposeDocument()
  doc.data.services = {
    adminer: { image: 'adminer:latest', container_name: 'adminer' },
  }

  const result = applyServiceOptionsToComposeDocument(doc, new Map(), new Map())

  const adminer = (result.document.data.services as Record<string, unknown>).adminer
  assertServiceRecord(adminer, 'adminer')
  assertEquals(adminer.container_name, 'adminer')
  assertEquals(adminer.networks, undefined)
  assertEquals(adminer.labels, undefined)
})

test('an allocated name equal to the authored name adds no alias', () => {
  const doc = emptyComposeDocument()
  doc.data.services = {
    adminer: { image: 'adminer:latest', container_name: 'adminer' },
  }

  const result = applyServiceOptionsToComposeDocument(
    doc,
    new Map(),
    new Map([['adminer', 'adminer']]),
  )

  const adminer = (result.document.data.services as Record<string, unknown>).adminer
  assertServiceRecord(adminer, 'adminer')
  assertEquals(adminer.container_name, 'adminer')
  assertEquals(adminer.networks, undefined)
})
