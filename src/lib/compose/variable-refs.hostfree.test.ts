import { assertEquals } from '@std/assert'
import {
  collectComposeInterpolationKeys,
  containsVariableRefOpener,
  isVariableRefScope,
  parseExactVariableRef,
  resolveVariableRefScope,
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
    ref: { raw: '{$project.db_password}', scope: 'project', key: 'db_password' },
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
  assertEquals(
    embedded.message.includes('must be the entire value'),
    true,
  )
})

test('containsVariableRefOpener detects TurboPanel ref openers', () => {
  assertEquals(containsVariableRefOpener('{$KEY}'), true)
  assertEquals(containsVariableRefOpener('prefix-{$KEY}'), true)
  assertEquals(containsVariableRefOpener('plain'), false)
  assertEquals(containsVariableRefOpener('${DOCKER}'), false)
})

test('collectComposeInterpolationKeys deduplicates repeated keys', () => {
  assertEquals(
    collectComposeInterpolationKeys('$FOO ${FOO} and $BAR ${BAR}'),
    ['FOO', 'BAR'],
  )
})
