/** Canonical runtime socket directory ( /var/run symlinks to /run on Linux ). */
export const DEFAULT_SOCKET_DIR = '/run/turbopanel'

/** Unix socket filename for the TurboPanel instance. */
export const INSTANCE_SOCKET = 'turbopanel.sock'

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
 * Example: `/run/turbopanel/turbopanel.sock` -> `run/turbopanel/turbopanel.sock`
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
}
