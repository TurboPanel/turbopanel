import { assertEquals } from '@std/assert'
import { planLoginPatch } from './login-patch.ts'

const test = Deno.test.bind(Deno)
const user = (metadata: unknown) => ({ role: 'user' as const, metadata })

test('a preset login can move to self and the preview keeps grants alone', () => {
  const plan = planLoginPatch('postgres', user({}), { grantMode: 'self' })
  if (!plan.ok) throw new Error('expected ok')
  assertEquals(plan.metadata, { grantMode: 'self' })
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
  const root = planLoginPatch(
    'postgres',
    { role: 'root', metadata: {} },
    {
      tool: true,
    }
  )
  assertEquals(root.ok, false)
  const preset = planLoginPatch('postgres', user({ grantMode: 'recipe' }), {
    grantMode: 'preset',
  })
  assertEquals(!preset.ok && preset.error, 'managed_grant_mode_invalid_transition')
  const bogus = planLoginPatch('postgres', user({}), { grantMode: 'x' })
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
  const empty = planLoginPatch('postgres', user({}), {})
  assertEquals(empty.ok, false)
})

test('read-only is stored only as read-only; read-write clears it', () => {
  const plan = planLoginPatch('postgres', user({ connectionRole: 'read-only' }), {
    connectionRole: 'read-write',
  })
  if (!plan.ok) throw new Error('expected ok')
  assertEquals('connectionRole' in plan.metadata, true)
  assertEquals(plan.metadata.connectionRole, undefined)
})

test('moving a read-only postgres login to self needs confirmReset', () => {
  const refused = planLoginPatch('postgres', user({ connectionRole: 'read-only' }), {
    grantMode: 'self',
  })
  assertEquals(!refused.ok && refused.status, 409)
  assertEquals(!refused.ok && refused.error, 'managed_grant_reset_needs_confirm')
  assertEquals(!refused.ok && refused.message.includes('stays on'), true)
  const sameRequest = planLoginPatch('postgres', user({}), {
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

test('moving a login to admin needs owner-role databases on Postgres and makes it a tool login', () => {
  const noRole = planLoginPatch('postgres', user({ databases: ['shop'] }), {
    privileges: ['admin'],
  })
  assertEquals(!noRole.ok && noRole.error, 'managed_admin_needs_owner_role')
  const plan = planLoginPatch(
    'postgres',
    user({ databases: ['shop'], privileges: ['read-write'] }),
    { privileges: ['admin'] },
    { ownerRoleDatabases: ['shop'] }
  )
  if (!plan.ok) throw new Error('expected ok')
  assertEquals(plan.metadata.privileges, ['admin'])
  assertEquals(plan.metadata.tool, true)
  assertEquals(
    plan.summary.some((line) => line.includes('owner role')),
    true
  )
  // An explicit tool: false is kept.
  const off = planLoginPatch(
    'postgres',
    user({ databases: ['shop'] }),
    { privileges: ['admin'], tool: false },
    { ownerRoleDatabases: ['shop'] }
  )
  if (!off.ok) throw new Error('expected ok')
  assertEquals(off.metadata.tool, false)
})

test('an admin login cannot become read-only, and MySQL admin needs no owner role', () => {
  const ro = planLoginPatch('mysql', user({ databases: ['shop'], privileges: ['admin'] }), {
    connectionRole: 'read-only',
  })
  assertEquals(!ro.ok && ro.error, 'managed_admin_login_not_read_only')
  const my = planLoginPatch('mysql', user({ databases: ['shop'] }), { privileges: ['admin'] })
  if (!my.ok) throw new Error('expected ok')
  assertEquals(my.metadata.privileges, ['admin'])
  assertEquals(
    my.summary.some((line) => line.includes('all rights on each listed database')),
    true
  )
})
