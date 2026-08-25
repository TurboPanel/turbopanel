import { assertEquals } from '@std/assert'
import { describe, it } from '@std/testing/bdd'
import type { EnvironmentDeployStorageMaterial } from '../../lib/commands/schemas.ts'
import {
  normalizeDeployPathPrefix,
  pathPrefixHasUnsupportedCharacters,
  validateDeployHostingEntry,
  validateDeployHostings,
  validateDeployHostnameRouting,
  validateDeployPathPrefix,
  validateDeployStorageMaterial,
  validateDeployStorageMaterialList,
  validateDeployTargetPort,
} from '../../lib/commands/deploy-validation.ts'

describe('deploy-validation', () => {
  it('rejects pathPrefix without leading slash', () => {
    assertEquals(validateDeployPathPrefix(undefined), true)
    assertEquals(validateDeployPathPrefix('/api'), true)
    assertEquals(validateDeployPathPrefix('api'), false)
  })

  it('rejects invalid targetPort values', () => {
    assertEquals(validateDeployTargetPort(undefined), true)
    assertEquals(validateDeployTargetPort(8080), true)
    assertEquals(validateDeployTargetPort(0), false)
    assertEquals(validateDeployTargetPort(70_000), false)
  })

  it('validates hostnames on deploy hostings', () => {
    const error = validateDeployHostings([{
      hostingId: 'h1',
      serviceId: 's1',
      composeServiceName: 'web',
      hostnames: ['not a hostname'],
      pathPrefix: '/',
      targetPort: 80,
    }])
    assertEquals(typeof error, 'string')
  })

  it('accepts a tcp hosting with ports and no hostnames', () => {
    const error = validateDeployHostings([{
      hostingId: 'h1',
      serviceId: 's1',
      composeServiceName: 'db',
      hostnames: [],
      protocol: 'tcp',
      ports: [{ published: 5432, target: 5432 }],
    }])
    assertEquals(error, null)
  })

  it('rejects a tcp/udp hosting with no ports', () => {
    const error = validateDeployHostings([{
      hostingId: 'h1',
      serviceId: 's1',
      composeServiceName: 'db',
      hostnames: [],
      protocol: 'udp',
      ports: [],
    }])
    assertEquals(typeof error, 'string')
  })

  it('rejects out-of-range ports on tcp/udp hostings', () => {
    const error = validateDeployHostings([{
      hostingId: 'h1',
      serviceId: 's1',
      composeServiceName: 'db',
      hostnames: [],
      protocol: 'tcp',
      ports: [{ published: 0, target: 5432 }],
    }])
    assertEquals(typeof error, 'string')
    assertEquals(
      validateDeployHostings([{
        hostingId: 'h1',
        serviceId: 's1',
        composeServiceName: 'db',
        hostnames: [],
        protocol: 'udp',
        ports: [{ published: 8080, target: 70_000 }],
      }]),
      'hostings[].ports entries must be integers between 1 and 65535',
    )
  })

  it('rejects duplicate catch-all hostings on the same hostname', () => {
    const error = validateDeployHostnameRouting([
      {
        hostingId: 'h1',
        serviceId: 's1',
        composeServiceName: 'static',
        hostnames: ['app.example.com'],
      },
      {
        hostingId: 'h2',
        serviceId: 's2',
        composeServiceName: 'api',
        hostnames: ['app.example.com'],
      },
    ])
    assertEquals(error, 'multiple catch-all hostings for hostname app.example.com')
  })

  it('accepts split path and catch-all hostings on the same hostname', () => {
    const error = validateDeployHostnameRouting([
      {
        hostingId: 'h1',
        serviceId: 's1',
        composeServiceName: 'static',
        hostnames: ['app.example.com'],
      },
      {
        hostingId: 'h2',
        serviceId: 's2',
        composeServiceName: 'php',
        hostnames: ['app.example.com'],
        pathPrefix: '/php',
      },
    ])
    assertEquals(error, null)
  })

  it('requires composeServiceName for path mounts in storage material', () => {
    const error = validateDeployStorageMaterialList([{
      storageId: 'st1',
      locationId: 'loc1',
      kind: 'directory',
      name: 'data',
      provider: 'path',
      serverId: 'srv1',
      mounts: [{ destinationPath: '/data' }],
    }])
    assertEquals(error, 'storage st1 missing composeServiceName for mount')
  })

  it('requires volume volumeName and validates shape', () => {
    assertEquals(
      validateDeployStorageMaterialList([{
        storageId: 'st-vol',
        locationId: 'loc-vol',
        kind: 'volume',
        name: 'data',
        provider: 'docker',
        serverId: 'srv1',
        volumeName: '01936b3e-8c7a-7b2d-a1f0-123456789abc',
        mounts: [],
      }]),
      null,
    )
    assertEquals(
      validateDeployStorageMaterialList([{
        storageId: 'st-vol',
        locationId: 'loc-vol',
        kind: 'volume',
        name: 'data',
        provider: 'docker',
        serverId: 'srv1',
        mounts: [],
      }]),
      'storage st-vol missing volumeName',
    )
    assertEquals(
      validateDeployStorageMaterialList([{
        storageId: 'st-vol',
        locationId: 'loc-vol',
        kind: 'volume',
        name: 'data',
        provider: 'docker',
        serverId: 'srv1',
        volumeName: '-bad',
        mounts: [],
      }]),
      'storage st-vol has invalid volumeName',
    )
  })

  it('requires destinationPath on each mount', () => {
    assertEquals(
      validateDeployStorageMaterialList([{
        storageId: 'st1',
        locationId: 'loc1',
        kind: 'directory',
        name: 'data',
        provider: 'path',
        serverId: 'srv1',
        mounts: [{ composeServiceName: 'web', destinationPath: '' }],
      }]),
      'storage st1 mount missing destinationPath',
    )
  })

  it('normalizeDeployPathPrefix treats slash and blank as catch-all', () => {
    assertEquals(normalizeDeployPathPrefix(undefined), undefined)
    assertEquals(normalizeDeployPathPrefix('/'), undefined)
    assertEquals(normalizeDeployPathPrefix('  '), undefined)
    assertEquals(normalizeDeployPathPrefix('/api'), '/api')
  })

  it('pathPrefixHasUnsupportedCharacters flags backticks and newlines', () => {
    assertEquals(pathPrefixHasUnsupportedCharacters('/api'), false)
    assertEquals(pathPrefixHasUnsupportedCharacters('/`api'), true)
    assertEquals(pathPrefixHasUnsupportedCharacters('/api\n'), true)
    assertEquals(pathPrefixHasUnsupportedCharacters('/api\r'), true)
  })

  it('rejects duplicate pathPrefix on the same hostname', () => {
    const error = validateDeployHostnameRouting([
      {
        hostingId: 'h1',
        serviceId: 's1',
        composeServiceName: 'api',
        hostnames: ['app.example.com'],
        pathPrefix: '/api',
      },
      {
        hostingId: 'h2',
        serviceId: 's2',
        composeServiceName: 'api2',
        hostnames: ['app.example.com'],
        pathPrefix: '/api',
      },
    ])
    assertEquals(error, 'duplicate pathPrefix /api for hostname app.example.com')
  })

  it('rejects conflicting bindAddress on the same hostname', () => {
    const error = validateDeployHostnameRouting([
      {
        hostingId: 'h1',
        serviceId: 's1',
        composeServiceName: 'static',
        hostnames: ['app.example.com'],
        bindAddress: '203.0.113.10',
      },
      {
        hostingId: 'h2',
        serviceId: 's2',
        composeServiceName: 'api',
        hostnames: ['app.example.com'],
        bindAddress: '203.0.113.11',
      },
    ])
    assertEquals(error, 'conflicting bindAddress for hostname app.example.com')
  })

  it('rejects invalid storage kind', () => {
    assertEquals(
      validateDeployStorageMaterialList([{
        storageId: 'st1',
        kind: 'unknown_kind' as EnvironmentDeployStorageMaterial['kind'],
        locationId: 'loc1',
        name: 'data',
        provider: 'path',
        serverId: 'srv1',
        mounts: [{ composeServiceName: 'web', destinationPath: '/data' }],
      }]),
      'invalid storage kind: unknown_kind',
    )
  })

  it('rejects invalid storage provider and kind/provider mismatches', () => {
    assertEquals(
      validateDeployStorageMaterial({
        storageId: 'st1',
        locationId: 'loc1',
        kind: 'directory',
        name: 'data',
        provider: 'bogus' as EnvironmentDeployStorageMaterial['provider'],
        serverId: 'srv1',
        mounts: [],
      }),
      'invalid storage provider: bogus',
    )
    assertEquals(
      validateDeployStorageMaterial({
        storageId: 'st-vol',
        locationId: 'loc-vol',
        kind: 'volume',
        name: 'data',
        provider: 'path',
        serverId: 'srv1',
        mounts: [],
      }),
      'storage st-vol volume kind requires docker provider',
    )
    assertEquals(
      validateDeployStorageMaterial({
        storageId: 'st-dir',
        locationId: 'loc-dir',
        kind: 'directory',
        name: 'data',
        provider: 'docker',
        serverId: 'srv1',
        volumeName: '01936b3e-8c7a-7b2d-a1f0-123456789abc',
        mounts: [],
      }),
      'storage st-dir directory kind requires path provider',
    )
  })

  it('accepts valid path-backed file storage material', () => {
    assertEquals(
      validateDeployStorageMaterial({
        storageId: 'st-file',
        locationId: 'loc-file',
        kind: 'file',
        name: 'config',
        provider: 'path',
        serverId: 'srv1',
        mounts: [{ composeServiceName: 'web', destinationPath: '/etc/config' }],
      }),
      null,
    )
  })

  it('rejects http hostings with invalid pathPrefix', () => {
    assertEquals(
      validateDeployHostingEntry({
        hostingId: 'h1',
        serviceId: 's1',
        composeServiceName: 'web',
        hostnames: ['app.example.com'],
        pathPrefix: 'api',
      }),
      'pathPrefix must start with /',
    )
  })

  it('accepts a valid http hosting entry', () => {
    assertEquals(
      validateDeployHostingEntry({
        hostingId: 'h1',
        serviceId: 's1',
        composeServiceName: 'web',
        hostnames: ['app.example.com'],
        pathPrefix: '/',
        targetPort: 8080,
      }),
      null,
    )
  })

  it('accepts valid http hostings through validateDeployHostings', () => {
    assertEquals(
      validateDeployHostings([{
        hostingId: 'h1',
        serviceId: 's1',
        composeServiceName: 'web',
        hostnames: ['app.example.com'],
        targetPort: 443,
      }]),
      null,
    )
  })

  it('rejects hostname routing when pathPrefix has unsupported characters', () => {
    const error = validateDeployHostnameRouting([
      {
        hostingId: 'h1',
        serviceId: 's1',
        composeServiceName: 'api',
        hostnames: ['app.example.com'],
        pathPrefix: '/`api',
      },
    ])
    assertEquals(error, 'pathPrefix contains unsupported characters for hostname app.example.com')
  })

  it('rejects hostname routing when pathPrefix omits the leading slash', () => {
    const error = validateDeployHostnameRouting([
      {
        hostingId: 'h1',
        serviceId: 's1',
        composeServiceName: 'api',
        hostnames: ['app.example.com'],
        pathPrefix: 'api',
      },
    ])
    assertEquals(error, 'pathPrefix must start with /')
  })

  it('ignores tcp and udp hostings in hostname routing', () => {
    assertEquals(
      validateDeployHostnameRouting([
        {
          hostingId: 'h1',
          serviceId: 's1',
          composeServiceName: 'db',
          hostnames: ['ignored.example.com'],
          protocol: 'tcp',
          ports: [{ published: 5432, target: 5432 }],
        },
        {
          hostingId: 'h2',
          serviceId: 's2',
          composeServiceName: 'game',
          hostnames: ['also-ignored.example.com'],
          protocol: 'udp',
          ports: [{ published: 19132, target: 19132 }],
        },
      ]),
      null,
    )
  })

  it('accepts matching bindAddress on the same hostname', () => {
    assertEquals(
      validateDeployHostnameRouting([
        {
          hostingId: 'h1',
          serviceId: 's1',
          composeServiceName: 'static',
          hostnames: ['app.example.com'],
          bindAddress: '203.0.113.10',
        },
        {
          hostingId: 'h2',
          serviceId: 's2',
          composeServiceName: 'api',
          hostnames: ['app.example.com'],
          pathPrefix: '/api',
          bindAddress: '203.0.113.10',
        },
      ]),
      null,
    )
  })

  it('rejects http hostings with invalid targetPort', () => {
    const error = validateDeployHostings([{
      hostingId: 'h1',
      serviceId: 's1',
      composeServiceName: 'web',
      hostnames: ['app.example.com'],
      targetPort: 0,
    }])
    assertEquals(error, 'targetPort must be an integer between 1 and 65535')
  })
})
