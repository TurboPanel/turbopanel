import { assertEquals } from '@std/assert'
import { parseOrganizationOptions } from './organization-options.ts'
import {
  parsePrincipalDefaultsPatch,
  principalDefaultsOptionChanges,
  principalDefaultsResponse,
} from './principal-defaults.ts'

const test = Deno.test.bind(Deno)

test('parsePrincipalDefaultsPatch accepts scheme and lock fields', () => {
  assertEquals(parsePrincipalDefaultsPatch({ nameScheme: 'random' }), {
    ok: true,
    patch: { nameScheme: 'random' },
  })
  assertEquals(parsePrincipalDefaultsPatch({ nameScheme: null, schemeLocked: true }), {
    ok: true,
    patch: { nameScheme: null, schemeLocked: true },
  })
  assertEquals(parsePrincipalDefaultsPatch({ schemeLocked: false }), {
    ok: true,
    patch: { schemeLocked: false },
  })
})

test('parsePrincipalDefaultsPatch rejects empty, mistyped and unknown values', () => {
  for (const body of [
    {},
    null,
    [],
    { nameScheme: 'full' },
    { nameScheme: 3 },
    { schemeLocked: 'yes' },
    { randomizedUsernames: true },
    { somethingElse: true },
  ]) {
    assertEquals(parsePrincipalDefaultsPatch(body), { ok: false })
  }
})

test('principalDefaultsOptionChanges retires the legacy key and toggles the lock', () => {
  assertEquals(principalDefaultsOptionChanges({ nameScheme: 'random' }), {
    remove: ['randomizedPrincipalUsernames'],
    set: { principalNameScheme: 'random' },
  })
  assertEquals(principalDefaultsOptionChanges({ nameScheme: null }), {
    remove: ['randomizedPrincipalUsernames', 'principalNameScheme'],
    set: {},
  })
  assertEquals(principalDefaultsOptionChanges({ schemeLocked: true }), {
    remove: [],
    set: { principalNameSchemeLocked: true },
  })
  assertEquals(principalDefaultsOptionChanges({ schemeLocked: false }), {
    remove: ['principalNameSchemeLocked'],
    set: {},
  })
})

test('principalDefaultsResponse reads new keys and the stored legacy boolean fallback', () => {
  assertEquals(principalDefaultsResponse({}), {
    nameScheme: null,
    effectiveNameScheme: 'partial',
    schemeLocked: false,
  })
  assertEquals(
    principalDefaultsResponse(parseOrganizationOptions({ randomizedPrincipalUsernames: false })),
    {
      nameScheme: null,
      effectiveNameScheme: 'plain',
      schemeLocked: false,
    }
  )
  assertEquals(
    principalDefaultsResponse(
      parseOrganizationOptions({
        principalNameScheme: 'random',
        principalNameSchemeLocked: true,
        randomizedPrincipalUsernames: false,
      })
    ),
    {
      nameScheme: 'random',
      effectiveNameScheme: 'random',
      schemeLocked: true,
    }
  )
})
