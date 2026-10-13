import { assert, assertEquals } from '@std/assert'
import { ALLOWED_PRINCIPAL_SHELLS } from './principal-options.ts'
import {
  PRINCIPAL_ACCESS_LEVELS,
  accessGroupsFor,
  accessLevelForShell,
  effectivePrincipalAccess,
  PRINCIPAL_PASSWORD_GROUP,
  isPrincipalAccessLevel,
  principalAccessLabel,
  shellForAccessLevel,
} from './principal-access.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('every level writes a shell the allowlist accepts', () => {
  // The encoding is only safe while both halves agree: a level whose shell the
  // parser rejects would be silently dropped back to the default on save.
  for (const level of PRINCIPAL_ACCESS_LEVELS) {
    assert(
      ALLOWED_PRINCIPAL_SHELLS.includes(shellForAccessLevel(level)),
      `${level} writes ${shellForAccessLevel(level)}, which is not allowed`,
    )
  }
})

test('the level round-trips through the shell it writes', () => {
  for (const level of PRINCIPAL_ACCESS_LEVELS) {
    assertEquals(accessLevelForShell(shellForAccessLevel(level)), level)
  }
})

test('every level maps to a distinct shell', () => {
  const shells = new Set(PRINCIPAL_ACCESS_LEVELS.map(shellForAccessLevel))
  assertEquals(shells.size, PRINCIPAL_ACCESS_LEVELS.length)
})

test('adopted-account shell aliases are read but never written', () => {
  assertEquals(accessLevelForShell('/sbin/nologin'), 'sftp')
  assertEquals(accessLevelForShell('/bin/sh'), 'shell')
  assert(!PRINCIPAL_ACCESS_LEVELS.map(shellForAccessLevel).includes('/bin/sh'))
  assert(
    !PRINCIPAL_ACCESS_LEVELS.map(shellForAccessLevel).includes('/sbin/nologin'),
  )
})

test('an unrecognized or missing shell fails closed', () => {
  assertEquals(accessLevelForShell('/opt/evil'), 'none')
  assertEquals(accessLevelForShell(null), 'none')
  assertEquals(accessLevelForShell(undefined), 'none')
  assertEquals(accessLevelForShell(''), 'none')
})

test('zero keys means no access, whatever the shell says', () => {
  assertEquals(effectivePrincipalAccess('/bin/bash', 0), 'none')
  assertEquals(effectivePrincipalAccess('/usr/sbin/nologin', 0), 'none')
  assertEquals(effectivePrincipalAccess('/bin/bash', 1), 'shell')
  assertEquals(effectivePrincipalAccess('/usr/sbin/nologin', 2), 'sftp')
})

test('a suspended account keeps its keys and loses its groups', () => {
  // `none` is the reason this is three states and not two: suspending must not
  // require deleting the credential.
  assertEquals(accessGroupsFor('/bin/false', 3), [])
  assertEquals(accessGroupsFor('/bin/bash', 3), ['tpshell'])
  assertEquals(accessGroupsFor('/usr/sbin/nologin', 3), ['tpsftp'])
})

test('an account holding no keys is granted no access group', () => {
  assertEquals(accessGroupsFor('/bin/bash', 0), [])
})

test('a principal never holds both access groups at once', () => {
  for (const shell of ALLOWED_PRINCIPAL_SHELLS) {
    assert(accessGroupsFor(shell, 1).length <= 1)
  }
})

test('isPrincipalAccessLevel gates unknown input', () => {
  assert(isPrincipalAccessLevel('sftp'))
  assert(!isPrincipalAccessLevel('root'))
  assert(!isPrincipalAccessLevel(undefined))
})

test('principalAccessLabel maps levels to operator-facing copy', () => {
  assertEquals(principalAccessLabel('shell'), 'Shell')
  assertEquals(principalAccessLabel('sftp'), 'Files only')
  assertEquals(principalAccessLabel('none'), 'No access')
})

test('an enabled password counts as a credential', () => {
  // Password-only accounts must resolve to their intended level, or the
  // daemon would strip the very group the password Match block hangs from.
  assertEquals(effectivePrincipalAccess('/bin/bash', 0, true), 'shell')
  assertEquals(effectivePrincipalAccess('/usr/sbin/nologin', 0, true), 'sftp')
  // Suspension still wins over any credential.
  assertEquals(effectivePrincipalAccess('/bin/false', 0, true), 'none')
})

test('password sign-in adds the password group alongside the level group', () => {
  assertEquals(accessGroupsFor('/bin/bash', 0, true), [
    'tpshell',
    PRINCIPAL_PASSWORD_GROUP,
  ])
  assertEquals(accessGroupsFor('/usr/sbin/nologin', 2, true), [
    'tpsftp',
    PRINCIPAL_PASSWORD_GROUP,
  ])
  // Never alone: a password with no level to sign in as grants nothing, and
  // suspending strips both credentials at once.
  assertEquals(accessGroupsFor('/bin/false', 0, true), [])
  // And never when password sign-in is off.
  assertEquals(accessGroupsFor('/bin/bash', 1, false), ['tpshell'])
})
