/**
 * Host-free coverage for project principal route pure helpers.
 */

import { assertEquals } from '@std/assert'
import {
  parseEntitlementsField,
  patchTouchesPrincipal,
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

const RUNTIMES = { runtimes: ['php', 'node'], series: ['8.3', '8.4', '22', '24'] }

test('parseEntitlementsField distinguishes absent from empty', () => {
  // Absent means "leave them alone"; [] means "revoke everything". Collapsing
  // the two would make a steward-only PATCH silently strip every grant.
  assertEquals(parseEntitlementsField({}, RUNTIMES), undefined)
  assertEquals(parseEntitlementsField({ entitlements: [] }, RUNTIMES), [])
})

test('parseEntitlementsField rejects rather than dropping a bad grant', () => {
  // Silently discarding a malformed list would REVOKE every entitlement the
  // principal should have held.
  assertEquals(parseEntitlementsField({ entitlements: 'php' }, RUNTIMES), null)
  assertEquals(
    parseEntitlementsField({ entitlements: [{ runtime: 'php' }] }, RUNTIMES),
    null,
  )
  assertEquals(
    parseEntitlementsField(
      { entitlements: [{ runtime: 'ruby', series: '3.3' }] },
      RUNTIMES,
    ),
    null,
  )
  assertEquals(
    parseEntitlementsField(
      { entitlements: [{ runtime: 'php', series: '8.1' }] },
      RUNTIMES,
    ),
    null,
  )
})

test('parseEntitlementsField marks API grants as operator, never deploy', () => {
  // `deploy` provenance is inserted by deploy-prepare when a service declares a
  // runtime; a client must not be able to forge that distinction.
  assertEquals(
    parseEntitlementsField(
      { entitlements: [{ runtime: 'php', series: '8.4', grantedBy: 'deploy' }] },
      RUNTIMES,
    ),
    [{ runtime: 'php', series: '8.4', grantedBy: 'operator' }],
  )
})

test('parseEntitlementsField folds duplicates', () => {
  assertEquals(
    parseEntitlementsField(
      {
        entitlements: [
          { runtime: 'php', series: '8.4' },
          { runtime: 'php', series: '8.4' },
        ],
      },
      RUNTIMES,
    ),
    [{ runtime: 'php', series: '8.4', grantedBy: 'operator' }],
  )
})

test('patchTouchesPrincipal accepts an entitlements-only patch', () => {
  assertEquals(patchTouchesPrincipal({ entitlements: [] }), true)
  assertEquals(patchTouchesPrincipal({ serviceIds: [] }), true)
  assertEquals(patchTouchesPrincipal({ username: 'x' }), false)
})
