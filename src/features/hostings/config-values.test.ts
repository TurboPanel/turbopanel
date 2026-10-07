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

test('hostingOptionsInputError refuses the PHP ini override names as site variables, in any case', () => {
  for (const name of ['PHP_VALUE', 'PHP_ADMIN_VALUE', 'php_value', 'Php_Admin_Value']) {
    const problem = hostingOptionsInputError({ web: { env: { [name]: 'memory_limit=-1' } } })
    assertEquals(problem?.field, `options.web.env.${name}`, name)
    assertEquals(problem?.message.includes('reserved'), true, name)
    assertEquals(JSON.stringify(problem).includes('memory_limit'), false, name)
  }
  assertEquals(
    hostingOptionsInputError({ web: { env: { PHP_VALUES: 'x', MY_PHP_VALUE: 'x' } } }),
    null
  )
})

test('hostingOptionsInputError checks the www mode', () => {
  assertEquals(hostingOptionsInputError({}), null)
  assertEquals(hostingOptionsInputError({ www: 'off', protocol: 'tcp' }), null)
  for (const www of ['both', 'www-to-root', 'root-to-www']) {
    assertEquals(hostingOptionsInputError({ www, hostnames: ['example.com'] }), null, www)
    assertEquals(hostingOptionsInputError({ www, hostnames: ['www.example.com'] }), null, www)
    assertEquals(hostingOptionsInputError({ www, protocol: 'tcp' }), {
      field: 'options.www',
      message: 'applies to http hostings only',
    })
  }
  for (const www of ['yes', true, 'WWW-TO-ROOT', 1]) {
    assertEquals(hostingOptionsInputError({ www }), {
      field: 'options.www',
      message: 'must be off, both, www-to-root, or root-to-www',
    })
  }
  const long = `${'a.'.repeat(124)}com`
  assertEquals(hostingOptionsInputError({ www: 'both', hostnames: ['example.com', long] }), {
    field: 'options.www',
    message: `${long} has no www or bare spelling, so set www to off for it`,
  })
  assertEquals(hostingOptionsInputError({ www: 'off', hostnames: [long] }), null)
  assertEquals(hostingOptionsInputError({ hostnames: ['203.0.113.5'], www: 'both' }), {
    field: 'options.www',
    message: '203.0.113.5 has no www or bare spelling, so set www to off for it',
  })
})

test('hostingOptionsInputError puts an old wwwRedirect key through the same www checks', () => {
  assertEquals(hostingOptionsInputError({ wwwRedirect: 'yes' }), {
    field: 'options.wwwRedirect',
    message: 'must be true or false',
  })
  assertEquals(hostingOptionsInputError({ wwwRedirect: true, protocol: 'tcp' }), {
    field: 'options.wwwRedirect',
    message: 'applies to http hostings only',
  })
  const long = `${'a.'.repeat(124)}com`
  assertEquals(hostingOptionsInputError({ wwwRedirect: true, hostnames: [long] }), {
    field: 'options.wwwRedirect',
    message: `${long} has no www or bare spelling, so set www to off for it`,
  })
  assertEquals(hostingOptionsInputError({ wwwRedirect: true, hostnames: ['203.0.113.5'] }), {
    field: 'options.wwwRedirect',
    message: '203.0.113.5 has no www or bare spelling, so set www to off for it',
  })
  // A wildcard is refused as a hostname before the www check runs.
  assertEquals(
    hostingOptionsInputError({ wwwRedirect: true, hostnames: ['*.example.com'] })?.field,
    'options.hostnames'
  )
  assertEquals(hostingOptionsInputError({ wwwRedirect: true, hostnames: ['example.com'] }), null)
  assertEquals(hostingOptionsInputError({ wwwRedirect: false, protocol: 'tcp' }), null)
  // An explicit www wins over the old key, even a malformed one.
  assertEquals(hostingOptionsInputError({ www: 'off', wwwRedirect: 'yes' }), null)
  assertEquals(
    hostingOptionsInputError({ www: 'both', wwwRedirect: 'yes', protocol: 'tcp' })?.field,
    'options.www'
  )
})
