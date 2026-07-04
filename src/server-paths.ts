import { compatLogWarn } from './log-compat.ts'

/** Canonical runtime socket directory ( /var/run symlinks to /run on Linux ). */
export const DEFAULT_SOCKET_DIR = '/run/turbopanel'

/** Unix socket filename for the TurboPanel instance. */
export const INSTANCE_SOCKET = 'instance.sock'

/**
 * Default server leaf cert path (Caddy TLS).
 * Signed by the platform CA in `certs/ca.crt`.
 */
export const DEFAULT_TLS_CERT = './certs/self-signed.crt'

/** Platform CA PEM — trust anchor for daemons, browsers, and future issued certs. */
export const DEFAULT_TLS_CA = './certs/ca.crt'

/**
 * Resolve the instance TLS certificate PEM path.
 *
 * Matches Caddy's `CADDY_TLS_CERT` default in the Caddyfile.
 */
export function resolveInstanceTlsCertPath(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): string {
  return env.CADDY_TLS_CERT?.trim() || DEFAULT_TLS_CERT
}

/** PEM path of the local CA to distribute to remote daemons. */
export function resolveInstanceTlsCaPath(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): string {
  return env.TURBOPANEL_TLS_CA?.trim() || DEFAULT_TLS_CA
}

/** Instance socket file mode: owner+group read/write only (no world access). */
export const INSTANCE_SOCKET_MODE = 0o660

/**
 * Absolute path to the instance Unix socket.
 *
 * Override the full path with `TURBOPANEL_SOCKET`. Otherwise the directory is
 * resolved through the same runtime-dir path as {@link resolveRunDir}
 * (`TURBOPANEL_RUN_DIR` → `TURBOPANEL_SOCKET_DIR` → `DEFAULT_RUN_DIR`) so the
 * socket stays aligned with every other runtime-dir consumer (and Caddy) when a
 * deployment relocates runtime files with `TURBOPANEL_RUN_DIR`.
 */
export function resolveInstanceSocket(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): string {
  const override = env.TURBOPANEL_SOCKET?.trim()
  if (override) return override

  return `${resolveRunDir(env)}/${INSTANCE_SOCKET}`
}

/**
 * FHS-aware runtime paths.
 *
 * Managed installs place config under `/etc/turbopanel`, mutable state under
 * `/var/lib/turbopanel`, logs under `/var/log/turbopanel`, and runtime files
 * (sockets, pidfiles) under `/run/turbopanel`. Every path is env-overridable so
 * co-located dev (which sets these vars via Ansible or the documented manual
 * commands) keeps its checkout-relative behavior unchanged.
 */

/** Default config directory (`/etc/turbopanel`). */
export const DEFAULT_CONFIG_DIR = '/etc/turbopanel'

/** Default mutable state directory (`/var/lib/turbopanel`). */
export const DEFAULT_STATE_DIR = '/var/lib/turbopanel'

/** Default log directory (`/var/log/turbopanel`). */
export const DEFAULT_LOG_DIR = '/var/log/turbopanel'

/** Default runtime directory — shares the socket directory value. */
export const DEFAULT_RUN_DIR = DEFAULT_SOCKET_DIR

/** Default static UI export root (`/opt/turbopanel/share/ui`). */
export const DEFAULT_UI_ROOT = '/opt/turbopanel/share/ui'

/** Resolve the instance config directory, honoring `TURBOPANEL_CONFIG_DIR`. */
export function resolveInstanceConfigDir(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): string {
  return stripTrailingSlash(env.TURBOPANEL_CONFIG_DIR?.trim() || DEFAULT_CONFIG_DIR)
}

/** Resolve the instance state directory, honoring `TURBOPANEL_STATE_DIR`. */
export function resolveStateDir(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): string {
  return stripTrailingSlash(env.TURBOPANEL_STATE_DIR?.trim() || DEFAULT_STATE_DIR)
}

