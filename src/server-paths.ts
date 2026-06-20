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
 * Override with `TURBOPANEL_SOCKET`, or set `TURBOPANEL_SOCKET_DIR` to change
 * the directory while keeping the default filename.
 */
export function resolveInstanceSocket(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): string {
  const override = env.TURBOPANEL_SOCKET?.trim()
  if (override) return override

  const dir = env.TURBOPANEL_SOCKET_DIR?.trim() || DEFAULT_SOCKET_DIR
  return `${dir.replace(/\/$/, '')}/${INSTANCE_SOCKET}`
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
