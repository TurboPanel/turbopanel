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
// env-overridable so co-located dev (which injects checkout-relative paths via
// Ansible / the documented manual commands) keeps its historical behavior.
// These tests pin both the production defaults and the dev overrides.

// Simulated co-located dev environment (checkout-relative paths, matching what
// the daemon's instance-launch role injects on a dev host).
const DEV_ENV = {
  TURBOPANEL_CONFIG_DIR: '/opt/turbopanel/platform/config',
  TURBOPANEL_STATE_DIR: '/opt/turbopanel/platform/instance/.local/state',
  TURBOPANEL_LOG_DIR: '/opt/turbopanel/platform/instance/logs',
  TURBOPANEL_RUN_DIR: '/run/turbopanel',
  TURBOPANEL_UI_ROOT: '/opt/turbopanel/platform/ui/dist',
} as const

Deno.test('production defaults resolve the FHS tree with an empty env', () => {
  assertEquals(resolveInstanceConfigDir({}), '/etc/turbopanel')
  assertEquals(resolveStateDir({}), '/var/lib/turbopanel')
  assertEquals(resolveLogDir({}), '/var/log/turbopanel')
  assertEquals(resolveRunDir({}), '/run/turbopanel')
  assertEquals(resolveUiRoot({}), '/opt/turbopanel/share/ui')
  assertEquals(resolveInstanceSocket({}), '/run/turbopanel/instance.sock')
})

Deno.test('exported default constants match the canonical FHS paths', () => {
  assertEquals(DEFAULT_CONFIG_DIR, '/etc/turbopanel')
  assertEquals(DEFAULT_STATE_DIR, '/var/lib/turbopanel')
  assertEquals(DEFAULT_LOG_DIR, '/var/log/turbopanel')
  assertEquals(DEFAULT_RUN_DIR, '/run/turbopanel')
  assertEquals(DEFAULT_SOCKET_DIR, '/run/turbopanel')
  assertEquals(DEFAULT_UI_ROOT, '/opt/turbopanel/share/ui')
})

Deno.test('production runtime config paths compose under /etc/turbopanel', () => {
  const paths = resolveInstanceRuntimeConfigPaths({})
  assertEquals(paths.runtimeEnvPath, '/etc/turbopanel/instance/runtime.env')
  assertEquals(
    paths.runtimeDevVarsPath,
    '/etc/turbopanel/instance/runtime.dev-vars',
  )
})

Deno.test('dev overrides redirect every path to the co-located checkout', () => {
  assertEquals(
    resolveInstanceConfigDir(DEV_ENV),
    '/opt/turbopanel/platform/config',
  )
  assertEquals(
    resolveStateDir(DEV_ENV),
    '/opt/turbopanel/platform/instance/.local/state',
  )
  assertEquals(
    resolveLogDir(DEV_ENV),
    '/opt/turbopanel/platform/instance/logs',
  )
  assertEquals(resolveRunDir(DEV_ENV), '/run/turbopanel')
  assertEquals(resolveUiRoot(DEV_ENV), '/opt/turbopanel/platform/ui/dist')
})

Deno.test('dev overrides move runtime config env files under the dev config dir', () => {
  const paths = resolveInstanceRuntimeConfigPaths(DEV_ENV)
  assertEquals(
    paths.runtimeEnvPath,
    '/opt/turbopanel/platform/config/instance/runtime.env',
  )
  assertEquals(
    paths.runtimeDevVarsPath,
    '/opt/turbopanel/platform/config/instance/runtime.dev-vars',
  )
})

Deno.test('trailing slashes are stripped from overrides', () => {
  assertEquals(resolveInstanceConfigDir({ TURBOPANEL_CONFIG_DIR: '/etc/tp/' }), '/etc/tp')
  assertEquals(resolveStateDir({ TURBOPANEL_STATE_DIR: '/var/tp///' }), '/var/tp')
  assertEquals(resolveUiRoot({ TURBOPANEL_UI_ROOT: '/srv/ui/' }), '/srv/ui')
})

Deno.test('socket resolution honors overrides and the socket-dir fallback', () => {
  assertEquals(
    resolveInstanceSocket({ TURBOPANEL_SOCKET: '/tmp/custom.sock' }),
    '/tmp/custom.sock',
  )
  assertEquals(
    resolveInstanceSocket({ TURBOPANEL_SOCKET_DIR: '/tmp/sockets' }),
    '/tmp/sockets/instance.sock',
  )
})

Deno.test('socket resolution follows the run-dir override', () => {
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

Deno.test('run dir falls back to the socket dir before the FHS default', () => {
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

Deno.test('caddyUnixDialPath strips the leading slash for unix// dialing', () => {
  assertEquals(
    caddyUnixDialPath('/run/turbopanel/instance.sock'),
    'run/turbopanel/instance.sock',
  )
})
