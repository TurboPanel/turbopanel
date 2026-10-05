import { describe, it } from '@std/testing/bdd'
import { assertEquals } from '@std/assert'
import {
  buildNativeAppVariables,
  NATIVE_APP_MAX_VARIABLES,
  NATIVE_APP_PLATFORM_ENV_NAMES,
} from './native-app-variables.ts'
import type { RuntimeEnvAssignment } from './apply-variables.ts'

const app = { listenPort: 18100 }

function plain(name: string, value: string, source = 'project', key = name): RuntimeEnvAssignment {
  return { name, key, isSecret: false, value, source }
}

function secret(name: string, key = name, source = 'project') {
  return { name, key, isSecret: true, value: null, source }
}

describe('buildNativeAppVariables', () => {
  it('sends plain values inline and secrets as pointers, sorted by name', () => {
    const { variables } = buildNativeAppVariables(
      [
        plain('ZED', 'z'),
        secret('DB_PASSWORD', 'DB_SECRET'),
        plain('API_URL', 'https://example.test'),
      ],
      app
    )
    assertEquals(variables, [
      { name: 'API_URL', value: 'https://example.test' },
      { name: 'DB_PASSWORD', secretKey: 'DB_SECRET' },
      { name: 'ZED', value: 'z' },
    ])
  })

  it("never puts a secret's value anywhere in the wire list or the view", () => {
    const result = buildNativeAppVariables([secret('TOKEN')], app)
    assertEquals(JSON.stringify(result).includes('value":"s'), false)
    const row = result.view.find((entry) => entry.name === 'TOKEN')
    assertEquals(row, {
      name: 'TOKEN',
      source: 'project',
      isSecret: true,
      value: null,
      delivered: true,
    })
  })

  it('lets the last assignment of a name win, as the Compose lane does', () => {
    const { variables } = buildNativeAppVariables(
      [plain('MODE', 'first'), plain('MODE', 'second', 'service')],
      app
    )
    assertEquals(variables, [{ name: 'MODE', value: 'second' }])
  })

  it("lists the platform's own variables and refuses to let a variable replace them", () => {
    const { variables, view } = buildNativeAppVariables(
      [plain('PORT', '1', 'environment'), plain('PATH', '/evil'), plain('OK', '1')],
      { listenPort: 18100, appMode: 'development' }
    )
    assertEquals(variables, [{ name: 'OK', value: '1' }])
    assertEquals(
      view.filter((entry) => entry.source === 'platform').map((e) => [e.name, e.value]),
      [
        ['HOST', '127.0.0.1'],
        ['NODE_ENV', 'development'],
        ['PORT', '18100'],
      ]
    )
    const dropped = view.filter((entry) => !entry.delivered)
    assertEquals(
      dropped.map((e) => [e.name, e.source, e.reason]),
      [
        ['PATH', 'project', 'platform'],
        ['PORT', 'environment', 'platform'],
      ]
    )
  })

  it('keeps every name the daemon owns on the reserved list', () => {
    for (const name of [
      'PATH',
      'NODE_ENV',
      'PORT',
      'HOST',
      'HOME',
      'TMPDIR',
      'XDG_CACHE_HOME',
      'COREPACK_HOME',
      'COREPACK_ENABLE_DOWNLOAD_PROMPT',
    ]) {
      assertEquals(NATIVE_APP_PLATFORM_ENV_NAMES.has(name), true, name)
    }
  })

  it('holds back what the daemon would refuse instead of failing the deploy', () => {
    const { variables, view } = buildNativeAppVariables(
      [
        plain('good', '1'),
        plain('not-a-name', '1'),
        plain('NUL', 'a\0b'),
        plain('HUGE', 'x'.repeat(70_000)),
        secret('LONGKEY', 'K'.repeat(300)),
      ],
      app
    )
    assertEquals(variables, [{ name: 'good', value: '1' }])
    assertEquals(
      view.filter((entry) => !entry.delivered).map((e) => [e.name, e.reason]),
      [
        ['HUGE', 'invalid_value'],
        ['LONGKEY', 'invalid_value'],
        ['NUL', 'invalid_value'],
        ['not-a-name', 'invalid_name'],
      ]
    )
  })

  it("caps the list at the daemon's limit and says which were left out", () => {
    const many = Array.from({ length: NATIVE_APP_MAX_VARIABLES + 2 }, (_, i) =>
      plain(`V${String(i).padStart(4, '0')}`, '1')
    )
    const { variables, view } = buildNativeAppVariables(many, app)
    assertEquals(variables.length, NATIVE_APP_MAX_VARIABLES)
    assertEquals(view.filter((entry) => entry.reason === 'too_many').length, 2)
  })

  it('labels a value whose scope is unknown rather than guessing', () => {
    const { view } = buildNativeAppVariables(
      [{ name: 'A', key: 'A', isSecret: false, value: '1' }],
      app
    )
    assertEquals(view.find((entry) => entry.name === 'A')?.source, 'unknown')
  })

  it('lists a secret nothing passes to the app, without its value and off the wire', () => {
    const { variables, view } = buildNativeAppVariables([plain('OK', '1')], app, [
      { key: 'STRIPE_KEY', source: 'organization' },
      { key: 'OK' },
    ])
    assertEquals(variables, [{ name: 'OK', value: '1' }])
    assertEquals(
      view.filter((entry) => entry.reason === 'not_referenced'),
      [
        {
          name: 'STRIPE_KEY',
          source: 'organization',
          isSecret: true,
          value: null,
          delivered: false,
          reason: 'not_referenced',
        },
      ]
    )
  })
})
