import { assertEquals } from '@std/assert'
import {
  envNameProblem,
  envValueProblem,
  hasLineBreakOrControl,
  hostingOptionsInputError,
  MAX_URL_PATH_LENGTH,
  urlPathPrefixProblem,
} from './config-values.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

/** Line breaks (ASCII, NEL, Unicode separators), NUL and config syntax. */
const HOSTILE = [
  '\n',
  '\r',
  '\0',
  '\t',
  '\u0085',
  ' ',
  ' ',
  '{',
  '}',
  '`',
  '$',
  ';',
  '"',
  "'",
  '#',
  ' ',
  ',',
]

test('urlPathPrefixProblem accepts clean prefixes and refuses every hostile fragment', () => {
  for (const ok of ['/', '/api', '/api/', '/v1/docs', '/a.b_c~d-e']) {
    assertEquals(urlPathPrefixProblem(ok), null, ok)
  }
  for (const fragment of HOSTILE) {
    assertEquals(urlPathPrefixProblem(`/api${fragment}x`) !== null, true, JSON.stringify(fragment))
  }
  for (const bad of ['', 'api', '//', '/a//b', '/..', '/a/../b', '/.']) {
    assertEquals(urlPathPrefixProblem(bad) !== null, true, bad)
  }
  assertEquals(urlPathPrefixProblem(`/${'a'.repeat(MAX_URL_PATH_LENGTH)}`) !== null, true)
})

test('env name and value checks', () => {
  assertEquals(envNameProblem('APP_ENV'), null)
  for (const bad of ['1A', 'A-B', 'A B', 'A\nB', 'A'.repeat(129)]) {
    assertEquals(envNameProblem(bad) !== null, true, bad)
  }
  assertEquals(envValueProblem('quotes " \\ {x} $y ; #'), null)
  for (const ch of ['\n', '\r', '\0', '\u0085', ' ', ' ']) {
    assertEquals(envValueProblem(`a${ch}b`) !== null, true, JSON.stringify(ch))
  }
  assertEquals(hasLineBreakOrControl('plain é ✓'), false)
})

test('hostingOptionsInputError names the first refused field, never the value', () => {
  assertEquals(hostingOptionsInputError(null), null)
  assertEquals(
    hostingOptionsInputError({
      hostnames: ['app.example.test'],
      pathPrefix: ' /api ',
      proxy: { stripPrefix: '/api' },
      web: { env: { A: 'multi word', EMPTY: '' } },
    }),
    null
  )
  assertEquals(
    hostingOptionsInputError({ proxy: { stripPrefix: '/api\nimport x' } })?.field,
    'options.proxy.stripPrefix'
  )
  const secret = hostingOptionsInputError({ web: { env: { TOKEN: 'secret\nvalue' } } })
  assertEquals(secret?.field, 'options.web.env.TOKEN')
  assertEquals(JSON.stringify(secret).includes('secret\\n'), false)
})
