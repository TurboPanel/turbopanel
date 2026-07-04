import { join } from '@std/path'
import { isDeveloperSurfaceEnabled } from './dev-mode.ts'

const MANAGED_NODE = '/opt/turbopanel/lib/runtime/node/current/bin/node'

async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path)
    return true
  } catch {
    return false
  }
}

async function nodeFromPath(): Promise<string | undefined> {
  const pathEnv = Deno.env.get('PATH')
  if (!pathEnv) return undefined
  for (const dir of pathEnv.split(':')) {
    if (!dir) continue
    const candidate = join(dir, 'node')
    if (await pathExists(candidate)) return candidate
  }
  return undefined
}

/**
 * Resolve the Node binary for drizzle-kit subprocesses.
 *
 * `TURBOPANEL_NODE` is the explicit override. Otherwise the vendored managed
 * runtime is the default so managed installs are deterministic and never depend
 * on whatever host Node happens to be on PATH. PATH-based discovery remains only
 * as a checkout-dev fallback, gated on the same dev/prod signal as the developer
 * surface (`TURBOPANEL_UI_MODE`).
 */
export async function resolveNodePath(): Promise<string> {
  const fromEnv = Deno.env.get('TURBOPANEL_NODE')?.trim()
  if (fromEnv) return fromEnv

  if (await pathExists(MANAGED_NODE)) return MANAGED_NODE

  if (isDeveloperSurfaceEnabled()) {
    const fromPath = await nodeFromPath()
    if (fromPath) return fromPath
  }

  throw new Error(
    'Node.js not found — install Node.js >= 24 and ensure `node` is on PATH, or set TURBOPANEL_NODE',
  )
}
