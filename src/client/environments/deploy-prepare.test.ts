import { assertEquals, assertRejects } from 'jsr:@std/assert'
import { describe, it } from '@std/testing/bdd'
import {
  buildServiceOptionsMap,
  collectHealthCheckWarnings,
} from '../../lib/compose/apply-service-options.ts'
import { assertComposeDocument } from '../../lib/compose/index.ts'
import { sumServiceResourceUsage } from '../../lib/resource-limits.ts'
import { resolveHostingBindAddress } from './deploy-prepare.ts'

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

type IpRow = {
  id: string
  address: string
  serverId: string | null
  scope: string
}

function createIpLookupDb(rows: IpRow[]): Parameters<typeof resolveHostingBindAddress>[0] {
  return {
    select() {
      return {
        from() {
          return {
            where() {
              return {
                async limit() {
                  // Caller chains `.where(...).limit(1)`; return first matching
                  // row. Public-by-id and datacenter-by-server queries both end here.
                  return rows.slice(0, 1)
                },
              }
            },
          }
        },
      }
    },
  } as Parameters<typeof resolveHostingBindAddress>[0]
}

describe('resolveHostingBindAddress', () => {
  it('public + ipId returns the pinned address', async () => {
    const db = createIpLookupDb([{
      id: 'ip-1',
      address: '203.0.113.10',
      serverId: 'srv-1',
      scope: 'public',
    }])
    const result = await resolveHostingBindAddress(db, {
      serverId: 'srv-1',
      options: { bind: 'public' },
      ipId: 'ip-1',
    })
    assertEquals(result, '203.0.113.10')
  })

  it('public + no ipId returns undefined', async () => {
    const db = createIpLookupDb([])
    const result = await resolveHostingBindAddress(db, {
      serverId: 'srv-1',
      options: {},
      ipId: null,
    })
    assertEquals(result, undefined)
  })

  it('local returns loopback', async () => {
    const db = createIpLookupDb([])
    const result = await resolveHostingBindAddress(db, {
      serverId: 'srv-1',
      options: { bind: 'local' },
      ipId: null,
    })
    assertEquals(result, '127.0.0.1')
  })

  it('datacenter returns the server private IP when present', async () => {
    const db = createIpLookupDb([{
      id: 'ip-dc',
      address: '10.0.0.1',
      serverId: 'srv-1',
      scope: 'datacenter',
    }])
    const result = await resolveHostingBindAddress(db, {
      serverId: 'srv-1',
      options: { bind: 'datacenter' },
      ipId: null,
    })
    assertEquals(result, '10.0.0.1')
  })

  it('datacenter missing returns typed DeployPrepareError', async () => {
    const db = createIpLookupDb([])
    const result = await resolveHostingBindAddress(db, {
      serverId: 'srv-missing-dc',
      options: { bind: 'datacenter' },
      ipId: null,
    })
    assertEquals(result, {
      kind: 'datacenter_ip_required',
      serverId: 'srv-missing-dc',
    })
  })

  it('public + ipId rejects server mismatch', async () => {
    const db = createIpLookupDb([{
      id: 'ip-1',
      address: '203.0.113.10',
      serverId: 'other-server',
      scope: 'public',
    }])
    await assertRejects(
      () =>
        resolveHostingBindAddress(db, {
          serverId: 'srv-1',
          options: { bind: 'public' },
          ipId: 'ip-1',
        }),
      Error,
      'server mismatch',
    )
  })
})
