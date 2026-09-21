import { assertEquals } from '@std/assert'
import {
  renderPhpForDeploy,
  validatePhpPoolSetting,
  validatePhpSetting,
} from './php-settings.ts'

const test = Deno.test.bind(Deno)

test('validatePhpSetting drops injection attempts rather than escaping them', () => {
  // The security property. Both render targets (`php_admin_value[k] = v` in a
  // pool, `php_admin_value k v` in an OLS vhost) are line-oriented and
  // unquoted, so a value that could introduce a line is refused outright.
  for (
    const evil of [
      '256M; rm -rf /',
      '256M\nevil = 1',
      '256M\r\nevil = 1',
      '$(whoami)',
      '256M "quoted"',
    ]
  ) {
    assertEquals(validatePhpSetting('memory_limit', evil), undefined)
  }
})

test('validatePhpSetting enforces a byte ceiling', () => {
  assertEquals(validatePhpSetting('memory_limit', '512M'), '512M')
  assertEquals(validatePhpSetting('memory_limit', '2G'), '2G')
  // One tenant must not be able to claim the whole box.
  assertEquals(validatePhpSetting('memory_limit', '64G'), undefined)
  assertEquals(validatePhpSetting('memory_limit', '99999M'), undefined)
})

test('validatePhpSetting normalizes booleans and bounds integers', () => {
  assertEquals(validatePhpSetting('display_errors', 'off'), 'Off')
  assertEquals(validatePhpSetting('display_errors', '1'), 'On')
  assertEquals(validatePhpSetting('display_errors', 'maybe'), undefined)
  assertEquals(validatePhpSetting('max_execution_time', 30), '30')
  assertEquals(validatePhpSetting('max_execution_time', 0), undefined)
  assertEquals(validatePhpSetting('max_execution_time', 6000), undefined)
})

test('validatePhpSetting takes named error levels, never an expression', () => {
  assertEquals(
    validatePhpSetting('error_reporting', 'production'),
    'E_ALL & ~E_DEPRECATED & ~E_STRICT',
  )
  // Accepting an arbitrary constant expression means parsing a tiny language.
  assertEquals(validatePhpSetting('error_reporting', 'E_ALL & ~E_NOTICE'), undefined)
})

test('validatePhpSetting checks timezones against the runtime, not a regex', () => {
  assertEquals(validatePhpSetting('date.timezone', 'UTC'), 'UTC')
  assertEquals(validatePhpSetting('date.timezone', 'America/New_York'), 'America/New_York')
  // Aliases matter: Intl.supportedValuesOf omits UTC/Etc/UTC/GMT entirely, so
  // a canonical-list check would reject the value operators most often type.
  assertEquals(validatePhpSetting('date.timezone', 'Etc/UTC'), 'Etc/UTC')
  // Regex-shaped but not a real zone.
  assertEquals(validatePhpSetting('date.timezone', 'Foo/Bar'), undefined)
  assertEquals(validatePhpSetting('date.timezone', 'UTC; evil'), undefined)
})

test('validatePhpSetting refuses platform-owned directives', () => {
  // open_basedir is computed from the release layout; an operator value would
  // undo release confinement. error_log must stay where the log pipeline reads.
  assertEquals(validatePhpSetting('open_basedir', '/'), undefined)
  assertEquals(validatePhpSetting('error_log', '/tmp/x'), undefined)
  assertEquals(validatePhpSetting('extension', 'evil.so'), undefined)
  assertEquals(validatePhpSetting('auto_prepend_file', '/tmp/x.php'), undefined)
})

test('validatePhpPoolSetting caps workers and rejects platform-owned fields', () => {
  assertEquals(validatePhpPoolSetting('pm', 'static'), 'static')
  assertEquals(validatePhpPoolSetting('pm', 'chaos'), undefined)
  assertEquals(validatePhpPoolSetting('pm.max_children', '8'), '8')
  // Unbounded workers is a host DoS.
  assertEquals(validatePhpPoolSetting('pm.max_children', '100000'), undefined)
  for (const key of ['user', 'group', 'listen', 'chdir', 'clear_env']) {
    assertEquals(validatePhpPoolSetting(key, 'root'), undefined)
  }
})

test('validatePhpSetting handles name lists, tokens, and byte suffixes', () => {
  assertEquals(
    validatePhpSetting('disable_functions', 'exec, shell_exec'),
    'exec,shell_exec',
  )
  assertEquals(validatePhpSetting('disable_functions', 'bad-name'), undefined)
  assertEquals(validatePhpSetting('session.name', 'PHPSESSID'), 'PHPSESSID')
  assertEquals(validatePhpSetting('session.name', 'bad name'), undefined)
  assertEquals(validatePhpSetting('session.cookie_samesite', 'Strict'), 'Strict')
  assertEquals(validatePhpSetting('session.cookie_samesite', 'Laxish'), undefined)
  assertEquals(validatePhpSetting('upload_max_filesize', '512K'), '512K')
  assertEquals(validatePhpSetting('max_input_time', '-1'), '-1')
  assertEquals(validatePhpSetting('memory_limit', 256), '256')
  assertEquals(validatePhpSetting('memory_limit', 'a'.repeat(513)), undefined)
})

test('validatePhpPoolSetting accepts idle timeout tokens and rejects non-strings', () => {
  assertEquals(validatePhpPoolSetting('pm.process_idle_timeout', '10s'), '10s')
  assertEquals(validatePhpPoolSetting('pm.process_idle_timeout', '10'), undefined)
  assertEquals(validatePhpPoolSetting('pm.max_children', true), undefined)
  assertEquals(validatePhpPoolSetting('pm.max_children', 8), '8')
  assertEquals(validatePhpPoolSetting('pm', 'dynamic'), 'dynamic')
})

test('renderPhpForDeploy drops what fails and keeps what passes', () => {
  assertEquals(
    renderPhpForDeploy(
      {
        version: '8.4',
        extensions: ['intl', 'xdebug', 'INTL'],
        settings: { memory_limit: '256M', open_basedir: '/', bogus: 'x' },
        pool: { 'pm.max_children': '8', user: 'root' },
      },
      ['intl', 'redis'],
    ),
    {
      version: '8.4',
      settings: { memory_limit: '256M' },
      pool: { 'pm.max_children': '8' },
      // xdebug is not on the allowlist; the duplicate is folded.
      extensions: ['intl'],
    },
  )
  assertEquals(renderPhpForDeploy(undefined, []), undefined)
  assertEquals(renderPhpForDeploy({ settings: {} }, []), undefined)
})
