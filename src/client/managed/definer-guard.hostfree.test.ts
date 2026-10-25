import { assertEquals } from '@std/assert'
import type { Db } from '../../db/connection.ts'
import { removeLoginsDroppedByApply } from '../../features/managed/logins.ts'
import { checkLoginMayBeDeleted } from './definer-guard.ts'
import { parseManagedPermissionsObserved } from '../../features/managed/privileges/observed.ts'
import type { ManagedPermissionsProbeOutcome } from './permissions-probe.ts'

const test = Deno.test.bind(Deno)

function observed(definesObjects?: string[]): ManagedPermissionsProbeOutcome {
  return {
    status: 'observed',
    permissions: {
      engine: 'mysql',
      observedAt: '2026-10-21T00:00:00.000Z',
      logins: [
        {
          username: 'app_user',
          exists: true,
          memberships: [],
          grants: [],
          defaults: [],
          ...(definesObjects ? { definesObjects } : {}),
        },
      ],
    },
  }
}

const noProbe = () => {
  throw new TypeError('the probe must not run')
}

test('a login that owns objects is refused with their quoted names', async () => {
  const check = await checkLoginMayBeDeleted('mysql', 'app_user', () =>
    Promise.resolve(observed(['view shop.orders_v', 'routine shop.recalc']))
  )
  if (check.kind !== 'refuse') throw new TypeError('expected a refusal')
  assertEquals(check.status, 409)
  assertEquals(check.body.error, 'managed_login_defines_objects')
  assertEquals(check.body.message.includes("'view shop.orders_v', 'routine shop.recalc'"), true)
  assertEquals(check.body.message.toLowerCase().includes('definer'), false)
})

test('PostgreSQL skips the check without asking the host', async () => {
  assertEquals(await checkLoginMayBeDeleted('postgres', 'app_user', noProbe), { kind: 'proceed' })
})

test('a login with no objects, or another login in the answer, goes ahead', async () => {
  assertEquals(
    await checkLoginMayBeDeleted('mariadb', 'app_user', () => Promise.resolve(observed())),
    {
      kind: 'proceed',
    }
  )
  assertEquals(
    await checkLoginMayBeDeleted('mysql', 'someone_else', () =>
      Promise.resolve(observed(['view a.b']))
    ),
    { kind: 'proceed' }
  )
})

test('an offline or older host goes ahead with a plain note', async () => {
  for (const outcome of [
    { status: 'unsupported' },
    { status: 'unavailable', reason: 'offline' },
    { status: 'unavailable', reason: 'no_registry' },
  ] as ManagedPermissionsProbeOutcome[]) {
    const check = await checkLoginMayBeDeleted('mysql', 'app_user', () => Promise.resolve(outcome))
    if (check.kind !== 'proceed') throw new TypeError('expected to proceed')
    assertEquals(check.note?.includes('views or routines'), true)
  }
})

test('a host that was asked and did not answer fails closed', async () => {
  for (const reason of ['timeout', 'daemon_error', 'invalid_result', 'error'] as const) {
    const check = await checkLoginMayBeDeleted('mysql', 'app_user', () =>
      Promise.resolve({ status: 'unavailable', reason } as ManagedPermissionsProbeOutcome)
    )
    if (check.kind !== 'refuse') throw new TypeError(`expected a refusal for ${reason}`)
    assertEquals(check.status, 503)
    assertEquals(check.body.error, 'managed_login_check_failed')
  }
})

test('the observed report keeps definesObjects and drops a malformed list', () => {
  const base = { username: 'u', exists: true, memberships: [], grants: [], defaults: [] }
  const report = parseManagedPermissionsObserved({
    engine: 'mysql',
    observedAt: '2026-10-21T00:00:00.000Z',
    logins: [
      { ...base, definesObjects: ['view a.b', 'and 3 more'] },
      { ...base, username: 'v', definesObjects: [1, 2] },
    ],
  })
  assertEquals(report?.logins[0]?.definesObjects, ['view a.b', 'and 3 more'])
  assertEquals(report?.logins[1]?.definesObjects, undefined)
})

test('one bad entry in definesObjects is skipped and long names are clamped', () => {
  const base = { username: 'u', exists: true, memberships: [], grants: [], defaults: [] }
  const report = parseManagedPermissionsObserved({
    engine: 'mysql',
    observedAt: '2026-10-21T00:00:00.000Z',
    logins: [{ ...base, definesObjects: ['view a.b', '', 7, 'x'.repeat(400)] }],
  })
  const kept = report?.logins[0]?.definesObjects
  assertEquals(kept?.length, 2)
  assertEquals(kept?.[0], 'view a.b')
  assertEquals(kept?.[1]?.length, 256)
})

test('a host that could not look up the objects fails closed, not as "none"', async () => {
  const outcome: ManagedPermissionsProbeOutcome = {
    status: 'observed',
    permissions: {
      engine: 'mysql',
      observedAt: '2026-10-21T00:00:00.000Z',
      logins: [
        {
          username: 'app_user',
          exists: true,
          memberships: [],
          grants: [],
          defaults: [],
          definesObjectsUnread: true,
        },
      ],
    },
  }
  const check = await checkLoginMayBeDeleted('mysql', 'app_user', () => Promise.resolve(outcome))
  if (check.kind !== 'refuse') throw new TypeError('expected a refusal')
  assertEquals(check.status, 503)
  assertEquals(check.body.error, 'managed_login_check_failed')
})

test('the observed report keeps the unread flag', () => {
  const base = { username: 'u', exists: true, memberships: [], grants: [], defaults: [] }
  const report = parseManagedPermissionsObserved({
    engine: 'mysql',
    observedAt: '2026-10-21T00:00:00.000Z',
    logins: [
      { ...base, definesObjectsUnread: true },
      { ...base, username: 'v' },
    ],
  })
  assertEquals(report?.logins[0]?.definesObjectsUnread, true)
  assertEquals(report?.logins[1]?.definesObjectsUnread, undefined)
})

test('login rows are removed only for the accounts an apply dropped', async () => {
  let deletes = 0
  const db = {
    delete: () => ({
      where: () => {
        deletes += 1
        return Promise.resolve()
      },
    }),
  } as unknown as Db
  await removeLoginsDroppedByApply(db, 'managed-1', undefined)
  await removeLoginsDroppedByApply(db, 'managed-1', [])
  assertEquals(deletes, 0)
  await removeLoginsDroppedByApply(db, 'managed-1', ['app_user'])
  assertEquals(deletes, 1)
})
