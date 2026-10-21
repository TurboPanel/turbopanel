/**
 * Host-free coverage for "Connect straight through": the resolver, the
 * refusals on create and change, the dry-run line and the API fields.
 */

import { assertEquals } from '@std/assert'
import { type LoginPatchCurrent, planLoginPatch } from './login-patch.ts'
import {
  refuseStraightThrough,
  resolveStraightThrough,
  STRAIGHT_THROUGH_CONFLICT_ERROR,
  STRAIGHT_THROUGH_CONFLICT_MESSAGE,
  type StraightThroughFacts,
} from './login-straight-through.ts'
import { serializeManagedLogin, straightThroughFields } from './routes-helpers.ts'

const test = Deno.test.bind(Deno)

const facts = (over: Partial<StraightThroughFacts> = {}): StraightThroughFacts => ({
  engine: 'postgres',
  role: 'user',
  privileges: ['read-write'],
  allowedSources: undefined,
  straightThrough: undefined,
  ...over,
})

const current = (over: Partial<LoginPatchCurrent> = {}): LoginPatchCurrent => ({
  role: 'user',
  grantMode: 'recipe',
  tool: false,
  databases: ['app'],
  privileges: ['read-write'],
  connectionRole: 'read-write',
  allowedSources: undefined,
  maxConnections: undefined,
  ...over,
})

test('default: on for a PostgreSQL Migration login, off for the rest', () => {
  assertEquals(resolveStraightThrough(facts({ privileges: ['owner'] })), {
    value: true,
    isDefault: true,
  })
  assertEquals(resolveStraightThrough(facts()), { value: false, isDefault: true })
  assertEquals(resolveStraightThrough(facts({ privileges: ['read-only'] })).value, false)
  assertEquals(resolveStraightThrough(facts({ privileges: ['admin'] })).value, false)
})

test('a stored choice beats the default in both directions', () => {
  assertEquals(resolveStraightThrough(facts({ straightThrough: true })), {
    value: true,
    isDefault: false,
  })
  assertEquals(resolveStraightThrough(facts({ privileges: ['owner'], straightThrough: false })), {
    value: false,
    isDefault: false,
  })
})

test('a source limit always resolves off, and a Migration login with one is not an error', () => {
  const limited = facts({ privileges: ['owner'], allowedSources: ['internal'] })
  assertEquals(resolveStraightThrough(limited), { value: false, isDefault: true })
  assertEquals(refuseStraightThrough(limited), null)
  assertEquals(resolveStraightThrough({ ...limited, straightThrough: true }), {
    value: false,
    isDefault: false,
  })
})

test('MySQL, MariaDB and the cluster logins never connect straight through', () => {
  for (const engine of ['mysql', 'mariadb']) {
    assertEquals(
      resolveStraightThrough(facts({ engine, privileges: ['owner'], straightThrough: true })),
      { value: false, isDefault: false }
    )
  }
  assertEquals(resolveStraightThrough(facts({ role: 'root', privileges: ['owner'] })).value, false)
  assertEquals(
    resolveStraightThrough(facts({ role: 'replication', straightThrough: true })).value,
    false
  )
})

test('refusals: source limit, engine and role', () => {
  const conflict = refuseStraightThrough(
    facts({ straightThrough: true, allowedSources: ['internal'] })
  )
  assertEquals(conflict?.error, STRAIGHT_THROUGH_CONFLICT_ERROR)
  assertEquals(conflict?.message, STRAIGHT_THROUGH_CONFLICT_MESSAGE)
  assertEquals(
    refuseStraightThrough(facts({ engine: 'mysql', straightThrough: true }))?.error,
    'straight_through_postgres_only'
  )
  assertEquals(
    refuseStraightThrough(facts({ role: 'root', straightThrough: true }))?.error,
    'straight_through_login_not_allowed'
  )
  assertEquals(
    refuseStraightThrough(facts({ straightThrough: false, allowedSources: ['internal'] })),
    null
  )
  assertEquals(refuseStraightThrough(facts({ engine: 'mysql', straightThrough: false })), null)
})