/** Resolve the instance log directory, honoring `TURBOPANEL_LOG_DIR`. */
export function resolveLogDir(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): string {
  return stripTrailingSlash(env.TURBOPANEL_LOG_DIR?.trim() || DEFAULT_LOG_DIR)
}

/**
 * Resolve the runtime directory.
 *
 * Honors `TURBOPANEL_RUN_DIR`, falling back to `TURBOPANEL_SOCKET_DIR` for
 * compatibility with the socket resolver, then `DEFAULT_RUN_DIR`, so run-dir
 * consumers share one source of truth with `resolveInstanceSocket`.
 */
export function resolveRunDir(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): string {
  const dir = env.TURBOPANEL_RUN_DIR?.trim() ||
    env.TURBOPANEL_SOCKET_DIR?.trim() ||
    DEFAULT_RUN_DIR
  return stripTrailingSlash(dir)
}

/**
 * Resolve the static UI export root, honoring `TURBOPANEL_UI_ROOT`.
 *
 * This is the canonical constant for code/docs; Caddy itself reads the env var
 * directly via the `Caddyfile` default.
 */
export function resolveUiRoot(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): string {
  return stripTrailingSlash(env.TURBOPANEL_UI_ROOT?.trim() || DEFAULT_UI_ROOT)
}

/**
 * Resolve the managed runtime env-file paths under the config directory.
 *
 * Single source of truth for `runtime.env` / `runtime.dev-vars` so scripts do
 * not duplicate the literal `<configDir>/instance/...` paths.
 */
export function resolveInstanceRuntimeConfigPaths(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): { runtimeEnvPath: string; runtimeDevVarsPath: string } {
  const instanceConfigDir = `${resolveInstanceConfigDir(env)}/instance`
  return {
    runtimeEnvPath: `${instanceConfigDir}/runtime.env`,
    runtimeDevVarsPath: `${instanceConfigDir}/runtime.dev-vars`,
  }
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '') || '/'
}

/**
 * Path segment for Caddy's `unix//` dial syntax (no leading slash).
 *
 * Example: `/run/turbopanel/instance.sock` -> `run/turbopanel/instance.sock`
 */
export function caddyUnixDialPath(absolutePath: string): string {
  return absolutePath.replace(/^\/+/, '')
}

/**
 * Ensure the socket path is free before bind.
 *
 * Unix socket files can outlive the process that created them (crash, SIGKILL,
 * or a slow `--watch` restart). Connecting succeeds only when another instance
 * is actually listening; otherwise remove the stale file.
 */
export async function prepareInstanceSocket(socketPath: string): Promise<void> {
  try {
    const conn = await Deno.connect({ transport: 'unix', path: socketPath })
    conn.close()
    throw new Error(
      `Instance socket already in use: ${socketPath}. Stop the other TurboPanel process first.`,
    )
  } catch (err) {
    if (err instanceof Error && err.message.includes('already in use')) {
      throw err
    }

    try {
      await Deno.remove(socketPath)
    } catch (removeErr) {
      if (!(removeErr instanceof Deno.errors.NotFound)) {
        throw removeErr
      }
    }
  }
}

/** Restrict the bound socket to owner+group read/write (0660). */
export async function hardenInstanceSocket(
  socketPath: string,
  mode: number = INSTANCE_SOCKET_MODE,
): Promise<void> {
  await Deno.chmod(socketPath, mode)

  const devUser = Deno.env.get('TURBOPANEL_DEV_USER')?.trim()
  if (!devUser) return

  const setfacl = await new Deno.Command('setfacl', {
    args: ['-m', `u:${devUser}:rw`, socketPath],
    stdout: 'null',
    stderr: 'null',
  }).output()
  if (!setfacl.success) {
    compatLogWarn(
      'instance',
      `Could not grant ${devUser} access to ${socketPath} via setfacl`,
    )
  }
}
