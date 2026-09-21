import { assertEquals } from '@std/assert'
import {
  checkResourceLimits,
  clampServiceResources,
  parseResourceLimits,
  sumServiceResourceUsage,
} from './resource-limits.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('parseResourceLimits accepts positive limits and empty input', () => {
  assertEquals(parseResourceLimits(null), {})
  assertEquals(parseResourceLimits(undefined), {})
  assertEquals(
    parseResourceLimits({
      maxCpus: 4,
      maxMemoryBytes: 1024,
      maxServicesPerEnvironment: 10,
    }),
    {
      maxCpus: 4,
      maxMemoryBytes: 1024,
      maxServicesPerEnvironment: 10,
    },
  )
})

test('parseResourceLimits rejects non-records and non-positive numbers', () => {
  assertEquals(parseResourceLimits('nope'), null)
  assertEquals(parseResourceLimits({ maxCpus: 0 }), {})
  assertEquals(parseResourceLimits({ maxCpus: -1 }), {})
  assertEquals(parseResourceLimits({ maxMemoryBytes: Number.NaN }), {})
})

test('checkResourceLimits reports org and server violations', () => {
  const violations = checkResourceLimits(
    { cpus: 8, memoryBytes: 2048, serviceCount: 5 },
    { maxCpus: 4, maxServicesPerEnvironment: 3 },
    { maxMemoryBytes: 1024 },
  )
  assertEquals(violations, [
    {
      scope: 'organization',
      field: 'maxCpus',
      limit: 4,
      requested: 8,
    },
    {
      scope: 'organization',
      field: 'maxServicesPerEnvironment',
      limit: 3,
      requested: 5,
    },
    {
      scope: 'server',
      field: 'maxMemoryBytes',
      limit: 1024,
      requested: 2048,
    },
  ])
})

test('sumServiceResourceUsage aggregates compose service options', () => {
  const usage = sumServiceResourceUsage(
    new Map([
      ['web', { resources: { cpus: 1, memoryBytes: 512 } }],
      ['api', { resources: { cpus: 2 } }],
    ]),
    3,
  )
  assertEquals(usage, { cpus: 3, memoryBytes: 512, serviceCount: 3 })
})

test('clampServiceResources applies the tighter org and server caps', () => {
  assertEquals(
    clampServiceResources(
      { resources: { cpus: 8, memoryBytes: 4096 } },
      { maxCpus: 4 },
      { maxMemoryBytes: 2048 },
    ),
    { resources: { cpus: 4, memoryBytes: 2048 } },
  )
  assertEquals(
    clampServiceResources({ resources: { cpus: 1 } }, {}, {}),
    { resources: { cpus: 1 } },
  )
})
