import { assertEquals, assertRejects } from 'jsr:@std/assert'
import { describe, it } from '@std/testing/bdd'
import {
  buildServiceOptionsMap,
  collectHealthCheckWarnings,
} from '../../lib/compose/apply-service-options.ts'
import { assertComposeDocument, type TraditionalWebSiteSpec } from '../../lib/compose/index.ts'
import {
  dockerVolumeNameFromStorageId,
  principalHomeDir,
  principalVolumePath,
  resolveDockerVolumeName,
} from '../../lib/naming.ts'
import { DEFAULT_PRINCIPAL_SHELL } from '../../lib/principal-options.ts'
import { sumServiceResourceUsage } from '../../lib/resource-limits.ts'
import type { Db } from '../../db.ts'
import {
  absorbSoftPrepareError,
  appendPlatformVariablesToEntries,
  attachPrincipalsToTraditionalWebSites,
  buildCloneNamesByServiceId,
  buildExpandedServiceOptionsMap,
  buildInstancesByComposeName,
  buildServiceRowByCloneName,
  documentForServiceOptions,
  emptyComposePrepareResult,
  evaluateHealthCheckGates,
  expansionToRecord,
  extractComposeFromOptions,
  listComposeServiceKeys,
  listContainerComposeNames,
  loadPrincipalMaterial,
  loadStorageMaterial,
  mergeProjectEnvironmentCompose,
  readHostingProxyFromOptions,
  resolveHostingBindAddress,
  resolveTraditionalWebSitesForMode,
  resourceLimitPrepareError,
  splitTraditionalWebFromDocument,
  toPreparedDeployResult,
  verifyServerInOrg,
  warningFromPrepareError,
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
    const optionsByComposeName = buildServiceOptionsMap([])
    const usage = sumServiceResourceUsage(optionsByComposeName, composeNames.length)

    assertEquals(usage.serviceCount, 2)
    assertEquals(usage.cpus, 0)
  })

  it('does not warn by default when compose has no healthcheck', () => {
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
    assertEquals(warnings.length, 0)
  })

  it('warns only when the operator sets healthCheck.policy to warn', () => {
    const merged = assertComposeDocument({
      version: 1,
      data: {
        services: {
          web: { image: 'nginx:latest' },
        },
      },
      presentation: { keyOrder: ['services'], comments: {} },
    })

    const optionsByComposeName = buildServiceOptionsMap([
      { composeServiceName: 'web', options: { healthCheck: { policy: 'warn' } } },
    ])
    const warnings = collectHealthCheckWarnings(merged, optionsByComposeName)
    assertEquals(warnings.length, 1)
    assertEquals(warnings[0]?.composeServiceName, 'web')
    assertEquals(warnings[0]?.policy, 'warn')
  })

  it('skips services that already declare a compose healthcheck', () => {
    const merged = assertComposeDocument({
      version: 1,
      data: {
        services: {
          web: {
            image: 'nginx:latest',
            healthcheck: { test: ['CMD', 'curl', '-f', 'http://localhost'] },
          },
        },
      },
      presentation: { keyOrder: ['services'], comments: {} },
    })

    const optionsByComposeName = buildServiceOptionsMap([
      {
        composeServiceName: 'web',
        options: { healthCheck: { policy: 'required' } },
      },
    ])
    const warnings = collectHealthCheckWarnings(merged, optionsByComposeName)
    assertEquals(warnings.length, 0)
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
  principalUsername: string | null
  contentEnvelope: string | null
  serviceId: string | null
  serverId: string | null
  metadata: unknown
}

function createSelectWhereDb<T>(rows: T[]): Db {
  const whereResult = () => Promise.resolve(rows)
  return {
    select() {
      return {
        from() {
          return {
            leftJoin() {
              return { where: whereResult }
            },
            innerJoin() {
              return { where: whereResult }
            },
            where: whereResult,
          }
        },
      }
    },
  } as unknown as Db
}

describe('loadStorageMaterial principal bind mounts', () => {
  const principalId = '01936b3e-aaaa-bbbb-cccc-123456789abc'
  const username = 'appuser'
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
      principalUsername: username,
      contentEnvelope: null,
      serviceId: null,
      serverId: 'srv-1',
      metadata: null,
    }])
    const material = await loadStorageMaterial(db, baseParams)
    assertEquals(material.length, 1)
    assertEquals(material[0]?.sourcePath, principalVolumePath(username, storageId))
  })

  it('keeps an explicit sourcePath override', async () => {
    const db = createSelectWhereDb<StorageFixtureRow>([{
      id: storageId,
      kind: 'bind_mount',
      name: 'data',
      sourcePath: '/custom/mount',
      destinationPath: '/app/data',
      principalId,
      principalUsername: username,
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
      principalUsername: null,
      contentEnvelope: null,
      serviceId: null,
      serverId: 'srv-1',
      metadata: null,
    }])
    const material = await loadStorageMaterial(db, baseParams)
    assertEquals(material[0]?.sourcePath, undefined)
  })

  it('leaves principal-owned bind mounts without username unresolved', async () => {
    const db = createSelectWhereDb<StorageFixtureRow>([{
      id: storageId,
      kind: 'bind_mount',
      name: 'data',
      sourcePath: null,
      destinationPath: '/app/data',
      principalId,
      principalUsername: null,
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
  const username = 'appuser'

  it('emits rows without uid/gid when no override is stored', async () => {
    const db = createSelectWhereDb([{
      id: principalId,
      username,
      options: { shell: '/bin/bash' },
    }])
    const material = await loadPrincipalMaterial(db, [principalId])
    assertEquals(material.length, 1)
    assertEquals(material[0]?.home, principalHomeDir(username))
    assertEquals(material[0]?.shell, '/bin/bash')
    assertEquals(material[0]?.uid, undefined)
    assertEquals(material[0]?.gid, undefined)
    assertEquals('uid' in (material[0] ?? {}), false)
    assertEquals('gid' in (material[0] ?? {}), false)
  })

  it('defaults shell when options omit it', async () => {
    const db = createSelectWhereDb([{
      id: principalId,
      username,
      options: null,
    }])
    const material = await loadPrincipalMaterial(db, [principalId])
    assertEquals(material[0]?.shell, DEFAULT_PRINCIPAL_SHELL)
    assertEquals(material[0]?.home, principalHomeDir(username))
  })

  it('echoes an operator uid/gid override when set', async () => {
    const db = createSelectWhereDb([{
      id: principalId,
      username,
      options: { shell: '/bin/bash', uid: 10001, gid: 10001 },
    }])
    const material = await loadPrincipalMaterial(db, [principalId])
    assertEquals(material[0]?.uid, 10001)
    assertEquals(material[0]?.gid, 10001)
    assertEquals(material[0]?.home, principalHomeDir(username))
  })

  it('returns an empty list when no principal ids are requested', async () => {
    const db = createSelectWhereDb([{ id: principalId, username, options: null }])
    const material = await loadPrincipalMaterial(db, [])
    assertEquals(material, [])
  })

  it('dedupes principal ids before querying', async () => {
    const db = createSelectWhereDb([{
      id: principalId,
      username,
      options: { shell: '/bin/sh' },
    }])
    const material = await loadPrincipalMaterial(db, [principalId, principalId])
    assertEquals(material.length, 1)
    assertEquals(material[0]?.principalId, principalId)
  })
})

const EMPTY_COMPOSE = {
  version: 1,
  data: { services: {} },
  presentation: { keyOrder: ['services'], comments: {} },
} as const

const WEB_COMPOSE = {
  version: 1,
  data: {
    services: {
      web: { image: 'nginx:latest' },
    },
  },
  presentation: { keyOrder: ['services'], comments: {} },
} as const

const WEB_API_COMPOSE = {
  version: 1,
  data: {
    services: {
      web: { image: 'nginx:latest' },
      api: { image: 'node:22' },
    },
  },
  presentation: { keyOrder: ['services'], comments: {} },
} as const

describe('extractComposeFromOptions', () => {
  it('returns compose when options is a plain object', () => {
    assertEquals(extractComposeFromOptions({ compose: WEB_COMPOSE }), WEB_COMPOSE)
  })

  it('returns null for non-objects and missing compose', () => {
    assertEquals(extractComposeFromOptions(null), null)
    assertEquals(extractComposeFromOptions('x'), null)
    assertEquals(extractComposeFromOptions([]), null)
    assertEquals(extractComposeFromOptions({}), null)
  })
})

describe('mergeProjectEnvironmentCompose', () => {
  it('merges environment overlay services onto the project base', () => {
    const merged = mergeProjectEnvironmentCompose(
      { compose: WEB_COMPOSE },
      {
        compose: {
          version: 1,
          data: {
            services: {
              api: { image: 'node:22' },
            },
          },
          presentation: { keyOrder: ['services'], comments: {} },
        },
      },
    )
    if (merged instanceof Response) {
      throw new TypeError('expected merged compose document')
    }
    const services = merged.data.services as Record<string, unknown>
    assertEquals(Object.keys(services).sort((a, b) => a.localeCompare(b)), ['api', 'web'])
  })

  it('returns 400 when either side is not a compose document', async () => {
    const res = mergeProjectEnvironmentCompose({ compose: 'bad' }, { compose: EMPTY_COMPOSE })
    if (!(res instanceof Response)) {
      throw new TypeError('expected Response')
    }
    assertEquals(res.status, 400)
    assertEquals(await res.json(), { error: 'Invalid compose document' })
  })
})

describe('readHostingProxyFromOptions', () => {
  it('returns undefined for non-object options', () => {
    assertEquals(readHostingProxyFromOptions(null), undefined)
    assertEquals(readHostingProxyFromOptions('x'), undefined)
  })

  it('applies proxy defaults when proxy is omitted', () => {
    assertEquals(readHostingProxyFromOptions({}), {
      forceHttps: true,
      gzip: true,
      brotli: false,
    })
  })

  it('passes through stripPrefix when set', () => {
    assertEquals(
      readHostingProxyFromOptions({
        proxy: { forceHttps: false, gzip: false, brotli: true, stripPrefix: true },
      }),
      {
        forceHttps: false,
        gzip: false,
        brotli: true,
        stripPrefix: true,
      },
    )
  })

  it('ignores a non-object proxy field', () => {
    assertEquals(readHostingProxyFromOptions({ proxy: 'nope' }), {
      forceHttps: true,
      gzip: true,
      brotli: false,
    })
  })
})

describe('verifyServerInOrg', () => {
  it('returns true when a matching server row exists', async () => {
    const db = {
      select() {
        return {
          from() {
            return {
              where() {
                return {
                  async limit() {
                    return [{ id: 'srv-1' }]
                  },
                }
              },
            }
          },
        }
      },
    } as unknown as Db
    assertEquals(await verifyServerInOrg(db, 'srv-1', 'org-1'), true)
  })

  it('returns false when no matching row exists', async () => {
    const db = {
      select() {
        return {
          from() {
            return {
              where() {
                return {
                  async limit() {
                    return []
                  },
                }
              },
            }
          },
        }
      },
    } as unknown as Db
    assertEquals(await verifyServerInOrg(db, 'srv-missing', 'org-1'), false)
  })
})

describe('loadStorageMaterial filters, volumes, and fan-out', () => {
  const principalId = '01936b3e-aaaa-bbbb-cccc-123456789abc'
  const username = 'appuser'
  const storageId = '01936b3e-dddd-eeee-ffff-123456789abc'
  const volumeStorageId = '01936b3e-1111-2222-3333-123456789abc'
  const serviceId = '01936b3e-4444-5555-6666-123456789abc'

  const baseParams = {
    environmentId: 'env-1',
    projectId: 'proj-1',
    organizationId: 'org-1',
    serverId: 'srv-1',
    serviceIds: [] as string[],
    cloneNamesByServiceId: new Map<string, string[]>(),
    registeredVolumes: [] as const,
  }

  it('drops rows for other servers and bind mounts without destination', async () => {
    const db = createSelectWhereDb<StorageFixtureRow>([
      {
        id: storageId,
        kind: 'bind_mount',
        name: 'other-server',
        sourcePath: '/x',
        destinationPath: '/app',
        principalId: null,
        principalUsername: null,
        contentEnvelope: null,
        serviceId: null,
        serverId: 'srv-other',
        metadata: null,
      },
      {
        id: '01936b3e-dddd-eeee-ffff-000000000001',
        kind: 'bind_mount',
        name: 'no-dest',
        sourcePath: '/x',
        destinationPath: null,
        principalId: null,
        principalUsername: null,
        contentEnvelope: null,
        serviceId: null,
        serverId: 'srv-1',
        metadata: null,
      },
    ])
    const material = await loadStorageMaterial(db, baseParams)
    assertEquals(material.length, 0)
  })

  it('keeps docker volumes without destination and resolves pinned names', async () => {
    const db = createSelectWhereDb<StorageFixtureRow>([{
      id: volumeStorageId,
      kind: 'docker_volume',
      name: 'pgdata',
      sourcePath: null,
      destinationPath: null,
      principalId: null,
      principalUsername: null,
      contentEnvelope: null,
      serviceId: null,
      serverId: 'srv-1',
      metadata: { dockerVolumeName: 'custom_vol' },
    }])
    const material = await loadStorageMaterial(db, baseParams)
    assertEquals(material.length, 1)
    assertEquals(material[0]?.kind, 'docker_volume')
    assertEquals(
      material[0]?.volumeName,
      resolveDockerVolumeName({
        storageId: volumeStorageId,
        pinnedName: 'custom_vol',
      }),
    )
  })

  it('falls back to storage id when docker volume metadata has no pin', async () => {
    const db = createSelectWhereDb<StorageFixtureRow>([{
      id: volumeStorageId,
      kind: 'docker_volume',
      name: 'pgdata',
      sourcePath: null,
      destinationPath: null,
      principalId: null,
      principalUsername: null,
      contentEnvelope: null,
      serviceId: null,
      serverId: 'srv-1',
      metadata: { dockerVolumeName: '' },
    }])
    const material = await loadStorageMaterial(db, baseParams)
    assertEquals(material[0]?.volumeName, dockerVolumeNameFromStorageId(volumeStorageId))
  })

  it('fans service-scoped rows out to clone compose names', async () => {
    const db = createSelectWhereDb<StorageFixtureRow>([{
      id: storageId,
      kind: 'bind_mount',
      name: 'data',
      sourcePath: '/srv/data',
      destinationPath: '/app/data',
      principalId: null,
      principalUsername: null,
      contentEnvelope: null,
      serviceId,
      serverId: 'srv-1',
      metadata: null,
    }])
    const material = await loadStorageMaterial(db, {
      ...baseParams,
      serviceIds: [serviceId],
      cloneNamesByServiceId: new Map([[serviceId, ['web-1', 'web-2']]]),
    })
    assertEquals(material.length, 2)
    assertEquals(material.map((row) => row.composeServiceName), ['web-1', 'web-2'])
  })

  it('appends registered volumes that were not already loaded', async () => {
    const seenId = volumeStorageId
    const unseenId = '01936b3e-7777-8888-9999-123456789abc'
    const db = createSelectWhereDb<StorageFixtureRow>([{
      id: seenId,
      kind: 'docker_volume',
      name: 'already',
      sourcePath: null,
      destinationPath: null,
      principalId: null,
      principalUsername: null,
      contentEnvelope: null,
      serviceId: null,
      serverId: 'srv-1',
      metadata: null,
    }])
    const material = await loadStorageMaterial(db, {
      ...baseParams,
      registeredVolumes: [
        { storageId: seenId, composeKey: 'already', volumeName: seenId },
        { storageId: unseenId, composeKey: 'extra', volumeName: unseenId },
      ],
    })
    assertEquals(material.length, 2)
    assertEquals(material[1]?.storageId, unseenId)
    assertEquals(material[1]?.name, 'extra')
    assertEquals(material[1]?.volumeName, unseenId)
  })

  it('carries contentEnvelope and treats empty sourcePath as unset for principals', async () => {
    const db = createSelectWhereDb<StorageFixtureRow>([{
      id: storageId,
      kind: 'bind_mount',
      name: 'data',
      sourcePath: '',
      destinationPath: '/app/data',
      principalId,
      principalUsername: username,
      contentEnvelope: 'tp1.sealed.example',
      serviceId: null,
      serverId: 'srv-1',
      metadata: null,
    }])
    const material = await loadStorageMaterial(db, baseParams)
    assertEquals(material[0]?.sourcePath, principalVolumePath(username, storageId))
    assertEquals(material[0]?.contentEnvelope, 'tp1.sealed.example')
    assertEquals(material[0]?.principalId, principalId)
  })
})

describe('resolveHostingBindAddress edge cases', () => {
  it('throws when the pinned public ip row is missing', async () => {
    const db = createIpLookupDb([])
    await assertRejects(
      () =>
        resolveHostingBindAddress(db, {
          serverId: 'srv-1',
          options: { bind: 'public' },
          ipId: 'missing-ip',
        }),
      Error,
      'not found',
    )
  })

  it('throws when the pinned public address is invalid', async () => {
    const db = createIpLookupDb([{
      id: 'ip-1',
      address: 'not-an-ip',
      serverId: 'srv-1',
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
      'address invalid',
    )
  })

  it('trims a valid public address', async () => {
    const db = createIpLookupDb([{
      id: 'ip-1',
      address: '  203.0.113.20  ',
      serverId: 'srv-1',
      scope: 'public',
    }])
    const result = await resolveHostingBindAddress(db, {
      serverId: 'srv-1',
      options: { bind: 'public' },
      ipId: 'ip-1',
    })
    assertEquals(result, '203.0.113.20')
  })

  it('allows a public pin with null serverId', async () => {
    const db = createIpLookupDb([{
      id: 'ip-1',
      address: '203.0.113.30',
      serverId: null,
      scope: 'public',
    }])
    const result = await resolveHostingBindAddress(db, {
      serverId: 'srv-1',
      options: { bind: 'public' },
      ipId: 'ip-1',
    })
    assertEquals(result, '203.0.113.30')
  })

  it('treats a non-string datacenter address as missing', async () => {
    const db = {
      select() {
        return {
          from() {
            return {
              where() {
                return {
                  async limit() {
                    return [{ address: 10 }]
                  },
                }
              },
            }
          },
        }
      },
    } as Parameters<typeof resolveHostingBindAddress>[0]
    const result = await resolveHostingBindAddress(db, {
      serverId: 'srv-1',
      options: { bind: 'datacenter' },
      ipId: null,
    })
    assertEquals(result, {
      kind: 'datacenter_ip_required',
      serverId: 'srv-1',
    })
  })
})

describe('attachPrincipalsToTraditionalWebSites', () => {
  const principalId = '01936b3e-aaaa-bbbb-cccc-123456789abc'
  const serviceId = '01936b3e-4444-5555-6666-123456789abc'
  const site: TraditionalWebSiteSpec = {
    composeServiceName: 'site',
    engine: 'nginx',
    root: 'public',
    listenPort: 18080,
  }

  it('returns an empty list when there are no traditional-web sites', async () => {
    const db = createSelectWhereDb([])
    const result = await attachPrincipalsToTraditionalWebSites(
      db,
      'env-1',
      [],
      [],
      [],
    )
    assertEquals(result, [])
  })

  it('pins a sole assigned principal onto the site', async () => {
    const db = createSelectWhereDb([
      { principalId, serviceId },
    ])
    const result = await attachPrincipalsToTraditionalWebSites(
      db,
      'env-1',
      [{ id: serviceId, composeServiceName: 'site' }],
      [{
        principalId,
        username: 'appuser',
        home: principalHomeDir('appuser'),
        shell: '/bin/bash',
        uid: 10001,
        gid: 10001,
      }],
      [site],
    )
    if ('kind' in result) {
      throw new TypeError('expected pinned sites')
    }
    assertEquals(result.length, 1)
    assertEquals(result[0]?.principal, {
      principalId,
      username: 'appuser',
      uid: 10001,
      gid: 10001,
    })
  })

  it('omits principal when none are assigned', async () => {
    const db = createSelectWhereDb([])
    const result = await attachPrincipalsToTraditionalWebSites(
      db,
      'env-1',
      [{ id: serviceId, composeServiceName: 'site' }],
      [],
      [site],
    )
    if ('kind' in result) {
      throw new TypeError('expected sites without principal')
    }
    assertEquals(result[0]?.principal, undefined)
  })

  it('returns ambiguous when more than one principal is assigned', async () => {
    const db = createSelectWhereDb([
      { principalId, serviceId },
      { principalId: '01936b3e-bbbb-cccc-dddd-123456789abc', serviceId },
    ])
    const result = await attachPrincipalsToTraditionalWebSites(
      db,
      'env-1',
      [{ id: serviceId, composeServiceName: 'site' }],
      [],
      [site],
    )
    assertEquals(result, {
      kind: 'traditional_web_principal_ambiguous',
      composeServiceName: 'site',
    })
  })
})

describe('warningFromPrepareError and soft-error absorb', () => {
  it('maps every soft prepare error kind to a warning', () => {
    assertEquals(warningFromPrepareError({ kind: 'empty_compose' }), {
      code: 'empty_compose',
      message: 'Compose has no services to deploy.',
    })
    assertEquals(
      warningFromPrepareError({
        kind: 'resource_limit',
        violations: [{
          scope: 'organization',
          field: 'maxCpus',
          limit: 1,
          requested: 2,
        }],
      }).code,
      'resource_limit_exceeded',
    )
    assertEquals(
      warningFromPrepareError({
        kind: 'health_check',
        required: true,
        services: ['web'],
      }).message.includes('require'),
      true,
    )
    assertEquals(
      warningFromPrepareError({
        kind: 'health_check',
        required: false,
        services: ['web'],
      }).message.includes('warn'),
      true,
    )
    assertEquals(
      warningFromPrepareError({
        kind: 'docker_external_network_unregistered',
        names: ['edge'],
      }).details,
      { names: ['edge'] },
    )
    assertEquals(
      warningFromPrepareError({
        kind: 'traditional_web_principal_ambiguous',
        composeServiceName: 'site',
      }).code,
      'traditional_web_principal_ambiguous',
    )
  })

  it('absorbs soft errors only in preview mode', () => {
    const warnings: ReturnType<typeof warningFromPrepareError>[] = []
    assertEquals(
      absorbSoftPrepareError('deploy', warnings, { kind: 'empty_compose' }),
      { kind: 'empty_compose' },
    )
    assertEquals(warnings.length, 0)
    assertEquals(
      absorbSoftPrepareError('preview', warnings, { kind: 'empty_compose' }),
      null,
    )
    assertEquals(warnings.length, 1)
    assertEquals(absorbSoftPrepareError('preview', warnings, null), null)
    assertEquals(absorbSoftPrepareError('deploy', warnings), null)
  })

  it('emptyComposePrepareResult differs by mode', () => {
    assertEquals(emptyComposePrepareResult('deploy'), { kind: 'empty_compose' })
    const preview = emptyComposePrepareResult('preview')
    if (!preview || typeof preview !== 'object' || !('warnings' in preview)) {
      throw new TypeError('expected prepared compose')
    }
    assertEquals(preview.warnings[0]?.code, 'empty_compose')
    assertEquals(preview.composeYaml, 'services: {}\n')
  })
})

describe('evaluateHealthCheckGates and resourceLimitPrepareError', () => {
  const webDoc = assertComposeDocument(WEB_COMPOSE)

  it('returns required health_check when policy is required', () => {
    const options = buildServiceOptionsMap([
      { composeServiceName: 'web', options: { healthCheck: { policy: 'required' } } },
    ])
    assertEquals(evaluateHealthCheckGates(webDoc, options, false), {
      kind: 'health_check',
      required: true,
      services: ['web'],
    })
  })

  it('returns warn health_check unless acknowledged', () => {
    const options = buildServiceOptionsMap([
      { composeServiceName: 'web', options: { healthCheck: { policy: 'warn' } } },
    ])
    assertEquals(evaluateHealthCheckGates(webDoc, options, false), {
      kind: 'health_check',
      required: false,
      services: ['web'],
    })
    assertEquals(evaluateHealthCheckGates(webDoc, options, true), null)
  })

  it('returns resource_limit when org max services is exceeded', () => {
    const options = buildServiceOptionsMap([
      { composeServiceName: 'web', options: {} },
      { composeServiceName: 'api', options: {} },
    ])
    const err = resourceLimitPrepareError(
      options,
      2,
      { resourceLimits: { maxServicesPerEnvironment: 1 } },
      {},
    )
    if (!err || err.kind !== 'resource_limit') {
      throw new TypeError('expected resource_limit error')
    }
    assertEquals(err.violations.length > 0, true)
  })

  it('returns null when limits are satisfied', () => {
    const options = buildServiceOptionsMap([
      { composeServiceName: 'web', options: {} },
    ])
    assertEquals(
      resourceLimitPrepareError(options, 1, { resourceLimits: { maxServicesPerEnvironment: 5 } }, {}),
      null,
    )
  })
})

describe('compose list/split/expansion helpers', () => {
  it('lists compose service keys and container names', () => {
    const mixed = assertComposeDocument({
      version: 1,
      data: {
        services: {
          web: { image: 'nginx:latest' },
          site: {
            'x-turbopanel': {
              serviceKind: 'traditional-web',
              engine: 'nginx',
            },
          },
        },
      },
      presentation: { keyOrder: ['services'], comments: {} },
    })
    assertEquals(
      listComposeServiceKeys(mixed).sort((a, b) => a.localeCompare(b)),
      ['site', 'web'],
    )
    assertEquals([...listContainerComposeNames(mixed)], ['web'])
    assertEquals(listComposeServiceKeys(assertComposeDocument(EMPTY_COMPOSE)), [])
  })

  it('splits traditional-web sites and empties compose when only sites remain', () => {
    const sitesOnly = assertComposeDocument({
      version: 1,
      data: {
        services: {
          site: {
            'x-turbopanel': {
              serviceKind: 'traditional-web',
              engine: 'apache',
              root: 'html',
            },
          },
        },
        networks: {
          internal: {},
        },
      },
      presentation: { keyOrder: ['services', 'networks'], comments: {} },
    })
    const split = splitTraditionalWebFromDocument(sitesOnly)
    assertEquals(split.composeYaml, 'services: {}\n')
    assertEquals(split.sites.length, 1)
    assertEquals(split.sites[0]?.engine, 'apache')
    assertEquals(split.sites[0]?.root, 'html')
  })

  it('keeps container services and prunes networks only used by traditional-web', () => {
    const mixed = assertComposeDocument({
      version: 1,
      data: {
        services: {
          web: {
            image: 'nginx:latest',
            networks: ['shared'],
          },
          site: {
            'x-turbopanel': {
              serviceKind: 'traditional-web',
              engine: 'nginx',
            },
            networks: ['tw-only'],
          },
        },
        networks: {
          shared: {},
          'tw-only': {},
        },
      },
      presentation: { keyOrder: ['services', 'networks'], comments: {} },
    })
    const split = splitTraditionalWebFromDocument(mixed)
    assertEquals(split.composeYaml.includes('nginx:latest'), true)
    assertEquals(split.composeYaml.includes('traditional-web'), false)
    assertEquals(split.composeYaml.includes('tw-only'), false)
    assertEquals(split.composeYaml.includes('shared'), true)
    assertEquals(split.sites[0]?.composeServiceName, 'site')
  })

  it('builds expansion maps and clone name indexes', () => {
    const serviceRows = [
      { id: 'svc-web', composeServiceName: 'web', options: { instances: 2 } },
      { id: 'svc-api', composeServiceName: 'api', options: {} },
    ]
    const expansion = new Map([
      ['web', ['web-1', 'web-2']],
      ['api', ['api']],
    ])
    assertEquals(expansionToRecord(expansion), {
      web: ['web-1', 'web-2'],
      api: ['api'],
    })
    assertEquals(
      buildCloneNamesByServiceId(serviceRows, expansion).get('svc-web'),
      ['web-1', 'web-2'],
    )
    assertEquals(
      buildServiceRowByCloneName(serviceRows, expansion).get('web-2')?.id,
      'svc-web',
    )

    const options = buildExpandedServiceOptionsMap(
      serviceRows,
      expansion,
      [{
        serviceId: 'svc-web',
        composeServiceName: 'web',
        cloneComposeServiceName: 'web-1',
        containerRowId: 'ctr-1',
        containerName: 'web-container-1',
        ordinal: 1,
        instances: 2,
      }],
    )
    assertEquals(options.get('web-1')?.container?.name, 'web-container-1')
    assertEquals(options.get('web-2')?.container?.name, undefined)

    const instances = buildInstancesByComposeName(
      ['web', 'api', 'site'],
      [{
        serviceId: 'svc-web',
        composeServiceName: 'web',
        instances: 2,
      }],
      [
        ...serviceRows,
        { id: 'svc-site', composeServiceName: 'site', options: {} },
      ],
    )
    assertEquals(instances.get('web'), 2)
    assertEquals(instances.get('api'), 1)
    assertEquals(instances.get('site'), 1)
  })

  it('appends platform variables after stripping reserved keys', () => {
    const perService = new Map([
      ['web', [{
        key: 'TURBOPANEL_PROJECT_ID',
        value: 'stolen',
        isSecret: false,
        isLiteral: true,
        forBuild: false,
        forRuntime: true,
      }, {
        key: 'APP_ENV',
        value: 'prod',
        isSecret: false,
        isLiteral: true,
        forBuild: false,
        forRuntime: true,
      }]],
    ])
    const next = appendPlatformVariablesToEntries(perService, {
      projectId: 'proj-1',
      environmentId: 'env-1',
      serviceRowByCloneName: new Map([
        ['web', { id: 'svc-web', composeServiceName: 'web', options: {} }],
      ]),
      allocationByClone: new Map([
        ['web', {
          serviceId: 'svc-web',
          composeServiceName: 'web',
          cloneComposeServiceName: 'web',
          containerRowId: 'ctr-1',
          containerName: 'web-name',
          ordinal: 1,
          instances: 1,
        }],
      ]),
    })
    const keys = (next.get('web') ?? []).map((entry) => entry.key)
    assertEquals(keys.includes('APP_ENV'), true)
    assertEquals(keys.includes('TURBOPANEL_PROJECT_ID'), true)
    assertEquals(
      (next.get('web') ?? []).filter((entry) => entry.key === 'TURBOPANEL_PROJECT_ID').length,
      1,
    )
    assertEquals(
      (next.get('web') ?? []).find((entry) => entry.key === 'TURBOPANEL_PROJECT_ID')?.value,
      'proj-1',
    )
  })
})

describe('resolveTraditionalWebSitesForMode and toPreparedDeployResult', () => {
  const site: TraditionalWebSiteSpec = {
    composeServiceName: 'site',
    engine: 'nginx',
    root: 'public',
    listenPort: 18080,
  }

  it('returns sites in deploy mode and softens ambiguous in preview', () => {
    const warnings: ReturnType<typeof warningFromPrepareError>[] = []
    const ok = resolveTraditionalWebSitesForMode(
      'deploy',
      warnings,
      [{ ...site }],
      [site],
    )
    assertEquals(ok, [{ ...site }])

    const err = resolveTraditionalWebSitesForMode(
      'deploy',
      warnings,
      { kind: 'traditional_web_principal_ambiguous', composeServiceName: 'site' },
      [site],
    )
    assertEquals(err, {
      kind: 'traditional_web_principal_ambiguous',
      composeServiceName: 'site',
    })

    const preview = resolveTraditionalWebSitesForMode(
      'preview',
      warnings,
      { kind: 'traditional_web_principal_ambiguous', composeServiceName: 'site' },
      [site],
    )
    assertEquals(preview, [{ ...site }])
    assertEquals(warnings[0]?.code, 'traditional_web_principal_ambiguous')
  })

  it('redacts secret materials in preview prepared results', () => {
    const expansion = new Map([['web', ['web']]])
    const prepared = toPreparedDeployResult('preview', {
      composeYaml: 'services: {}\n',
      hooks: [],
      variableMaterial: [{
        key: 'SECRET',
        composeServiceName: 'web',
        forBuild: false,
        forRuntime: true,
        isLiteral: false,
        valueEnvelope: 'tp1.sealed',
      }],
      storageMaterial: [{
        storageId: 'st-1',
        kind: 'docker_volume',
        name: 'data',
        serverId: 'srv-1',
        volumeName: 'st-1',
      }],
      principalMaterial: [],
      traditionalWebSites: [],
      dockerExternalNetworks: [],
      containers: [],
      ingressServices: [],
      expansion,
      registeredVolumes: [],
      warnings: [],
    })
    assertEquals(prepared.variableMaterial, [])
    assertEquals(prepared.storageMaterial, [])
    assertEquals(prepared.composeServiceExpansion, { web: ['web'] })
  })

  it('keeps materials for deploy mode', () => {
    const prepared = toPreparedDeployResult('deploy', {
      composeYaml: 'services: {}\n',
      hooks: [],
      variableMaterial: [{
        key: 'SECRET',
        composeServiceName: null,
        forBuild: false,
        forRuntime: true,
        isLiteral: false,
        valueEnvelope: 'tp1.sealed',
      }],
      storageMaterial: [{
        storageId: 'st-1',
        kind: 'docker_volume',
        name: 'data',
        serverId: 'srv-1',
        volumeName: 'st-1',
      }],
      principalMaterial: [],
      traditionalWebSites: [],
      dockerExternalNetworks: ['edge'],
      containers: [],
      ingressServices: [],
      expansion: new Map(),
      registeredVolumes: [],
      warnings: [],
    })
    assertEquals(prepared.variableMaterial.length, 1)
    assertEquals(prepared.storageMaterial.length, 1)
    assertEquals(prepared.dockerExternalNetworks, ['edge'])
  })

  it('injects secret placeholders only in preview documentForServiceOptions', () => {
    const doc = assertComposeDocument(WEB_COMPOSE)
    const withVariables = {
      document: doc,
      secretMaterial: [{
        key: 'DB_PASSWORD',
        composeServiceName: 'web',
        forBuild: false,
        forRuntime: true,
        isLiteral: false,
        valueEnvelope: 'tp1.envelope',
      }],
    }
    const previewDoc = documentForServiceOptions('preview', withVariables)
    const deployDoc = documentForServiceOptions('deploy', withVariables)
    assertEquals(deployDoc, doc)
    assertEquals(previewDoc === doc, false)
  })
})

describe('resourceLimitPrepareError server scope', () => {
  it('returns null when server limits are unset', () => {
    const options = buildServiceOptionsMap([
      { composeServiceName: 'web', options: { resources: { cpus: 0.5 } } },
    ])
    assertEquals(
      resourceLimitPrepareError(options, 1, {}, {}),
      null,
    )
  })

  it('violates server maxCpus when usage exceeds server cap', () => {
    const options = buildServiceOptionsMap([
      { composeServiceName: 'web', options: { resources: { cpus: 4 } } },
    ])
    const err = resourceLimitPrepareError(
      options,
      1,
      {},
      { resourceLimits: { maxCpus: 2 } },
    )
    if (!err || err.kind !== 'resource_limit') {
      throw new TypeError('expected resource_limit error')
    }
    assertEquals(
      err.violations.some((v) => v.scope === 'server' && v.field === 'maxCpus'),
      true,
    )
  })
})

describe('appendPlatformVariablesToEntries without service row', () => {
  it('strips reserved keys and skips platform vars when clone has no service row', () => {
    const perService = new Map([
      ['orphan', [{
        key: 'TURBOPANEL_ENVIRONMENT_ID',
        value: 'stolen-env',
        isSecret: false,
        isLiteral: true,
        forBuild: false,
        forRuntime: true,
      }, {
        key: 'CUSTOM',
        value: 'ok',
        isSecret: false,
        isLiteral: true,
        forBuild: false,
        forRuntime: true,
      }]],
    ])
    const next = appendPlatformVariablesToEntries(perService, {
      projectId: 'proj-1',
      environmentId: 'env-1',
      serviceRowByCloneName: new Map(),
      allocationByClone: new Map(),
    })
    const keys = (next.get('orphan') ?? []).map((entry) => entry.key)
    assertEquals(keys, ['CUSTOM'])
    assertEquals(keys.includes('TURBOPANEL_ENVIRONMENT_ID'), false)
  })
})

describe('attachPrincipalsToTraditionalWebSites edge cases', () => {
  const site: TraditionalWebSiteSpec = {
    composeServiceName: 'site',
    engine: 'nginx',
    root: 'public',
    listenPort: 18080,
  }
  const serviceId = '01936b3e-4444-5555-6666-123456789abc'
  const principalId = '01936b3e-aaaa-bbbb-cccc-123456789abc'

  it('omits principal when assigned id is missing from material map', async () => {
    const db = createSelectWhereDb([{ principalId, serviceId }])
    const result = await attachPrincipalsToTraditionalWebSites(
      db,
      'env-1',
      [{ id: serviceId, composeServiceName: 'site' }],
      [],
      [site],
    )
    if ('kind' in result) {
      throw new TypeError('expected sites without principal pin')
    }
    assertEquals(result[0]?.principal, undefined)
  })

  it('handles site with no matching service row', async () => {
    const db = createSelectWhereDb([])
    const result = await attachPrincipalsToTraditionalWebSites(
      db,
      'env-1',
      [],
      [],
      [site],
    )
    if ('kind' in result) {
      throw new TypeError('expected sites')
    }
    assertEquals(result[0]?.composeServiceName, 'site')
    assertEquals(result[0]?.principal, undefined)
  })
})

describe('splitTraditionalWebFromDocument without networks key', () => {
  it('keeps container yaml when traditional-web is absent', () => {
    const doc = assertComposeDocument(WEB_API_COMPOSE)
    const split = splitTraditionalWebFromDocument(doc)
    assertEquals(split.sites.length, 0)
    assertEquals(split.composeYaml.includes('nginx:latest'), true)
    assertEquals(split.composeYaml.includes('node:22'), true)
    assertEquals(split.composeYaml.includes('networks:'), false)
  })
})
