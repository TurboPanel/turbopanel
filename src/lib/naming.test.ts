import { assertEquals, assertThrows } from 'jsr:@std/assert'
import {
  INGRESS_CONTAINER_NAME_SUFFIX,
  PRINCIPAL_HOME_ROOT,
  PRINCIPAL_UID_START,
  RESERVED_DEPLOY_VARIABLE_KEYS,
  containerNameFromService,
  dockerVolumeNameFromStorageId,
  ingressContainerNameFromService,
  isReservedDeployVariableKey,
  isValidDockerResourceName,
  legacyNamespacedDockerVolumeName,
  managedContainerName,
  managedIngressComposeServiceName,
  principalHomeDir,
  principalSshDir,
  principalVolumePath,
  principalVolumesDir,
  resolveDockerVolumeName,
  serviceDnsName,
} from './naming.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('isValidDockerResourceName matches Docker Engine allowlist', () => {
  assertEquals(isValidDockerResourceName('a'), true)
  assertEquals(
    isValidDockerResourceName('01936b3e-8c7a-7b2d-a1f0-123456789abc'),
    true,
  )
  assertEquals(isValidDockerResourceName('-bad'), false)
  assertEquals(isValidDockerResourceName('has space'), false)
})

test('containerNameFromService uses bare service id for single instance', () => {
  assertEquals(
    containerNameFromService({
      serviceId: 'sid-1',
      ordinal: 1,
      instanceCount: 1,
    }),
    'sid-1',
  )
})

test('containerNameFromService suffixes ordinal when multi-instance', () => {
  assertEquals(
    containerNameFromService({
      serviceId: 'sid-1',
      ordinal: 2,
      instanceCount: 3,
    }),
    'sid-1-2',
  )
})

test('managedContainerName always carries ordinal suffix on service id', () => {
  assertEquals(managedContainerName('sid-1'), 'sid-1-1')
})

test('INGRESS_CONTAINER_NAME_SUFFIX is -ingress', () => {
  assertEquals(INGRESS_CONTAINER_NAME_SUFFIX, '-ingress')
})

test('ingressContainerNameFromService appends -ingress to a valid service id', () => {
  const id = '01936b3e-8c7a-7b2d-a1f0-123456789abc'
  assertEquals(ingressContainerNameFromService(id), `${id}-ingress`)
})

test('ingressContainerNameFromService rejects invalid service ids', () => {
  assertThrows(
    () => ingressContainerNameFromService('has space'),
    TypeError,
    'Invalid ingress container name for service id',
  )
  assertThrows(
    () => ingressContainerNameFromService('-bad'),
    TypeError,
    'Invalid ingress container name for service id',
  )
})

test('managedIngressComposeServiceName appends -ingress to the engine compose key', () => {
  assertEquals(managedIngressComposeServiceName('postgres'), 'postgres-ingress')
})

test('dockerVolumeNameFromStorageId returns the storage UUID', () => {
  const id = '01936b3e-8c7a-7b2d-a1f0-123456789abc'
  assertEquals(dockerVolumeNameFromStorageId(id), id)
})

test('dockerVolumeNameFromStorageId rejects invalid ids', () => {
  assertThrows(
    () => dockerVolumeNameFromStorageId('-bad'),
    TypeError,
    'Invalid Docker volume storage id',
  )
})

test('legacyNamespacedDockerVolumeName mirrors daemon tp-<org8>-<name>', () => {
  assertEquals(
    legacyNamespacedDockerVolumeName('01936b3e-8c7a-7b2d-a1f0-123456789abc', 'cache'),
    'tp-01936b3e-cache',
  )
})

test('resolveDockerVolumeName prefers pinnedName', () => {
  const storageId = '01936b3e-8c7a-7b2d-a1f0-123456789abc'
  assertEquals(
    resolveDockerVolumeName({
      storageId,
      organizationId: 'org-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      name: 'cache',
      pinnedName: storageId,
    }),
    storageId,
  )
})

test('resolveDockerVolumeName falls back to legacy when unpinned', () => {
  assertEquals(
    resolveDockerVolumeName({
      storageId: '01936b3e-8c7a-7b2d-a1f0-123456789abc',
      organizationId: '01936b3e-8c7a-7b2d-a1f0-abcdef012345',
      name: 'data',
    }),
    'tp-01936b3e-data',
  )
})

test('principal path helpers nest under PRINCIPAL_HOME_ROOT', () => {
  const id = '01936b3e-8c7a-7b2d-a1f0-123456789abc'
  const storageId = '01936b3e-8c7a-7b2d-a1f0-abcdef012345'
  assertEquals(PRINCIPAL_UID_START, 10001)
  assertEquals(principalHomeDir(id), `${PRINCIPAL_HOME_ROOT}/${id}`)
  assertEquals(principalSshDir(id), `${PRINCIPAL_HOME_ROOT}/${id}/.ssh`)
  assertEquals(principalVolumesDir(id), `${PRINCIPAL_HOME_ROOT}/${id}/volumes`)
  assertEquals(
    principalVolumePath(id, storageId),
    `${PRINCIPAL_HOME_ROOT}/${id}/volumes/${storageId}`,
  )
})

test('principal path helpers reject path-escaping ids', () => {
  assertThrows(() => principalHomeDir(''), TypeError)
  assertThrows(() => principalHomeDir('../etc'), TypeError)
  assertThrows(() => principalHomeDir('a/b'), TypeError)
  assertThrows(() => principalVolumePath('ok-id', '../x'), TypeError)
})

test('serviceDnsName is most-specific-first (container then project)', () => {
  assertEquals(serviceDnsName('project-id', 'container-id'), 'container-id.project-id')
})

test('RESERVED_DEPLOY_VARIABLE_KEYS covers tenant-deploy reserved keys', () => {
  const expected = [
    'TURBOPANEL_CONTAINER_ID',
    'TURBOPANEL_CONTAINER_NAME',
    'TURBOPANEL_ENVIRONMENT_ID',
    'TURBOPANEL_PROJECT_ID',
    'TURBOPANEL_SERVICE_HOST',
    'TURBOPANEL_SERVICE_ID',
  ]
  assertEquals([...RESERVED_DEPLOY_VARIABLE_KEYS].sort((a, b) => a.localeCompare(b)), expected)
  for (const key of expected) {
    assertEquals(isReservedDeployVariableKey(key), true)
  }
  assertEquals(isReservedDeployVariableKey('MY_APP_KEY'), false)
})
