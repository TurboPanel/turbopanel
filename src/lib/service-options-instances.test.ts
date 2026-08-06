import { assertEquals } from 'jsr:@std/assert'
import {
  MAX_SERVICE_INSTANCES,
  formatStopGracePeriod,
  parseServiceOptions,
  resolveHealthCheckPolicy,
  resolveMaxRestartAttempts,
  resolveServiceInstances,
  resolveStopGracePeriodSeconds,
} from './service-options.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('parseServiceOptions accepts instances within the clamp', () => {
  assertEquals(parseServiceOptions({ instances: 3 }), { instances: 3 })
  assertEquals(
    parseServiceOptions({ instances: MAX_SERVICE_INSTANCES }),
    { instances: MAX_SERVICE_INSTANCES },
  )
})

test('parseServiceOptions drops invalid or oversized instances', () => {
  assertEquals(parseServiceOptions({ instances: 0 }), {})
  assertEquals(parseServiceOptions({ instances: -1 }), {})
  assertEquals(parseServiceOptions({ instances: 1.5 }), { instances: 1 })
  assertEquals(parseServiceOptions({ instances: MAX_SERVICE_INSTANCES + 1 }), {})
})

test('resolveServiceInstances defaults to 1', () => {
  assertEquals(resolveServiceInstances(undefined), 1)
  assertEquals(resolveServiceInstances({}), 1)
  assertEquals(resolveServiceInstances({ instances: 4 }), 4)
})

test('parseServiceOptions reads deploy commands, build, container, and operations', () => {
  assertEquals(
    parseServiceOptions({
      preDeployCommand: ' npm ci ',
      postDeployCommand: 'echo done',
      build: { disableCache: true },
      container: { name: ' web ' },
      operations: {
        stopGracePeriodSeconds: 45,
        maxRestartAttempts: 3,
      },
    }),
    {
      preDeployCommand: 'npm ci',
      postDeployCommand: 'echo done',
      build: { disableCache: true },
      container: { name: 'web' },
      operations: {
        stopGracePeriodSeconds: 45,
        maxRestartAttempts: 3,
      },
    },
  )
})

test('parseServiceOptions reads health check policy and resource limits', () => {
  assertEquals(
    parseServiceOptions({
      healthCheck: { policy: 'required' },
      resources: {
        cpus: 1.5,
        memoryBytes: 512,
        memoryReservationBytes: 256,
      },
    }),
    {
      healthCheck: { policy: 'required' },
      resources: {
        cpus: 1.5,
        memoryBytes: 512,
        memoryReservationBytes: 256,
      },
    },
  )
})

test('parseServiceOptions rejects invalid health policy and non-records', () => {
  assertEquals(parseServiceOptions({ healthCheck: { policy: 'always' } }), null)
  assertEquals(parseServiceOptions('nope'), null)
})

test('resolve helpers apply documented defaults', () => {
  assertEquals(resolveStopGracePeriodSeconds(undefined), 30)
  assertEquals(resolveMaxRestartAttempts(undefined), 10)
  assertEquals(resolveHealthCheckPolicy(undefined), 'disabled')
  assertEquals(formatStopGracePeriod(45), '45s')
})
