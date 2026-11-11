import { assertEquals } from '@std/assert'
import {
  collectComposeInterpolationKeys,
  hasComposeInterpolation,
  hasEmbeddedRefToken,
  containsVariableRefOpener,
  isVariableRefScope,
  parseExactVariableRef,
  resolveVariableRefScope,
  splitEmbeddedRefs,
  VARIABLE_REF_SCOPES,
} from './variable-refs.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('parseExactVariableRef accepts unscoped and scoped forms', () => {
  assertEquals(parseExactVariableRef('{$NODE_ENV}'), {
    ok: true,
    ref: { raw: '{$NODE_ENV}', scope: null, key: 'NODE_ENV' },
  })
  assertEquals(parseExactVariableRef('{$project.db_password}'), {
    ok: true,
    ref: {
      raw: '{$project.db_password}',
      scope: 'project',
      key: 'db_password',
    },
  })
  assertEquals(parseExactVariableRef('{$org.KEY}'), {
    ok: true,
    ref: { raw: '{$org.KEY}', scope: 'organization', key: 'KEY' },
  })
  assertEquals(parseExactVariableRef('{$env.KEY}'), {
    ok: true,
    ref: { raw: '{$env.KEY}', scope: 'environment', key: 'KEY' },
  })
})

test('parseExactVariableRef rejects unknown scopes and embedded refs', () => {
  const unknown = parseExactVariableRef('{$galaxy.KEY}')
  assertEquals(unknown.ok, false)
  const embedded = parseExactVariableRef('prefix-{$KEY}')
  assertEquals(embedded.ok, false)
  if (embedded.ok) return
  assertEquals(embedded.error, 'invalid')
  assertEquals(parseExactVariableRef('plain').ok, false)
})

test('collectComposeInterpolationKeys finds Compose-native tokens', () => {
  assertEquals(collectComposeInterpolationKeys('${FOO} and $BAR'), ['FOO', 'BAR'])
})

test('resolveVariableRefScope accepts canonical scopes and org/env aliases', () => {
  for (const scope of VARIABLE_REF_SCOPES) {
    assertEquals(resolveVariableRefScope(scope), scope)
    assertEquals(isVariableRefScope(scope), true)
  }
  assertEquals(resolveVariableRefScope('org'), 'organization')
  assertEquals(resolveVariableRefScope('env'), 'environment')
  assertEquals(resolveVariableRefScope('galaxy'), null)
  assertEquals(isVariableRefScope('org'), false)
})

test('parseExactVariableRef accepts every canonical scope token', () => {
  for (const scope of VARIABLE_REF_SCOPES) {
    const result = parseExactVariableRef(`{$${scope}.MY_KEY}`)
    assertEquals(result.ok, true)
    if (!result.ok) continue
    assertEquals(result.ref.scope, scope)
    assertEquals(result.ref.key, 'MY_KEY')
  }
})

test('parseExactVariableRef trims surrounding whitespace', () => {
  assertEquals(parseExactVariableRef('  {$PORT}  '), {
    ok: true,
    ref: { raw: '{$PORT}', scope: null, key: 'PORT' },
  })
})

test('parseExactVariableRef rejects invalid key characters', () => {
  for (const raw of ['{$123}', '{$bad-key}', '{$project.bad-key}']) {
    const result = parseExactVariableRef(raw)
    assertEquals(result.ok, false)
    if (result.ok) continue
    assertEquals(result.error, 'invalid')
  }
})

test('parseExactVariableRef rejects unknown scope tokens and malformed braces', () => {
  const unknown = parseExactVariableRef('{$workspace..KEY}')
  assertEquals(unknown.ok, false)
  if (!unknown.ok) {
    assertEquals(unknown.error, 'invalid')
  }
  const bareBrace = parseExactVariableRef('{$KEY')
  assertEquals(bareBrace.ok, false)
})

test('parseExactVariableRef reports embedded-ref guidance message', () => {
  const embedded = parseExactVariableRef('before {$KEY} after')
  assertEquals(embedded.ok, false)
  if (embedded.ok || embedded.error !== 'invalid') return
  assertEquals(embedded.message.includes('must be the entire value'), true)
})

test('containsVariableRefOpener detects TurboPanel ref openers', () => {
  assertEquals(containsVariableRefOpener('{$KEY}'), true)
  assertEquals(containsVariableRefOpener('prefix-{$KEY}'), true)
  assertEquals(containsVariableRefOpener('plain'), false)
  assertEquals(containsVariableRefOpener('${DOCKER}'), false)
})

test('collectComposeInterpolationKeys deduplicates repeated keys', () => {
  assertEquals(collectComposeInterpolationKeys('$FOO ${FOO} and $BAR ${BAR}'), ['FOO', 'BAR'])
})

test('splitEmbeddedRefs finds refs anywhere, scoped or not', () => {
  assertEquals(splitEmbeddedRefs('db:{$DB_HOST}:{$project.PORT}/x'), [
    { kind: 'text', text: 'db:' },
    { kind: 'ref', ref: { raw: '{$DB_HOST}', scope: null, key: 'DB_HOST' } },
    { kind: 'text', text: ':' },
    {
      kind: 'ref',
      ref: { raw: '{$project.PORT}', scope: 'project', key: 'PORT' },
    },
    { kind: 'text', text: '/x' },
  ])
})

test('splitEmbeddedRefs leaves text that is not a complete token alone', () => {
  for (const text of ['{$', '{$}', '{$1x}', '{$a.}', '{$a', '{ $A }', '{$$name}', '$A {']) {
    assertEquals(splitEmbeddedRefs(text), [{ kind: 'text', text }])
  }
  assertEquals(splitEmbeddedRefs(''), [])
  assertEquals(hasEmbeddedRefToken('{$$name}'), false)
  assertEquals(hasEmbeddedRefToken('a{$A}'), true)
})

test('splitEmbeddedRefs reports an unknown scope as invalid', () => {
  const [part] = splitEmbeddedRefs('{$nowhere.KEY}')
  assertEquals(part?.kind, 'invalid')
})

test('splitEmbeddedRefs is linear on long input', () => {
  const text = '{$'.repeat(50_000) + 'x'
  assertEquals(splitEmbeddedRefs(text).length, 1)
  assertEquals(splitEmbeddedRefs('{$A}'.repeat(20_000)).length, 20_000)
})

test('hasComposeInterpolation sets doubled dollar signs aside', () => {
  assertEquals(hasComposeInterpolation("$$cfg['a'][$$i]"), false)
  assertEquals(hasComposeInterpolation('${HOME}'), true)
  assertEquals(hasComposeInterpolation('path $HOME'), true)
  assertEquals(hasComposeInterpolation('price $5 and {$$x}'), false)
})
