import { assertEquals } from '@std/assert'
import { type LoginPatchCurrent, planLoginPatch } from './login-patch.ts'

const test = Deno.test.bind(Deno)
const settings = (overrides: Partial<LoginPatchCurrent> = {}): LoginPatchCurrent => ({
  role: 'user',
  grantMode: 'recipe',
  tool: false,
  databases: [],
  privileges: [],
  connectionRole: 'read-write',
  allowedSources: undefined,
  maxConnections: undefined,
  ...overrides,
})
const user = (overrides: Partial<LoginPatchCurrent> = {}) => settings(overrides)

test('a recipe login can move to self and the preview keeps grants alone', () => {
  const plan = planLoginPatch('postgres', user(), { grantMode: 'self' })
  if (!plan.ok) throw new Error('expected ok')
  assertEquals(plan.patch, { grantMode: 'self' })
  assertEquals(
    plan.summary.some((line) => line.includes('left exactly as they are')),
    true
  )
  assertEquals(
    plan.summary.some((line) => line.includes('Revoke')),
    false
  )
})

test('recipe logins preview the permission reset', () => {
  const plan = planLoginPatch('mysql', user({ grantMode: 'recipe' }), {
    tool: true,
  })
  if (!plan.ok) throw new Error('expected ok')
  assertEquals(
    plan.summary.some((line) => line.includes('Reset the login permissions')),
    true
  )
  assertEquals(
    plan.summary.some((line) => line.includes('primary')),
    true
  )
})

test('invalid transitions are refused in plain words', () => {
  const root = planLoginPatch('postgres', settings({ role: 'root' }), {
    tool: true,
  })
  assertEquals(root.ok, false)
  const preset = planLoginPatch('postgres', user({ grantMode: 'recipe' }), {
    grantMode: 'preset',
  })
  assertEquals(!preset.ok && preset.error, 'managed_grant_mode_invalid')
  const bogus = planLoginPatch('postgres', user(), { grantMode: 'x' })
  assertEquals(!bogus.ok && bogus.error, 'managed_grant_mode_invalid')
  const noConfirm = planLoginPatch('postgres', user({ grantMode: 'self' }), {
    grantMode: 'recipe',
  })
  assertEquals(!noConfirm.ok && noConfirm.error, 'managed_grant_reset_needs_confirm')
  const confirmed = planLoginPatch('postgres', user({ grantMode: 'self' }), {
    grantMode: 'recipe',
    confirmReset: true,
  })
  assertEquals(confirmed.ok, true)
  const roSelf = planLoginPatch('postgres', user({ grantMode: 'self' }), {
    connectionRole: 'read-only',
  })
  assertEquals(roSelf.ok, true)
  const priv = planLoginPatch('postgres', user({ grantMode: 'self' }), {
    privileges: ['owner'],
  })
  assertEquals(!priv.ok && priv.error, 'managed_self_login_has_no_privileges')
  const empty = planLoginPatch('postgres', user(), {})
  assertEquals(empty.ok, false)
})

test('the routing role is written as given, read-write included', () => {
  const plan = planLoginPatch('postgres', user({ connectionRole: 'read-only' }), {
    connectionRole: 'read-write',
  })
  if (!plan.ok) throw new Error('expected ok')
  assertEquals(plan.patch.connectionRole, 'read-write')
})

test('moving a read-only postgres login to self needs confirmReset', () => {
  const refused = planLoginPatch('postgres', user({ connectionRole: 'read-only' }), {
    grantMode: 'self',
  })
  assertEquals(!refused.ok && refused.status, 409)
  assertEquals(!refused.ok && refused.error, 'managed_grant_reset_needs_confirm')
  assertEquals(!refused.ok && refused.message.includes('stays on'), true)
  const sameRequest = planLoginPatch('postgres', user(), {
    grantMode: 'self',
    connectionRole: 'read-only',
  })
  assertEquals(!sameRequest.ok && sameRequest.status, 409)
  const confirmed = planLoginPatch('postgres', user({ connectionRole: 'read-only' }), {
    grantMode: 'self',
    confirmReset: true,
  })
  assertEquals(confirmed.ok, true)
  const clears = planLoginPatch('postgres', user({ connectionRole: 'read-only' }), {
    grantMode: 'self',
    connectionRole: 'read-write',
  })
  assertEquals(clears.ok, true)
  const mysql = planLoginPatch('mysql', user({ connectionRole: 'read-only' }), {
    grantMode: 'self',
  })
  assertEquals(mysql.ok, true)
})

test('moving a login to admin is never refused over owner roles and makes it a tool login', () => {
  // A database without an owner role does not stop it: the answer notes what it got.
  const noRole = planLoginPatch('postgres', user({ databases: ['shop'] }), {
    privileges: ['admin'],
  })
  assertEquals(noRole.ok, true)
  const plan = planLoginPatch(
    'postgres',
    user({ databases: ['shop'], privileges: ['read-write'] }),
    { privileges: ['admin'] }
  )
  if (!plan.ok) throw new Error('expected ok')
  assertEquals(plan.patch.privileges, ['admin'])
  assertEquals(plan.patch.tool, true)
  assertEquals(
    plan.summary.some((line) => line.includes('owner role')),
    true
  )
  // An explicit tool: false is kept.
  const off = planLoginPatch('postgres', user({ databases: ['shop'] }), {
    privileges: ['admin'],
    tool: false,
  })
  if (!off.ok) throw new Error('expected ok')
  assertEquals(off.patch.tool, false)
})

test('an admin login cannot become read-only, and MySQL admin needs no owner role', () => {
  const ro = planLoginPatch('mysql', user({ databases: ['shop'], privileges: ['admin'] }), {
    connectionRole: 'read-only',
  })
  assertEquals(!ro.ok && ro.error, 'managed_admin_login_not_read_only')
  const my = planLoginPatch('mysql', user({ databases: ['shop'] }), { privileges: ['admin'] })
  if (!my.ok) throw new Error('expected ok')
  assertEquals(my.patch.privileges, ['admin'])
  assertEquals(
    my.summary.some((line) => line.includes('all rights on each listed database')),
    true
  )
})
