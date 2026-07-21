import { assertEquals } from 'jsr:@std/assert'
import { describe, it } from '@std/testing/bdd'
import {
  buildServiceOptionsMap,
  collectHealthCheckWarnings,
} from '../../lib/compose/apply-service-options.ts'
import { assertComposeDocument } from '../../lib/compose/index.ts'
import { sumServiceResourceUsage } from '../../lib/resource-limits.ts'

describe('deploy-prepare helpers', () => {
  it('counts compose services for resource usage even without DB options rows', () => {
    const merged = assertComposeDocument({
      version: 1,
      data: {
        services: {
          web: { image: 'nginx:latest' },
          api: { image: 'node:22' },
        },
      },
      presentation: { keyOrder: ['services'], comments: {} },
    })

    const composeNames = Object.keys(merged.data.services as Record<string, unknown>)
    const optionsByComposeName = buildServiceOptionsMap([], () => 'unused', 'unused')
    const usage = sumServiceResourceUsage(optionsByComposeName, composeNames.length)

    assertEquals(usage.serviceCount, 2)
    assertEquals(usage.cpus, 0)
  })

  it('evaluates health-check warnings for every compose service', () => {
    const merged = assertComposeDocument({
      version: 1,
      data: {
        services: {
          web: { image: 'nginx:latest' },
        },
      },
      presentation: { keyOrder: ['services'], comments: {} },
    })

    const warnings = collectHealthCheckWarnings(merged, new Map())
    assertEquals(warnings.length, 1)
    assertEquals(warnings[0]?.composeServiceName, 'web')
    assertEquals(warnings[0]?.policy, 'warn')
  })
})
