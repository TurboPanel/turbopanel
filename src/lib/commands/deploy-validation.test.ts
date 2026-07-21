import { assertEquals } from 'jsr:@std/assert'
import { describe, it } from '@std/testing/bdd'
import {
  validateDeployHostings,
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
