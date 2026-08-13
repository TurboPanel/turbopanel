import { assertEquals } from 'jsr:@std/assert'
import {
  collectComposeInterpolationKeys,
  parseExactVariableRef,
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
