import { assertEquals } from '@std/assert'
import { loginDefinesObjectsRefusal } from './definer-guard.ts'
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

test('a login that defines objects is refused with their names', () => {
  const refusal = loginDefinesObjectsRefusal(
    observed(['view shop.orders_v', 'routine shop.recalc']),
    'app_user'
  )
  assertEquals(refusal?.error, 'managed_login_defines_objects')
  assertEquals(refusal?.objects.length, 2)
  assertEquals(refusal?.message.includes('view shop.orders_v, routine shop.recalc'), true)
})

test('nothing blocks a login that defines nothing, or a host that could not be asked', () => {
  assertEquals(loginDefinesObjectsRefusal(observed(), 'app_user'), null)
  assertEquals(loginDefinesObjectsRefusal(observed(['view a.b']), 'someone_else'), null)
  assertEquals(loginDefinesObjectsRefusal({ status: 'unsupported' }, 'app_user'), null)
  assertEquals(
    loginDefinesObjectsRefusal({ status: 'unavailable', reason: 'offline' }, 'app_user'),
    null
  )
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
