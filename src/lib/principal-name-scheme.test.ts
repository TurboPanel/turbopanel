import { assert, assertEquals, assertMatch, assertNotEquals, assertThrows } from '@std/assert'
import { MANAGED_ENGINE_CODES } from '../features/managed/index.ts'
import { getManagedEngineSpec } from '../features/managed/index.ts'
import { deriveFreeSystemName } from '../features/principals/system-name.ts'
import {
  deriveSystemNameCandidate,
  INVALID_NAME_SCHEME_ERROR,
  isPrincipalNameScheme,
  maxTypedNameLength,
  PRINCIPAL_SCHEME_LOCKED_ERROR,
  principalNameSchemeOf,
  randomPrincipalSystemName,
  resolveOrgPrincipalNameScheme,
  resolveRequestedNameScheme,
} from './principal-name-scheme.ts'
import {
  assertSafePrincipalUsername,
  isReservedPrincipalUsername,
  MAX_PRINCIPAL_USERNAME_LENGTH,
  PRINCIPAL_UNIX_GROUP_SUFFIX,
} from './naming.ts'

const test = Deno.test.bind(Deno)

test('isPrincipalNameScheme accepts exactly the three schemes', () => {
  for (const value of ['plain', 'partial', 'random']) assert(isPrincipalNameScheme(value))
  for (const value of ['Plain', '', 'full', null, undefined, 1, true]) {
    assertEquals(isPrincipalNameScheme(value), false)
  }
})

test('resolveOrgPrincipalNameScheme: new key wins, legacy boolean falls back, default partial', () => {
  assertEquals(resolveOrgPrincipalNameScheme({}), 'partial')
  assertEquals(resolveOrgPrincipalNameScheme({ randomizedPrincipalUsernames: true }), 'partial')
  assertEquals(resolveOrgPrincipalNameScheme({ randomizedPrincipalUsernames: false }), 'plain')
  assertEquals(
    resolveOrgPrincipalNameScheme({
      principalNameScheme: 'random',
      randomizedPrincipalUsernames: false,
    }),
    'random'
  )
})

test('resolveRequestedNameScheme: default, explicit, invalid and locked', () => {
  const open = { defaultScheme: 'partial', locked: false } as const
  assertEquals(resolveRequestedNameScheme(open, undefined), { ok: true, scheme: 'partial' })
  assertEquals(resolveRequestedNameScheme(open, 'random'), { ok: true, scheme: 'random' })
  assertEquals(resolveRequestedNameScheme(open, 'plain'), { ok: true, scheme: 'plain' })
  assertEquals(resolveRequestedNameScheme(open, 'bogus'), {
    ok: false,
    error: INVALID_NAME_SCHEME_ERROR,
    status: 400,
  })

  const locked = { defaultScheme: 'random', locked: true } as const
  assertEquals(resolveRequestedNameScheme(locked, undefined), { ok: true, scheme: 'random' })
  assertEquals(resolveRequestedNameScheme(locked, 'random'), { ok: true, scheme: 'random' })
  assertEquals(resolveRequestedNameScheme(locked, 'plain'), {
    ok: false,
    error: PRINCIPAL_SCHEME_LOCKED_ERROR,
    status: 409,
  })
})

test('maxTypedNameLength reserves suffix room only for partial', () => {
  assertEquals(maxTypedNameLength('plain', 28), 28)
  assertEquals(maxTypedNameLength('random', 28), 28)
  assertEquals(maxTypedNameLength('partial', 28), 16)
})

test('deriveSystemNameCandidate: plain, partial and random shapes', () => {
  assertEquals(deriveSystemNameCandidate({ scheme: 'plain', typed: 'bob', maxLength: 28 }), 'bob')

  const partial = deriveSystemNameCandidate({ scheme: 'partial', typed: 'bob', maxLength: 28 })
  assertMatch(partial, /^bob_[a-z0-9]{11}$/)

  const random = deriveSystemNameCandidate({ scheme: 'random', typed: 'bob', maxLength: 28 })
  assertMatch(random, /^[a-z][a-z0-9]{11}$/)
  assertEquals(random.includes('bob'), false)
})

test('partial refuses a typed name that leaves no room for the suffix', () => {
  const fits = 'a'.repeat(16)
  assertEquals(
    deriveSystemNameCandidate({ scheme: 'partial', typed: fits, maxLength: 28 }).length,
    28
  )
  assertThrows(
    () => deriveSystemNameCandidate({ scheme: 'partial', typed: `${fits}a`, maxLength: 28 }),
    TypeError
  )
})

test('random system names are valid Linux names, unreserved and not repeating', () => {
  const seen = new Set<string>()
  for (let index = 0; index < 500; index += 1) {
    const name = randomPrincipalSystemName()
    assertEquals(name.length, 12)
    assertEquals(isReservedPrincipalUsername(name), false)
    assert(name.length + PRINCIPAL_UNIX_GROUP_SUFFIX.length <= 32)
    assert(name.length <= MAX_PRINCIPAL_USERNAME_LENGTH)
    assertSafePrincipalUsername(name)
    seen.add(name)
  }
  assertEquals(seen.size, 500)
})

test('every scheme output fits every managed engine identifier rule', () => {
  for (const code of MANAGED_ENGINE_CODES) {
    const spec = getManagedEngineSpec(code)
    if (!spec) continue
    const { pattern, maxLength } = spec.userOperations.identifier
    const typed = 'a'.repeat(maxTypedNameLength('partial', maxLength))
    for (const scheme of ['plain', 'partial', 'random'] as const) {
      const name = deriveSystemNameCandidate({ scheme, typed, maxLength })
      assert(pattern.test(name), `${code}/${scheme}: ${name} fails identifier pattern`)
      assert(name.length <= maxLength, `${code}/${scheme}: ${name} exceeds ${maxLength}`)
    }
  }
})

test('deriveFreeSystemName redraws on collision and leaves plain to the caller', async () => {
  const input = { scheme: 'partial', typed: 'bob', maxLength: 28 } as const
  const taken = new Set<string>()
  let calls = 0
  const name = await deriveFreeSystemName(input, (candidate) => {
    calls += 1
    if (calls < 3) taken.add(candidate)
    return Promise.resolve(taken.has(candidate))
  })
  assertEquals(calls, 3)
  assertEquals(taken.has(name), false)

  // Every probe taken: still returns a name (never throws on a live namespace).
  const forced = await deriveFreeSystemName({ scheme: 'random', typed: 'bob', maxLength: 28 }, () =>
    Promise.resolve(true)
  )
  assertMatch(forced, /^[a-z][a-z0-9]{11}$/)

  assertEquals(
    await deriveFreeSystemName({ scheme: 'plain', typed: 'bob', maxLength: 28 }, () =>
      Promise.resolve(true)
    ),
    'bob'
  )
})

test('principalNameSchemeOf reads the stored scheme and derives it for legacy rows', () => {
  assertEquals(
    principalNameSchemeOf({
      options: { nameScheme: 'random' },
      username: 'a',
      appliedUsername: 'a',
    }),
    'random'
  )
  assertEquals(
    principalNameSchemeOf({ options: null, username: 'bob', appliedUsername: 'bob' }),
    'plain'
  )
  assertEquals(
    principalNameSchemeOf({
      options: { shell: '/bin/sh' },
      username: 'bob',
      appliedUsername: 'bob_abc',
    }),
    'partial'
  )
  assertNotEquals(
    principalNameSchemeOf({
      options: { nameScheme: 'bogus' },
      username: 'bob',
      appliedUsername: 'bob',
    }),
    'bogus'
  )
})
