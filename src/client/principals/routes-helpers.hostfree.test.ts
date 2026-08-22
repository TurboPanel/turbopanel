/**
 * Host-free coverage for project principal route pure helpers.
 */

import { assertEquals } from '@std/assert'
import {
  mergeTopLevelPrincipalIdsIntoOptions,
  optionsRecordFromJsonb,
  parseCreatePrincipalOptions,
  parsePrincipalUsernameValue,
  patchRequiresServiceIds,
  projectPrincipalCreateResponse,
  resourceLimitsFromOptions,
} from './routes-helpers.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('mergeTopLevelPrincipalIdsIntoOptions merges uid/gid into options', () => {
  assertEquals(mergeTopLevelPrincipalIdsIntoOptions({ options: { shell: '/bin/zsh' } }), {
    shell: '/bin/zsh',
  })
  assertEquals(mergeTopLevelPrincipalIdsIntoOptions({ uid: 1001, gid: 1001 }), {
    uid: 1001,
    gid: 1001,
  })
  assertEquals(
    mergeTopLevelPrincipalIdsIntoOptions({
      uid: 1002,
      options: { shell: '/bin/bash', uid: 1 },
    }),
    { shell: '/bin/bash', uid: 1002 },
  )
  assertEquals(
    mergeTopLevelPrincipalIdsIntoOptions({ uid: 1, options: 'bad' }),
    'bad',
  )
})

test('parsePrincipalUsernameValue rejects reserved and unsafe names', () => {
  assertEquals(parsePrincipalUsernameValue('root'), {
    ok: false,
    error: 'username_reserved',
    status: 400,
  })
  assertEquals(parsePrincipalUsernameValue('Bad Name!').ok, false)
  const ok = parsePrincipalUsernameValue('  appuser  ')
  if (!ok.ok) throw new TypeError('expected valid username')
  assertEquals(ok.username, 'appuser')
})

test('parseCreatePrincipalOptions accepts and rejects option shapes', () => {
  const ok = parseCreatePrincipalOptions({ uid: 10001, gid: 10001 })
  if (!ok.ok) throw new TypeError('expected valid options')
  assertEquals(ok.override, { uid: 10001, gid: 10001 })

  assertEquals(parseCreatePrincipalOptions({ options: 'nope' }).ok, false)
  assertEquals(parseCreatePrincipalOptions({ uid: 2000, gid: 2000 }).ok, false)
})

test('projectPrincipalCreateResponse includes uid/gid only when set', () => {
  assertEquals(
    projectPrincipalCreateResponse({ id: 'p1' }, ['s1']),
    { ok: true, id: 'p1', serviceIds: ['s1'] },
  )
  assertEquals(
    projectPrincipalCreateResponse({ id: 'p1', uid: 10, gid: 20 }, []),
    { ok: true, id: 'p1', uid: 10, gid: 20, serviceIds: [] },
  )
})

test('resourceLimitsFromOptions parses jsonb options', () => {
  assertEquals(optionsRecordFromJsonb(null), {})
  assertEquals(
    resourceLimitsFromOptions({ resourceLimits: { maxCpus: 2 } }),
    { maxCpus: 2 },
  )
  assertEquals(resourceLimitsFromOptions({}), {})
  assertEquals(patchRequiresServiceIds({ serviceIds: [] }), true)
  assertEquals(patchRequiresServiceIds({}), false)
})
