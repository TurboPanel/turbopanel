/** Canonical runtime socket directory ( /var/run symlinks to /run on Linux ). */
export const DEFAULT_SOCKET_DIR = '/run/turbopanel'

/** Unix socket filename for the TurboPanel instance. */
export const INSTANCE_SOCKET = 'instance.sock'

/**
 * Default server leaf cert path (Caddy TLS).
 * Signed by the platform CA under the state tree (`tls/ca.crt`), not this file.
 */
export const DEFAULT_TLS_CERT = './certs/self-signed.crt'

/** Default mutable state directory (`/var/lib/turbopanel`). */
export const DEFAULT_STATE_DIR = '/var/lib/turbopanel'

/** Platform CA PEM — current root under the durable state tree. */
export const DEFAULT_TLS_CA = `${DEFAULT_STATE_DIR}/tls/ca.crt`

/** Platform CA bundle (current first, then retired roots for overlap). */
export const DEFAULT_TLS_CA_BUNDLE = `${DEFAULT_STATE_DIR}/tls/ca-bundle.pem`

/** Platform CA private key — durable identity, never in a replaceable checkout. */
export const DEFAULT_TLS_CA_KEY = `${DEFAULT_STATE_DIR}/tls/ca.key`

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

function tlsCaDir(env: Record<string, string | undefined>): string {
  return `${resolveStateDir(env)}/tls`
}

/** PEM path of the current platform CA (single root). */
export function resolveInstanceTlsCaPath(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): string {
  return env.TURBOPANEL_TLS_CA?.trim() || `${tlsCaDir(env)}/ca.crt`
}

/** PEM path of the platform CA bundle (current + retired overlap). */
export function resolveInstanceTlsCaBundlePath(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): string {
  return env.TURBOPANEL_TLS_CA_BUNDLE?.trim() || `${tlsCaDir(env)}/ca-bundle.pem`
}

/** PEM path of the platform CA private key. */
export function resolveInstanceTlsCaKeyPath(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): string {
  return env.TURBOPANEL_TLS_CA_KEY?.trim() || `${tlsCaDir(env)}/ca.key`
}

/**
 * Path to serve at `GET /instance/ca`: the bundle when present, else the
 * single current CA file.
 */
export function resolveInstanceTlsCaServePath(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): string {
  const bundle = resolveInstanceTlsCaBundlePath(env)
  try {
    Deno.statSync(bundle)
    return bundle
  } catch {
    return resolveInstanceTlsCaPath(env)
  }
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

/**
 * Default execution-log (command transcript) root.
 *
 * Under the **state** tree, not the log tree: transcripts are durable product
 * data read back by the UI, not rotatable process logs.
 */
export const DEFAULT_EXECUTION_LOG_DIR = `${DEFAULT_STATE_DIR}/execution-logs`

/**
 * Resolve the execution-log root, honoring `TURBOPANEL_EXECUTION_LOG_DIR`.
 *
 * Falls back to `<stateDir>/execution-logs` so relocating `TURBOPANEL_STATE_DIR`
 * moves transcripts with the rest of the durable state.
 */
export function resolveExecutionLogDir(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): string {
  const override = env.TURBOPANEL_EXECUTION_LOG_DIR?.trim()
  if (override) return stripTrailingSlash(override)
  return `${resolveStateDir(env)}/execution-logs`
}

/**
 * Default metrics state root (DuckDB database, Parquet exports, temp spill).
 *
 * Under the **state** tree: metric history is durable product data, the same
 * class as execution logs.
 */
export const DEFAULT_METRICS_DIR = `${DEFAULT_STATE_DIR}/metrics`

/**
 * Resolve the metrics state root, honoring `TURBOPANEL_METRICS_DIR`.
 *
 * Falls back to `<stateDir>/metrics` so relocating `TURBOPANEL_STATE_DIR`
 * moves metric history with the rest of the durable state.
 */
export function resolveMetricsDir(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): string {
  const override = env.TURBOPANEL_METRICS_DIR?.trim()
  if (override) return stripTrailingSlash(override)
  return `${resolveStateDir(env)}/metrics`
}

/**
 * Default vendored DuckDB shared-library directory (`libduckdb.so`).
 *
 * `deno compile` bundles `@duckdb/node-api`'s `duckdb.node` addon and
 * self-extracts it at runtime, but it does **not** extract the companion
 * `libduckdb.so` that the addon links via `RUNPATH $ORIGIN` — the dynamic
 * linker cannot read the compiled binary's virtual filesystem. Managed
 * installs therefore vendor `libduckdb.so` here and the instance unit puts
 * this directory on `LD_LIBRARY_PATH`. Source mode (`deno run`) needs
 * neither: the addon and its `.so` are real sibling files in Deno's npm
 * cache, so `$ORIGIN` resolution works as-is.
 */
export const DEFAULT_DUCKDB_LIB_DIR = '/opt/turbopanel/vendor/duckdb/lib'

/**
 * Absolute path of the vendored `libduckdb.so` when present, else `null`
 * (meaning the package's own `$ORIGIN` resolution applies — source mode).
 *
 * Honors `TURBOPANEL_DUCKDB_LIB_DIR` for relocated vendor trees.
 */
export function resolveDuckdbNativeLibraryPath(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): string | null {
  const dir = stripTrailingSlash(
    env.TURBOPANEL_DUCKDB_LIB_DIR?.trim() || DEFAULT_DUCKDB_LIB_DIR,
  )
  const candidate = `${dir}/libduckdb.so`
  try {
    Deno.statSync(candidate)
    return candidate
  } catch {
    return null
  }
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
  let end = value.length
  while (end > 0 && (value.codePointAt(end - 1) ?? 0) === 47) {
    end--
  }
  return end === 0 ? '/' : value.slice(0, end)
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

/**
 * Restrict the bound socket to owner+group read/write (0660).
 *
 * Co-located dev runs the instance stack as the dev user; managed installs use
 * the instance user (`tpctrl`) or Caddy (`tpcaddy`), both members of group `tp`.
 * `/run/turbopanel` is 2770 with setgid so both sides can bind and connect.
 */
export async function hardenInstanceSocket(
  socketPath: string,
  mode: number = INSTANCE_SOCKET_MODE,
): Promise<void> {
  await Deno.chmod(socketPath, mode)
}
