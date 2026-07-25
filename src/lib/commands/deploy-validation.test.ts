import { assertEquals } from 'jsr:@std/assert'
import { describe, it } from '@std/testing/bdd'
import {
  validateDeployHostings,
  validateDeployHostnameRouting,
  validateDeployPathPrefix,
  validateDeployStorageMaterialList,
  validateDeployTargetPort,
} from '../../lib/commands/deploy-validation.ts'

describe('deploy-validation', () => {
  it('rejects pathPrefix without leading slash', () => {
    assertEquals(validateDeployPathPrefix('/api'), true)
    assertEquals(validateDeployPathPrefix('api'), false)
  })

  it('rejects invalid targetPort values', () => {
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

  it('requires composeServiceName for bind mounts in storage material', () => {
    const error = validateDeployStorageMaterialList([{
      storageId: 'st1',
      kind: 'bind_mount',
      name: 'data',
      destinationPath: '/data',
      serverId: 'srv1',
    }])
    assertEquals(error, 'storage st1 missing composeServiceName for mount')
  })
})
