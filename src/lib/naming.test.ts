import { assertEquals, assertThrows } from '@std/assert'
import {
  INGRESS_CONTAINER_NAME_SUFFIX,
  PRINCIPAL_HOME_ROOT,
  PRINCIPAL_RESERVED_UID_MAX,
  PRINCIPAL_RESERVED_UID_MIN,
  PRINCIPAL_UID_START,
  PRINCIPAL_UNIX_GROUP_SUFFIX,
  MAX_PRINCIPAL_USERNAME_LENGTH,
  RESERVED_DEPLOY_VARIABLE_KEYS,
  RESERVED_PRINCIPAL_USERNAMES,
  assertSafeBindingKeyPrefix,
  assertSafePrincipalUsername,
  bindingPrefixedKeys,
  DEFAULT_BINDING_KEY_PREFIX,
  containerNameFromService,
  dockerVolumeNameFromStorageId,
  ingressContainerNameFromService,
  isReservedDeployVariableKey,
  isReservedPrincipalUsername,
  isValidDockerResourceName,
  managedContainerName,
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
  assertEquals(managedContainerName('sid-1', 2), 'sid-1-2')
  assertEquals(managedContainerName('sid-1', 3), 'sid-1-3')
})

test('managedContainerName rejects non-positive ordinals', () => {
  assertThrows(() => managedContainerName('sid-1', 0), TypeError)
  assertThrows(() => managedContainerName('sid-1', 1.5), TypeError)
  assertThrows(() => managedContainerName('has space', 1), TypeError)
})

test('INGRESS_CONTAINER_NAME_SUFFIX is -in', () => {
  assertEquals(INGRESS_CONTAINER_NAME_SUFFIX, '-in')
})

test('ingressContainerNameFromService appends -in to a valid service id', () => {
  const id = '01936b3e-8c7a-7b2d-a1f0-123456789abc'
  assertEquals(ingressContainerNameFromService(id), `${id}-in`)
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

test('managed-ingress container name is ingressContainerNameFromService (shared -in contract)', () => {
  const serviceId = '01936b3e-8c7a-7b2d-a1f0-123456789abc'
  assertEquals(
    ingressContainerNameFromService(serviceId),
    `${serviceId}-in`,
  )
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

test('resolveDockerVolumeName prefers pinnedName', () => {
  const storageId = '01936b3e-8c7a-7b2d-a1f0-123456789abc'
  assertEquals(
    resolveDockerVolumeName({
      storageId,
      pinnedName: storageId,
    }),
    storageId,
  )
})

test('resolveDockerVolumeName uses storage UUID when unpinned', () => {
  const storageId = '01936b3e-8c7a-7b2d-a1f0-123456789abc'
  assertEquals(
    resolveDockerVolumeName({ storageId }),
    storageId,
  )
})

test('principal path helpers nest under PRINCIPAL_HOME_ROOT by username', () => {
  const username = 'appuser'
  const storageId = '01936b3e-8c7a-7b2d-a1f0-abcdef012345'
  assertEquals(PRINCIPAL_UID_START, 10001)
  assertEquals(PRINCIPAL_RESERVED_UID_MIN, 9989)
  assertEquals(PRINCIPAL_RESERVED_UID_MAX, 9999)
  assertEquals(principalHomeDir(username), `${PRINCIPAL_HOME_ROOT}/${username}`)
  assertEquals(principalSshDir(username), `${PRINCIPAL_HOME_ROOT}/${username}/.ssh`)
  assertEquals(principalVolumesDir(username), `${PRINCIPAL_HOME_ROOT}/${username}/volumes`)
  assertEquals(
    principalVolumePath(username, storageId),
    `${PRINCIPAL_HOME_ROOT}/${username}/volumes/${storageId}`,
  )
})

test('principal path helpers reject invalid usernames', () => {
  assertThrows(() => principalHomeDir(''), TypeError)
  assertThrows(() => principalHomeDir('../etc'), TypeError)
  assertThrows(() => principalHomeDir('a/b'), TypeError)
  assertThrows(
    () => assertSafePrincipalUsername('a'.repeat(MAX_PRINCIPAL_USERNAME_LENGTH + 1)),
    TypeError,
  )
  assertThrows(() => principalVolumePath('ok_user', '../x'), TypeError)
})

test('assertSafePrincipalUsername accepts max length that fits username-grp', () => {
  assertEquals(
    MAX_PRINCIPAL_USERNAME_LENGTH + PRINCIPAL_UNIX_GROUP_SUFFIX.length,
    32,
  )
  const longest = `u${'a'.repeat(MAX_PRINCIPAL_USERNAME_LENGTH - 1)}`
  assertEquals(longest.length, MAX_PRINCIPAL_USERNAME_LENGTH)
  assertEquals(assertSafePrincipalUsername(longest), longest)
  assertEquals(
    `${longest}${PRINCIPAL_UNIX_GROUP_SUFFIX}`.length,
    32,
  )

  const overlong = `u${'a'.repeat(MAX_PRINCIPAL_USERNAME_LENGTH)}`
  assertEquals(overlong.length, MAX_PRINCIPAL_USERNAME_LENGTH + 1)
  assertThrows(() => assertSafePrincipalUsername(overlong), TypeError)
})

test('isReservedPrincipalUsername covers denylist and systemd- prefix', () => {
  assertEquals(RESERVED_PRINCIPAL_USERNAMES.has('root'), true)
  assertEquals(isReservedPrincipalUsername('root'), true)
  assertEquals(isReservedPrincipalUsername(' www-data '), true)
  assertEquals(isReservedPrincipalUsername('TPCTRL'), true)
  assertEquals(isReservedPrincipalUsername('systemd-network'), true)
  assertEquals(isReservedPrincipalUsername('appuser'), false)
})

test('serviceDnsName is most-specific-first (replica then service)', () => {
  assertEquals(
    serviceDnsName('web', 1, 'env-1'),
    ['web-1.env-1', 'web.env-1'],
  )
  assertEquals(serviceDnsName('web', null, 'env-1'), ['web.env-1'])
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

test('bindingPrefixedKeys formats prefixed binding env keys', () => {
  assertEquals(bindingPrefixedKeys('DATABASE'), {
    url: 'DATABASE_URL',
    caCert: 'DATABASE_CA_CERT',
    readSplit: 'DATABASE_READ_SPLIT',
    host: 'DATABASE_HOST',
    port: 'DATABASE_PORT',
    database: 'DATABASE_NAME',
    user: 'DATABASE_USER',
    password: 'DATABASE_PASSWORD',
  })
  assertEquals(DEFAULT_BINDING_KEY_PREFIX, 'DATABASE')
})

test('assertSafeBindingKeyPrefix rejects reserved TURBOPANEL', () => {
  assertEquals(assertSafeBindingKeyPrefix('APP'), 'APP')
  assertThrows(() => assertSafeBindingKeyPrefix('TURBOPANEL'), TypeError)
  assertThrows(() => assertSafeBindingKeyPrefix('TURBOPANEL_X'), TypeError)
  assertThrows(() => assertSafeBindingKeyPrefix('9bad'), TypeError)
})
