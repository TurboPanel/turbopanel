import { assertEquals, assertRejects } from 'jsr:@std/assert'
import { describe, it } from '@std/testing/bdd'
import {
  buildServiceOptionsMap,
  collectHealthCheckWarnings,
} from '../../lib/compose/apply-service-options.ts'
import { assertComposeDocument } from '../../lib/compose/index.ts'
import { principalHomeDir, principalVolumePath } from '../../lib/naming.ts'
import { DEFAULT_PRINCIPAL_SHELL } from '../../lib/principal-options.ts'
import { sumServiceResourceUsage } from '../../lib/resource-limits.ts'
import type { Db } from '../../db.ts'
import {
  loadPrincipalMaterial,
  loadStorageMaterial,
  resolveHostingBindAddress,
} from './deploy-prepare.ts'

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

type StorageFixtureRow = {
  id: string
  kind: string
  name: string
  sourcePath: string | null
  destinationPath: string | null
  principalId: string | null
  contentEnvelope: string | null
  serviceId: string | null
  serverId: string | null
  metadata: unknown
}

function createSelectWhereDb<T>(rows: T[]): Db {
  return {
    select() {
      return {
        from() {
          return {
            where() {
              return Promise.resolve(rows)
            },
          }
        },
      }
    },
  } as unknown as Db
}

describe('loadStorageMaterial principal bind mounts', () => {
  const principalId = '01936b3e-aaaa-bbbb-cccc-123456789abc'
  const storageId = '01936b3e-dddd-eeee-ffff-123456789abc'

  const baseParams = {
    environmentId: 'env-1',
    projectId: 'proj-1',
    organizationId: 'org-1',
    serverId: 'srv-1',
    serviceIds: [] as string[],
    cloneNamesByServiceId: new Map<string, string[]>(),
    registeredVolumes: [] as const,
  }

  it('derives principal volume path when sourcePath is empty', async () => {
    const db = createSelectWhereDb<StorageFixtureRow>([{
      id: storageId,
      kind: 'bind_mount',
      name: 'data',
      sourcePath: null,
      destinationPath: '/app/data',
      principalId,
      contentEnvelope: null,
      serviceId: null,
      serverId: 'srv-1',
      metadata: null,
    }])
    const material = await loadStorageMaterial(db, baseParams)
    assertEquals(material.length, 1)
    assertEquals(material[0]?.sourcePath, principalVolumePath(principalId, storageId))
  })

  it('keeps an explicit sourcePath override', async () => {
    const db = createSelectWhereDb<StorageFixtureRow>([{
      id: storageId,
      kind: 'bind_mount',
      name: 'data',
      sourcePath: '/custom/mount',
      destinationPath: '/app/data',
      principalId,
      contentEnvelope: null,
      serviceId: null,
      serverId: 'srv-1',
      metadata: null,
    }])
    const material = await loadStorageMaterial(db, baseParams)
    assertEquals(material[0]?.sourcePath, '/custom/mount')
  })

  it('leaves non-principal bind mounts untouched', async () => {
    const db = createSelectWhereDb<StorageFixtureRow>([{
      id: storageId,
      kind: 'bind_mount',
      name: 'data',
      sourcePath: null,
      destinationPath: '/app/data',
      principalId: null,
      contentEnvelope: null,
      serviceId: null,
      serverId: 'srv-1',
      metadata: null,
    }])
    const material = await loadStorageMaterial(db, baseParams)
    assertEquals(material[0]?.sourcePath, undefined)
  })
})

describe('loadPrincipalMaterial home and shell', () => {
  const principalId = '01936b3e-aaaa-bbbb-cccc-123456789abc'

  it('emits canonical home and resolved shell', async () => {
    const db = createSelectWhereDb([{
      id: principalId,
      username: 'appuser',
      metadata: { uid: 10001, gid: 10001, home: '/var/lib/turbopanel/principals/appuser' },
      options: { shell: '/bin/bash' },
    }])
    const material = await loadPrincipalMaterial(db, [principalId])
    assertEquals(material.length, 1)
    assertEquals(material[0]?.home, principalHomeDir(principalId))
    assertEquals(material[0]?.shell, '/bin/bash')
    assertEquals(material[0]?.uid, 10001)
    assertEquals(material[0]?.gid, 10001)
  })

  it('defaults shell when options omit it', async () => {
    const db = createSelectWhereDb([{
      id: principalId,
      username: 'appuser',
      metadata: { uid: 10001, gid: 10001 },
      options: null,
    }])
    const material = await loadPrincipalMaterial(db, [principalId])
    assertEquals(material[0]?.shell, DEFAULT_PRINCIPAL_SHELL)
    assertEquals(material[0]?.home, principalHomeDir(principalId))
  })
})
