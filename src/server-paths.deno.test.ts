import { assertEquals } from '@std/assert'
import {
  DEFAULT_CONFIG_DIR,
  DEFAULT_LOG_DIR,
  DEFAULT_RUN_DIR,
  DEFAULT_SOCKET_DIR,
  DEFAULT_STATE_DIR,
  DEFAULT_UI_ROOT,
  caddyUnixDialPath,
  resolveInstanceConfigDir,
  resolveInstanceRuntimeConfigPaths,
  resolveInstanceSocket,
  resolveLogDir,
  resolveRunDir,
  resolveStateDir,
  resolveUiRoot,
} from './server-paths.ts'

// The instance path module ships FHS production defaults and stays fully
// env-overridable. Co-located dev injects the same FHS tree via instance-launch
// (config under /etc/turbopanel, state/logs under /var/lib|log/turbopanel, UI
// root at /opt/turbopanel/share/ui) while source checkouts live in $HOME.

// Simulated co-located dev environment — matches what instance-launch injects.
const DEV_ENV = {
  TURBOPANEL_CONFIG_DIR: '/etc/turbopanel',
  TURBOPANEL_DAEMON_STATE_DIR: '/var/lib/turbopanel',
} as const

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('production defaults resolve the FHS tree with an empty env', () => {
  assertEquals(resolveInstanceConfigDir({}), '/etc/turbopanel')
  assertEquals(resolveStateDir({}), '/var/lib/turbopanel')
  assertEquals(resolveLogDir({}), '/var/log/turbopanel')
  assertEquals(resolveRunDir({}), '/run/turbopanel')
  assertEquals(resolveUiRoot({}), '/opt/turbopanel/share/ui')
  assertEquals(resolveInstanceSocket({}), '/run/turbopanel/instance.sock')
})

test('exported default constants match the canonical FHS paths', () => {
  assertEquals(DEFAULT_CONFIG_DIR, '/etc/turbopanel')
  assertEquals(DEFAULT_STATE_DIR, '/var/lib/turbopanel')
  assertEquals(DEFAULT_LOG_DIR, '/var/log/turbopanel')
  assertEquals(DEFAULT_RUN_DIR, '/run/turbopanel')
  assertEquals(DEFAULT_SOCKET_DIR, '/run/turbopanel')
  assertEquals(DEFAULT_UI_ROOT, '/opt/turbopanel/share/ui')
})

test('production runtime config paths compose under /etc/turbopanel', () => {
  const paths = resolveInstanceRuntimeConfigPaths({})
  assertEquals(paths.runtimeEnvPath, '/etc/turbopanel/instance/runtime.env')
  assertEquals(
    paths.runtimeDevVarsPath,
    '/etc/turbopanel/instance/runtime.dev-vars',
  )
})

test('co-located dev resolves the same FHS tree from injected config', () => {
  assertEquals(resolveInstanceConfigDir(DEV_ENV), '/etc/turbopanel')
  assertEquals(resolveStateDir(DEV_ENV), '/var/lib/turbopanel')
  assertEquals(resolveLogDir(DEV_ENV), '/var/log/turbopanel')
  assertEquals(resolveRunDir(DEV_ENV), '/run/turbopanel')
  assertEquals(resolveUiRoot(DEV_ENV), '/opt/turbopanel/share/ui')
})

test('co-located dev runtime config lives under /etc/turbopanel', () => {
  const paths = resolveInstanceRuntimeConfigPaths(DEV_ENV)
  assertEquals(paths.runtimeEnvPath, '/etc/turbopanel/instance/runtime.env')
  assertEquals(
    paths.runtimeDevVarsPath,
    '/etc/turbopanel/instance/runtime.dev-vars',
  )
})

test('trailing slashes are stripped from overrides', () => {
  assertEquals(resolveInstanceConfigDir({ TURBOPANEL_CONFIG_DIR: '/etc/tp/' }), '/etc/tp')
  assertEquals(resolveStateDir({ TURBOPANEL_STATE_DIR: '/var/tp///' }), '/var/tp')
  assertEquals(resolveUiRoot({ TURBOPANEL_UI_ROOT: '/srv/ui/' }), '/srv/ui')
})

test('socket resolution honors overrides and the socket-dir fallback', () => {
  assertEquals(
    resolveInstanceSocket({ TURBOPANEL_SOCKET: '/tmp/custom.sock' }),
    '/tmp/custom.sock',
  )
  assertEquals(
    resolveInstanceSocket({ TURBOPANEL_SOCKET_DIR: '/tmp/sockets' }),
    '/tmp/sockets/instance.sock',
  )
})

test('socket resolution follows the run-dir override', () => {
  // TURBOPANEL_RUN_DIR relocates the socket alongside every other run-dir
  // consumer, keeping the instance and Caddy dial path aligned.
  assertEquals(
    resolveInstanceSocket({ TURBOPANEL_RUN_DIR: '/run/custom' }),
    '/run/custom/instance.sock',
  )
  // Matches resolveRunDir precedence: TURBOPANEL_RUN_DIR wins over the socket dir.
  assertEquals(
    resolveInstanceSocket({
      TURBOPANEL_RUN_DIR: '/run/custom',
      TURBOPANEL_SOCKET_DIR: '/tmp/sockets',
    }),
    '/run/custom/instance.sock',
  )
  // An explicit full-path override still wins over the run dir.
  assertEquals(
    resolveInstanceSocket({
      TURBOPANEL_SOCKET: '/tmp/custom.sock',
      TURBOPANEL_RUN_DIR: '/run/custom',
    }),
    '/tmp/custom.sock',
  )
})

test('run dir falls back to the socket dir before the FHS default', () => {
  assertEquals(
    resolveRunDir({ TURBOPANEL_SOCKET_DIR: '/tmp/sockets' }),
    '/tmp/sockets',
  )
  assertEquals(
    resolveRunDir({
      TURBOPANEL_RUN_DIR: '/run/custom',
      TURBOPANEL_SOCKET_DIR: '/tmp/sockets',
    }),
    '/run/custom',
  )
})

test('caddyUnixDialPath strips the leading slash for unix// dialing', () => {
  assertEquals(
    caddyUnixDialPath('/run/turbopanel/instance.sock'),
    'run/turbopanel/instance.sock',
  )
})
