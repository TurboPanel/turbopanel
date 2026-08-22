import { assertEquals } from '@std/assert'
import {
  normalizeSettingFullKey,
  normalizeSettingPrefix,
  normalizeSettingShortKey,
  SettingsResolver,
} from './resolver.ts'
import type { SettingValue } from './resolver.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const PREFIX = 'TURBOPANEL_EXAMPLE'
const SCHEMA = {
  HOST: 'localhost',
  PORT: '8080',
  SECRET: undefined,
} as const

test('normalizeSetting* helpers uppercase and trim keys', () => {
  assertEquals(normalizeSettingPrefix('  turbopanel_example '), 'TURBOPANEL_EXAMPLE')
  assertEquals(normalizeSettingShortKey(' host '), 'HOST')
  assertEquals(
    normalizeSettingFullKey('turbopanel_example', 'host'),
    'TURBOPANEL_EXAMPLE__HOST',
  )
})

test('SettingsResolver prefers env over db and default', () => {
  const resolver = new SettingsResolver({
    prefix: PREFIX,
    keys: SCHEMA,
    env: { TURBOPANEL_EXAMPLE__HOST: 'env-host' },
    dbValues: new Map([['TURBOPANEL_EXAMPLE__HOST', 'db-host']]),
  })

  assertEquals(resolver.resolve('HOST'), { value: 'env-host', source: 'env' })
  assertEquals(resolver.isEnvOverridden('HOST'), true)
  assertEquals(resolver.isDbSet('HOST'), true)
})

test('SettingsResolver falls back to db then schema defaults', () => {
  const resolver = new SettingsResolver({
    prefix: PREFIX,
    keys: SCHEMA,
    env: {},
    dbValues: new Map<string, SettingValue>([
      ['TURBOPANEL_EXAMPLE__PORT', 9443],
      ['TURBOPANEL_EXAMPLE__SECRET', '   '],
    ]),
  })

  assertEquals(resolver.resolve('PORT'), { value: '9443', source: 'db' })
  assertEquals(resolver.resolve('SECRET'), { value: '', source: 'default' })
  assertEquals(resolver.isDbSet('SECRET'), false)
  assertEquals(resolver.resolve('HOST'), { value: 'localhost', source: 'default' })
})

test('SettingsResolver honors env aliases and coerces json values', () => {
  const resolver = new SettingsResolver({
    prefix: PREFIX,
    keys: SCHEMA,
    env: { LEGACY_HOST: 'alias-host' },
    dbValues: new Map([['TURBOPANEL_EXAMPLE__HOST', { nested: true }]]),
    envAliases: { HOST: ['LEGACY_HOST'] },
  })

  assertEquals(resolver.resolve('HOST'), { value: 'alias-host', source: 'env' })
  assertEquals(resolver.isEnvOverridden('HOST'), true)
})
