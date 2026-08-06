import { assertEquals } from '@std/assert'
import { emptyComposeDocument } from './types.ts'
import {
  applyResourcesToComposeService,
  applyServiceOptionsToComposeDocument,
  buildServiceOptionsMap,
  collectHealthCheckWarnings,
  serviceHasComposeHealthCheck,
} from './apply-service-options.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('applyServiceOptionsToComposeDocument sets container_name and deploy limits', () => {
  const doc = emptyComposeDocument()
  doc.data.services = {
    api: { image: 'node:22' },
  }

  const result = applyServiceOptionsToComposeDocument(doc, new Map([
    ['api', {
      container: { name: 'api-container' },
      operations: { stopGracePeriodSeconds: 45, maxRestartAttempts: 3 },
      resources: { cpus: 2, memoryBytes: 512_000_000, memoryReservationBytes: 256_000_000 },
      preDeployCommand: 'echo before',
      postDeployCommand: 'echo after',
      build: { disableCache: true },
    }],
  ]))

  const api = (result.document.data.services as Record<string, Record<string, unknown>>).api!
  assertEquals(api.container_name, 'api-container')
  assertEquals(api.stop_grace_period, '45s')
  assertEquals(api.cpus, 2)
  assertEquals(api.mem_limit, 512_000_000)
  assertEquals(api.mem_reservation, 256_000_000)
  assertEquals(
    (api.deploy as { resources: { limits: { cpus: string; memory: string } } }).resources.limits,
    { cpus: '2', memory: '512000000' },
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

test('buildServiceOptionsMap skips invalid option rows', () => {
  const map = buildServiceOptionsMap([
    { composeServiceName: 'api', options: { container: { name: 'api' } } },
    { composeServiceName: 'bad', options: { healthCheck: { policy: 'invalid' } } },
    { composeServiceName: 'empty', options: null },
    { composeServiceName: 'not-record', options: 'bad' },
  ])
  assertEquals(map.size, 2)
  assertEquals(map.get('api')?.container?.name, 'api')
  assertEquals(map.get('empty'), {})
})