test('PATCH: turning it on with a stored source limit is refused', () => {
  const plan = planLoginPatch('postgres', current({ allowedSources: ['internal'] }), {
    straightThrough: true,
  })
  assertEquals(!plan.ok && plan.error, STRAIGHT_THROUGH_CONFLICT_ERROR)
  assertEquals(!plan.ok && plan.status, 400)
})

test('PATCH: adding a source limit to a login set to straight through is refused', () => {
  const plan = planLoginPatch('postgres', current({ straightThrough: true }), {
    allowedSources: ['internal'],
  })
  assertEquals(!plan.ok && plan.error, STRAIGHT_THROUGH_CONFLICT_ERROR)
})

test('PATCH: both together, and clearing one while setting the other', () => {
  const both = planLoginPatch('postgres', current(), {
    straightThrough: true,
    allowedSources: ['internal'],
  })
  assertEquals(!both.ok && both.error, STRAIGHT_THROUGH_CONFLICT_ERROR)
  const clearsLimit = planLoginPatch('postgres', current({ allowedSources: ['internal'] }), {
    straightThrough: true,
    allowedSources: null,
  })
  assertEquals(clearsLimit.ok, true)
  const clearsChoice = planLoginPatch('postgres', current({ straightThrough: true }), {
    straightThrough: null,
    allowedSources: ['internal'],
  })
  assertEquals(clearsChoice.ok, true)
  if (clearsChoice.ok) assertEquals(clearsChoice.patch.straightThrough, null)
})

test('PATCH: a Migration login gains a source limit without an error and the dry run says it goes off', () => {
  const plan = planLoginPatch('postgres', current({ privileges: ['owner'] }), {
    allowedSources: ['internal'],
  })
  assertEquals(plan.ok, true)
  if (plan.ok) {
    assertEquals(
      plan.summary.some((line) => line.includes('normal shared path')),
      true
    )
  }
})

test('PATCH: the dry run says when the effective setting turns on', () => {
  const plan = planLoginPatch('postgres', current(), { straightThrough: true })
  if (!plan.ok) throw new Error('expected ok')
  assertEquals(plan.patch.straightThrough, true)
  assertEquals(
    plan.summary.some((line) => line.includes('straight through the front door')),
    true
  )
  const same = planLoginPatch('postgres', current({ straightThrough: true }), {
    straightThrough: true,
    tool: true,
  })
  if (!same.ok) throw new Error('expected ok')
  assertEquals(
    same.summary.some((line) => line.includes('straight through')),
    false
  )
})

test('PATCH: MySQL and MariaDB refuse true but accept clearing', () => {
  for (const engine of ['mysql', 'mariadb']) {
    const refused = planLoginPatch(engine, current(), { straightThrough: true })
    assertEquals(!refused.ok && refused.error, 'straight_through_postgres_only')
    assertEquals(planLoginPatch(engine, current(), { straightThrough: null }).ok, true)
  }
})

test('PATCH: a non-editable login keeps its own refusal first', () => {
  const plan = planLoginPatch('postgres', current({ role: 'root' }), { straightThrough: true })
  assertEquals(!plan.ok && plan.error, 'managed_login_not_editable')
})

test('API fields: effective value plus the default flag', () => {
  assertEquals(straightThroughFields(facts({ privileges: ['owner'] })), {
    straightThrough: true,
    straightThroughDefault: true,
  })
  assertEquals(straightThroughFields(facts({ straightThrough: false, privileges: ['owner'] })), {
    straightThrough: false,
    straightThroughDefault: false,
  })
  const row = {
    id: 'l1',
    principalId: null,
    managedId: 'm1',
    role: 'user' as const,
    username: 'migrator',
    appliedUsername: 'migrator',
    nameScheme: 'plain' as const,
    databases: ['app'],
    privileges: ['owner'],
    connectionRole: 'read-write' as const,
    grantMode: 'recipe' as const,
    tool: false,
    allowedSources: undefined,
    maxConnections: undefined,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  }
  const pg = serializeManagedLogin(row, 'postgres')
  assertEquals([pg.straightThrough, pg.straightThroughDefault], [true, true])
  const my = serializeManagedLogin(row, 'mysql')
  assertEquals([my.straightThrough, my.straightThroughDefault], [false, false])
})
