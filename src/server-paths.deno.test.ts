import { assertEquals } from '@std/assert'
import { join } from '@std/path'
import {
  DEFAULT_CONFIG_DIR,
  DEFAULT_EXECUTION_LOG_DIR,
  DEFAULT_LOG_DIR,
  DEFAULT_RUN_DIR,
  DEFAULT_SOCKET_DIR,
  DEFAULT_STATE_DIR,
  DEFAULT_TLS_CA,
  DEFAULT_TLS_CA_BUNDLE,
  DEFAULT_TLS_CA_KEY,
  DEFAULT_TLS_CERT,
  DEFAULT_UI_ROOT,
  INSTANCE_SOCKET_MODE,
  caddyUnixDialPath,
  hardenInstanceSocket,
  prepareInstanceSocket,
  resolveInstanceConfigDir,
  resolveInstanceRuntimeConfigPaths,
  resolveInstanceSocket,
  resolveInstanceTlsCaBundlePath,
  resolveInstanceTlsCaKeyPath,
  resolveInstanceTlsCaPath,
  resolveInstanceTlsCertPath,
  resolveExecutionLogDir,
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
  // Command transcripts live under the **state** tree (durable product data),
  // not the log tree (rotatable process logs).
  assertEquals(resolveExecutionLogDir({}), '/var/lib/turbopanel/execution-logs')
})

test('execution log dir follows the state dir and its own override', () => {
  assertEquals(
    resolveExecutionLogDir({ TURBOPANEL_STATE_DIR: '/srv/tp-state' }),
    '/srv/tp-state/execution-logs',
  )
  assertEquals(
    resolveExecutionLogDir({ TURBOPANEL_EXECUTION_LOG_DIR: '/mnt/transcripts//' }),
    '/mnt/transcripts',
  )
  // The dedicated override wins over the state-dir-derived default.
  assertEquals(
    resolveExecutionLogDir({
      TURBOPANEL_STATE_DIR: '/srv/tp-state',
      TURBOPANEL_EXECUTION_LOG_DIR: '/mnt/transcripts',
    }),
    '/mnt/transcripts',
  )
})

test('exported default constants match the canonical FHS paths', () => {
  assertEquals(DEFAULT_CONFIG_DIR, '/etc/turbopanel')
  assertEquals(DEFAULT_STATE_DIR, '/var/lib/turbopanel')
  assertEquals(DEFAULT_LOG_DIR, '/var/log/turbopanel')
  assertEquals(DEFAULT_EXECUTION_LOG_DIR, '/var/lib/turbopanel/execution-logs')
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

test('TLS cert/CA paths honor overrides and fall back to defaults', () => {
  assertEquals(resolveInstanceTlsCertPath({}), DEFAULT_TLS_CERT)
  assertEquals(resolveInstanceTlsCaPath({}), DEFAULT_TLS_CA)
  assertEquals(resolveInstanceTlsCaBundlePath({}), DEFAULT_TLS_CA_BUNDLE)
  assertEquals(resolveInstanceTlsCaKeyPath({}), DEFAULT_TLS_CA_KEY)
  assertEquals(DEFAULT_TLS_CA, '/var/lib/turbopanel/tls/ca.crt')
  assertEquals(DEFAULT_TLS_CA_BUNDLE, '/var/lib/turbopanel/tls/ca-bundle.pem')
  assertEquals(DEFAULT_TLS_CA_KEY, '/var/lib/turbopanel/tls/ca.key')
  assertEquals(
    resolveInstanceTlsCertPath({ CADDY_TLS_CERT: ' /tmp/leaf.crt ' }),
    '/tmp/leaf.crt',
  )
  assertEquals(
    resolveInstanceTlsCaPath({ TURBOPANEL_TLS_CA: ' /tmp/ca.crt ' }),
    '/tmp/ca.crt',
  )
  assertEquals(
    resolveInstanceTlsCaBundlePath({ TURBOPANEL_TLS_CA_BUNDLE: ' /tmp/ca-bundle.pem ' }),
    '/tmp/ca-bundle.pem',
  )
  assertEquals(
    resolveInstanceTlsCaKeyPath({ TURBOPANEL_TLS_CA_KEY: ' /tmp/ca.key ' }),
    '/tmp/ca.key',
  )
  assertEquals(
    resolveInstanceTlsCaPath({ TURBOPANEL_STATE_DIR: '/var/custom' }),
    '/var/custom/tls/ca.crt',
  )
  assertEquals(
    resolveInstanceTlsCaBundlePath({ TURBOPANEL_STATE_DIR: '/var/custom' }),
    '/var/custom/tls/ca-bundle.pem',
  )
  assertEquals(
    resolveInstanceTlsCaKeyPath({ TURBOPANEL_STATE_DIR: '/var/custom' }),
    '/var/custom/tls/ca.key',
  )
})

test('prepareInstanceSocket removes a stale socket file', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'tp-sock-prep-' })
  const socketPath = join(dir, 'instance.sock')
  await Deno.writeTextFile(socketPath, '')
  try {
    await prepareInstanceSocket(socketPath)
    let removed = false
    try {
      await Deno.stat(socketPath)
    } catch (err) {
      removed = err instanceof Deno.errors.NotFound
    }
    assertEquals(removed, true)
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

test('hardenInstanceSocket sets the instance socket mode', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'tp-sock-hard-' })
  const socketPath = join(dir, 'instance.sock')
  await Deno.writeTextFile(socketPath, '')
  try {
    await hardenInstanceSocket(socketPath)
    const info = await Deno.stat(socketPath)
    assertEquals(info.mode && (info.mode & 0o777), INSTANCE_SOCKET_MODE)
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})
