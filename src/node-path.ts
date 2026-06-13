import { join } from '@std/path'

const MANAGED_NODE = '/opt/turbopanel/runtimes/node/current/bin/node'

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

/** Resolve the Node binary for drizzle-kit subprocesses (dev PATH; managed hosts: vendored runtime). */
export async function resolveNodePath(): Promise<string> {
  const fromEnv = Deno.env.get('TURBOPANEL_NODE')?.trim()
  if (fromEnv) return fromEnv

  const fromPath = await nodeFromPath()
  if (fromPath) return fromPath

  if (await pathExists(MANAGED_NODE)) return MANAGED_NODE

  throw new Error(
    'Node.js not found — install Node.js >= 24 and ensure `node` is on PATH, or set TURBOPANEL_NODE',
  )
}
